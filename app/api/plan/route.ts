// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/** ---------------- Types ---------------- */
type LatLng = { lat: number; lng: number };

type PlaceType =
  | 'tourist_attraction'
  | 'park'
  | 'museum'
  | 'amusement_park'
  | 'zoo'
  | 'aquarium'
  | 'place_of_worship'
  | 'restaurant'
  | 'lodging';

type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  user_ratings_total?: number;
  place_id?: string;
  _type: PlaceType;
  city?: string;      // ex. 台北市 / 桃園市 / 新北市...
  district?: string;  // ex. 信義區 / 大安區...
  progress?: number;  // 在整體路線上的「前進進度」(0..1)
};

type DaySlot = {
  morning: PlaceOut[];   // 至少 2 個景點
  lunch?: PlaceOut;      // 餐廳 1
  afternoon: PlaceOut[]; // 至少 2 個景點
  lodging?: PlaceOut;    // 住宿 1
};

type DirectionsInfo = {
  polyPts: LatLng[];
  start: { lat: number; lng: number; address: string };
  end: { lat: number; lng: number; address: string };
  distanceText: string;
  durationText: string;
};

const LANG = 'zh-TW';
const COUNTRY_REGION = 'tw';
const NEAR_EQ_KM = 3;

/** 擴充的景點類型（古蹟、寺廟、步道、博物館、花園、遊樂園等） */
const ATTRACTION_TYPES: PlaceType[] = [
  'tourist_attraction', // 綜合：古蹟/打卡/自然/步道 多數會落在這
  'park',               // 公園、花園、綠地
  'museum',             // 博物館
  'amusement_park',     // 遊樂園（六福村、劍湖山、麗寶、義大）
  'zoo',                // 動物園
  'aquarium',           // 水族館
  'place_of_worship',   // 寺/宮/廟（多半也會是 tourist_attraction，但這裡保險）
];

/** 餐廳與住宿保留，行程拼裝需要 */
const FOOD_TYPES: PlaceType[] = ['restaurant'];
const HOTEL_TYPES: PlaceType[] = ['lodging'];

/** 提升古蹟/步道/博物館/花園探索覆蓋的中文關鍵字（Nearby 可加 keyword） */
const ATTRACTION_CN_KEYWORDS = [
  '古蹟','遺址','寺','宮','廟','祠','步道','健行','登山',
  '博物館','展館','美術館','園區','花園','花海','森林','景觀',
  '遊樂園','樂園','親子','水族館','動物園'
];

/** ---------------- Utils ---------------- */
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  return acc;
}

/** 依路線動態採樣點：長程更多採樣、短程也至少取 6-10 個點 */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const minN = 10; // 最少採樣點，提升沿途覆蓋
  const maxN = 40; // 最多採樣點，避免超限
  const n = Math.max(minN, Math.min(maxN, Math.ceil(total / 20) + 10));
  const positions: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let j = 0;
    while (j < cum.length && cum[j] < target) j++;
    if (j === 0) positions.push(path[0]);
    else if (j >= cum.length) positions.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const r = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      positions.push({ lat: A.lat + (B.lat - A.lat) * r, lng: A.lng + (B.lng - A.lng) * r });
    }
  }
  // 去重（小於 3km 的點視為重複）
  const dedup: LatLng[] = [];
  for (const p of positions) if (!dedup.some(q => haversineKm(p, q) < 3)) dedup.push(p);
  return dedup;
}

/** 依全程距離調整半徑（往南擴大搜尋） */
function dynamicRadiusMeters(totalKm: number) {
  // 長程更大半徑，最高 25km
  const base = Math.min(25000, Math.max(5000, Math.round(totalKm * 25)));
  return base;
}

/** 根據 Google Geocoding 結果，抽取 city/district，並將它們穩定地前置於地址 */
function extractCityDistrict(components: any[]): { city?: string; district?: string } {
  // 台灣慣例：county/city 在 level_2（例如「台北市」「桃園市」「新北市」「台中市」等）
  const find = (t: string) => components.find(c => Array.isArray(c.types) && c.types.includes(t))?.long_name as string | undefined;
  // 先抓 level_2 做 city
  let city = find('administrative_area_level_2') || find('locality') || find('postal_town');
  // 區/鎮/里：sublocality_level_1 或 administrative_area_level_3
  let district = find('sublocality_level_1') || find('administrative_area_level_3') || find('neighborhood');

  // 正規化（全形空白去掉）
  const norm = (s?: string) => s?.replace(/\s+/g, '')?.replace(/[·・•‧．\.]/g, '') || undefined;
  city = norm(city);
  district = norm(district);

  // 有些地區會把「新竹市」「竹北市」混用，這裡不嘗試糾錯，只做最基本去重
  return { city, district };
}

/** 乾淨地把「縣市 / 行政區」前置到地址，避免重複顯示 */
function formatAddressWithCity(address?: string, city?: string, district?: string) {
  const parts: string[] = [];
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  if (city) parts.push(city);
  if (district && (!city || !district.startsWith(city))) parts.push(district);

  let rest = address ? clean(address) : '';
  const head = parts.join(' · ');

  // 如果原始 address 已經以「縣市」或「區」開頭，避免重複
  if (rest) {
    const rm = [city, district].filter(Boolean).join('|').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (rm) {
      rest = rest.replace(new RegExp(`^(${rm})(\\s*·\\s*)?`, 'u'), '');
    }
  }

  return head ? (rest ? `${head} · ${rest}` : head) : (rest || '');
}

/** ---------------- Google APIs ---------------- */
async function geocodeGoogle(query: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  const tryUrls = [
    `${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=${COUNTRY_REGION}&key=${key}`,
    `${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`,
  ];
  for (const url of tryUrls) {
    const j = await fetchJson<any>(url);
    if (j.results?.[0]) {
      const g = j.results[0];
      return {
        lat: g.geometry.location.lat,
        lng: g.geometry.location.lng,
        formatted_address: g.formatted_address,
        components: g.address_components || [],
      };
    }
  }
  throw new Error('geocode_failed');
}

async function reverseGeocodeGoogle(lat: number, lng: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  const top = j.results?.[0];
  const components = top?.address_components || [];
  const { city, district } = extractCityDistrict(components);

  // Google 回傳的 formatted_address 常常是完整地址（含縣市區），我們要「穩定前置 & 去重」
  const formatted = formatAddressWithCity(top?.formatted_address, city, district);
  return { city, district, formatted };
}

async function directionsGoogle(origin: string, destination: string): Promise<DirectionsInfo> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=${COUNTRY_REGION}&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status !== 'OK' || !j.routes?.[0]) throw new Error(j.error_message || j.status || 'directions_failed');
  const route = j.routes[0];
  const leg = route.legs[0];
  const pts = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyPts: pts,
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text,
  };
}

function scorePlace(p: any, distKm?: number) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const proximity = typeof distKm === 'number' ? 1 / (1 + distKm / 6) : 1;
  return rating * pop * proximity;
}

async function nearbyRaw(center: LatLng, radiusM: number, params: Record<string, string>) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const usp = new URLSearchParams({
    location: `${center.lat},${center.lng}`,
    radius: `${radiusM}`,
    language: LANG,
    key,
      });
  for (const [k, v] of Object.entries(params)) usp.set(k, v);
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${usp.toString()}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

/** 一般 nearby：可帶 type 或 keyword（兩者合用） */
async function nearby(center: LatLng, type?: PlaceType, radiusM?: number, keyword?: string) {
  const params: Record<string, string> = {};
  if (type) params['type'] = type;
  if (keyword) params['keyword'] = keyword;
  return nearbyRaw(center, radiusM || 3000, params);
}

/** 把 result 轉成 PlaceOut */
function asPlaceOut(result: any, type: PlaceType, progress?: number): PlaceOut | undefined {
  if (!result || !result.geometry?.location) return;
  const loc = result.geometry.location;
  const o: PlaceOut = {
    name: result.name,
    lat: loc.lat,
    lng: loc.lng,
    address: result.vicinity || result.formatted_address,
    rating: result.rating,
    user_ratings_total: result.user_ratings_total,
    place_id: result.place_id,
    _type: type,
    progress,
  };
  return o;
}

/** 回傳「依路線進度排序」且多樣化的 POI 集合（含 attractions/food/hotel） */
async function harvestPOIsAlongPath(path: LatLng[]) {
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length - 1]);
  const radius = dynamicRadiusMeters(totalKm);

  // 建立即時查找映射，將每個 POI 綁上「路線進度」
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const progressOf = (pt: LatLng) => {
    // 以最近頂點近似，取得該點在整體路線上的距離比例（0..1）
    let best = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < path.length; i++) {
      const d = haversineKm(pt, path[i]);
      if (d < best) { best = d; bestIdx = i; }
    }
    const prog = cum[bestIdx] / (total || 1);
    return Math.max(0, Math.min(1, prog));
  };

  const byId = new Map<string, { item: PlaceOut; score: number }>();

  // 1) Attractions（含中文關鍵字增強）
  for (const s of samples) {
    for (const t of ATTRACTION_TYPES) {
      // 純 type
      const arr = await nearby(s, t, radius);
      for (const p of arr) {
        const id = p.place_id as string | undefined; if (!id) continue;
        const sc = scorePlace(p, haversineKm(s, { lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        const item = asPlaceOut(p, t, progressOf({ lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        if (!item) continue;
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
      }
      await sleep(60);
      // 附加中文關鍵字（只挑部分，避免配額暴衝）
      for (const kw of ATTRACTION_CN_KEYWORDS.slice(0, 4)) {
        const arr2 = await nearby(s, t, Math.round(radius * 0.8), kw);
        for (const p of arr2) {
          const id = p.place_id as string | undefined; if (!id) continue;
          const sc = scorePlace(p, haversineKm(s, { lat: p.geometry.location.lat, lng: p.geometry.location.lng })) * 1.05; // 關鍵字加一點權重
          const item = asPlaceOut(p, t, progressOf({ lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
          if (!item) continue;
          const cur = byId.get(id);
          if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
        }
        await sleep(50);
      }
    }
  }

  // 2) Restaurants
  for (const s of samples) {
    for (const t of FOOD_TYPES) {
      const arr = await nearby(s, t, Math.max(3000, Math.round(radius * 0.5)));
      for (const p of arr) {
        const id = p.place_id as string | undefined; if (!id) continue;
        const sc = scorePlace(p, haversineKm(s, { lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        const item = asPlaceOut(p, t, progressOf({ lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        if (!item) continue;
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
      }
      await sleep(50);
    }
  }

  // 3) Hotels
  for (const s of samples) {
    for (const t of HOTEL_TYPES) {
      const arr = await nearby(s, t, Math.max(5000, Math.round(radius * 0.6)));
      for (const p of arr) {
        const id = p.place_id as string | undefined; if (!id) continue;
        const sc = scorePlace(p, haversineKm(s, { lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        const item = asPlaceOut(p, t, progressOf({ lat: p.geometry.location.lat, lng: p.geometry.location.lng }));
        if (!item) continue;
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
      }
      await sleep(50);
    }
  }

  // 依「沿路前進進度」排序，若相同就用分數
  const pois = Array.from(byId.values())
    .sort((a, b) => {
      const pa = a.item.progress ?? 0, pb = b.item.progress ?? 0;
      return pa - pb || b.score - a.score;
    })
    .map(x => x.item);

  // 過濾明顯太靠北（起點附近）且不斷重複的點（去重 by name+區）
  const seen = new Set<string>();
  const clean: PlaceOut[] = [];
  for (const p of pois) {
    const k = `${(p.name || '').trim()}@${(p.address || '').slice(0, 20)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(p);
  }
  return clean;
}

/** 使用「進度切片」分配每日景點，且上午/下午各 >= 2 個 */
function buildAgencyStyleItinerary(pois: PlaceOut[], days: number): DaySlot[] {
  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));

  const attractions = pois.filter(p => ATTRACTION_TYPES.includes(p._type as any));
  const restaurants = pois.filter(p => FOOD_TYPES.includes(p._type as any));
  const hotels = pois.filter(p => HOTEL_TYPES.includes(p._type as any));

  // 依進度分割成 day-buckets
  for (let d = 0; d < days; d++) {
    const start = d / days;
    const end = (d + 1) / days;
    const bucket = attractions.filter(p => {
      const pr = p.progress ?? 0;
      // 邊界允許少量重疊，避免空桶
      return pr >= start - 0.03 && pr < end + 0.03;
    }).slice(0, 30);

    // 上午/下午各挑 2 個（不夠就從附近回填）
    const pick = (from: PlaceOut[], need: number, picked: Set<string>) => {
      const out: PlaceOut[] = [];
      for (const x of from) {
        if (out.length >= need) break;
        const id = x.place_id || `${x.name}@${x.lat.toFixed(3)},${x.lng.toFixed(3)}`;
        if (picked.has(id)) continue;
        out.push(x);
        picked.add(id);
    }
      return out;
  };

    const pickedIds = new Set<string>();
    const m = pick(bucket, 2, pickedIds);
    const a = pick(bucket.filter(x => !m.includes(x)), 2, pickedIds);

    itinerary[d].morning = m;
    itinerary[d].afternoon = a;

    // 中午餐廳：取該日早/午景點幾何中心最近評價高者
    const pts = [...m, ...a];
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
      let bestR: PlaceOut | undefined, bestScore = -1;
      for (const r of restaurants) {
        const sc = (r.rating || 0) / (1 + haversineKm({ lat: cx, lng: cy }, { lat: r.lat, lng: r.lng }) / 6);
        if (sc > bestScore) { bestScore = sc; bestR = r; }
    }
      if (bestR) itinerary[d].lunch = bestR;
  }

    // 晚上住宿：靠近下午最後一點
    const anchor = a[a.length - 1] || m[m.length - 1];
    if (anchor) {
      let bestH: PlaceOut | undefined, best = -1;
      for (const h of hotels) {
        const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 6);
        if (sc > best) { best = sc; bestH = h; }
      }
      if (bestH) itinerary[d].lodging = bestH;
    }
  }

  // 若某天 attractions 太少（例如空桶），跨桶回填，確保上午/下午至少 2 個
  const allAttractionsSorted = attractions.slice().sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));
  const idOf = (p: PlaceOut) => p.place_id || `${p.name}@${p.lat},${p.lng}`;
  for (let d = 0; d < days; d++) {
    const needM = Math.max(0, 2 - itinerary[d].morning.length);
    const needA = Math.max(0, 2 - itinerary[d].afternoon.length);
    if (needM || needA) {
      const picked = new Set([...itinerary[d].morning, ...itinerary[d].afternoon].map(idOf));
      const start = d / days, end = (d + 1) / days;
      // 先從鄰近進度挑
      const near = allAttractionsSorted.filter(p => {
        const pr = p.progress ?? 0;
        return pr >= start - 0.1 && pr <= end + 0.1 && !picked.has(idOf(p));
      });
      while (itinerary[d].morning.length < 2 && near.length) {
        itinerary[d].morning.push(near.shift()!);
      }
      while (itinerary[d].afternoon.length < 2 && near.length) {
        itinerary[d].afternoon.push(near.shift()!);
      }
      // 還不夠就全域回填
      const rest = allAttractionsSorted.filter(p => !picked.has(idOf(p)) && !near.includes(p));
      while (itinerary[d].morning.length < 2 && rest.length) itinerary[d].morning.push(rest.shift()!);
      while (itinerary[d].afternoon.length < 2 && rest.length) itinerary[d].afternoon.push(rest.shift()!);
    }
  }

  return itinerary;
}

/** 只對「選上行程」的點做反向地理，並把 city/district 前置到 address */
async function enrichChosenPOIsWithCity(itinerary: DaySlot[], all: PlaceOut[]) {
  const chosenIds = new Set<string>();
  itinerary.forEach(day => {
    [...day.morning, day.lunch, ...day.afternoon, day.lodging].forEach((p: any) => {
      if (p?.place_id) chosenIds.add(p.place_id);
    });
  });

  const idToPoi = new Map<string, PlaceOut>();
  for (const p of all) if (p.place_id) idToPoi.set(p.place_id, p);

  for (const id of chosenIds) {
    const p = idToPoi.get(id);
    if (!p) continue;
    try {
      const rev = await reverseGeocodeGoogle(p.lat, p.lng);
      p.city = rev.city;
      p.district = rev.district;
      p.address = formatAddressWithCity(p.address, rev.city, rev.district);
      await sleep(40);
    } catch {
      // 反地理失敗就至少把原址清潔一下（不前置）
      if (p.address) p.address = p.address.trim();
    }
  }
}

/** ---------------- OSM/OSRM fallback ---------------- */
async function geocodeOSM(query: string) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1`;
  const r = await fetch(url, { headers: { 'Accept-Language': LANG }, cache: 'no-store' });
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]) throw new Error('geocode_failed');
  return {
    lat: parseFloat(j[0].lat),
    lng: parseFloat(j[0].lon),
    formatted: j[0].display_name,
    address: j[0].address || {},
  };
}

async function routeOSRM(origin: LatLng, dest: LatLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j = await fetchJson<any>(url);
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route = j.routes[0];
  const coords = route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  return {
    polyPts: coords as LatLng[],
    distanceText: (route.distance / 1000).toFixed(1) + ' km',
    durationText: Math.round(route.duration / 60) + ' 分鐘',
  };
}

/** ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json(
        { error: 'bad_request', detail: 'origin/destination required' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      // 1) 路線 & 採樣
      const r = await directionsGoogle(origin, destination);
      const startLL = { lat: r.start.lat, lng: r.start.lng };
      const endLL = { lat: r.end.lat, lng: r.end.lng };
      const isSingle = haversineKm(startLL, endLL) <= NEAR_EQ_KM;

      // 2) 採集 POIs（往南擴大半徑，含關鍵字）
      let pois: PlaceOut[] = [];
      if (isSingle) {
        // 即便同城，也仍從多個採樣點拉出多型別 POI，避免只在起點附近
        const fakePath = [startLL, { lat: startLL.lat - 0.5, lng: startLL.lng + 0.2 }]; // 人工拉出一小段，讓進度/分桶仍生效
        pois = await harvestPOIsAlongPath(fakePath);
      } else {
        pois = await harvestPOIsAlongPath(r.polyPts);
      }

      // 3) 產生每日「旅行社風格」行程（上午/下午各 >=2）
      const itinerary = buildAgencyStyleItinerary(pois, days);

      // 4) 只對入選點做反向地理，並把縣市/行政區穩定前置（強制出現）
      await enrichChosenPOIsWithCity(itinerary, pois);

    return NextResponse.json({
        provider: 'google',
        polyline: r.polyPts.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,       // 扁平池（含 progress）
        itinerary,  // 早/午/晚（已強制補滿縣市＆上午/下午 >=2）
    }, { headers: { 'Cache-Control': 'private, max-age=60' } });

    } else {
      // 無 Google Key：用 OSM/OSRM 最小回傳（不含豐富 POI）
      const o = await geocodeOSM(origin), d = await geocodeOSM(destination);
      const ro = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      return NextResponse.json({
        provider: 'osrm',
        polyline: ro.polyPts.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: o.lat, lng: o.lng, address: o.formatted },
        end: { lat: d.lat, lng: d.lng, address: d.formatted },
        distanceText: ro.distanceText,
        durationText: ro.durationText,
        pois: [],
        itinerary: [],
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch (e: any) {
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
