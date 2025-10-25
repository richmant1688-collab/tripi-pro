// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/* ============================ Types ============================ */

type LatLng = { lat: number; lng: number };
type PlaceType = 'tourist_attraction' | 'restaurant' | 'lodging';
type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  place_id?: string;
  _type: PlaceType;
  city?: string; // 反向地理後補上城市（前置顯示）
  __progress?: number; // 沿著主路線的前進進度(內部用)
};

type DaySlot = {
  morning: PlaceOut[]; // 1–2 景點
  lunch?: PlaceOut;    // 1 餐廳
  afternoon: PlaceOut[]; // 1–2 景點
  lodging?: PlaceOut;    // 1 住宿
};

type PlanOut = {
  provider: 'google' | 'osrm';
  polyline: [number, number][];
  start: { lat: number; lng: number; address: string };
  end: { lat: number; lng: number; address: string };
  distanceText: string;
  durationText: string;
  pois: PlaceOut[];    // 扁平池（保留）
  itinerary: DaySlot[];// 旅行社分配（新）
};

/* ============================ Consts ============================ */

const LANG = 'zh-TW';
const NEAR_EQ_KM = 3;

// 「景點」候選 Google Places types（盡量涵蓋：主題樂園、動物園、水族館、博物館、公園等）
const ATTRACTION_TYPES = [
  'tourist_attraction',
  'amusement_park',
  'zoo',
  'aquarium',
  'museum',
  'park',
] as const;

// 會當作「景點」輸出的 types（餐廳/住宿在後面另外抓）
type AttractionType = typeof ATTRACTION_TYPES[number];

// 大型樂園的關鍵字（中文/常見英譯/品牌）
const SIGNATURE_PARK_KEYWORDS = [
  '六福村', 'Leofoo', 'Leofoo Village',
  '麗寶樂園', 'Lihpao', 'Lihpao Resort', '麗寶', '麗寶探索世界',
  '劍湖山', 'Janfusun', 'Janfusun Fancyworld',
  '義大樂園', 'E-DA', 'E DA', 'E•DA', '義大世界'
];

// 名稱白名單（放行/加分用；加入「樂園/遊樂園/主題樂園/六福村/麗寶/劍湖山/義大」）
const NAME_ALLOW_BOOST =
  /(老街|觀景|觀景台|森林|步道|溫泉|濱海|風景|公園|博物館|展覽|美術館|文化園區|糖廠|老屋|聚落|車站|國家|國立|城|古道|古宅|山|湖|水庫|濕地|沙灘|海岸|漁港|天空步道|燈塔|景觀|祕境|瀑布|露營|遊樂|遊樂園|主題樂園|樂園|六福村|麗寶|劍湖山|義大|E[-\s]?DA|Lihpao|Leofoo|Janfusun)/;

// 名稱黑名單（雜訊/非觀光）
const NAME_BLOCK =
  /(車廠|汽車|機車|修車|加油站|物流|倉庫|工廠|公司|銀行|房仲|不動產|手機行|電信|健身房|保養|醫院|診所|藥局|停車場|加水站|變電所|庇護工場|清潔隊|殯儀|靈骨|宗祠|垃圾|回收|監理|監獄|測試|教室|補習班|考場|宿舍)/;

/* ============================ Utils ============================ */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
  }
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
}

// 依折線頂點累加距離
function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) {
    acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  }
  return acc;
}

// 動態取樣：路程越長，取樣點越多（上限24）
function sampleAlongPath(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  if (total === 0) return [path[0]];
  const step = Math.max(20, Math.min(50, total / 15));
  const n = Math.min(24, Math.max(2, Math.round(total / step) + 1));
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let j = 0; while (j < cum.length && cum[j] < target) j++;
    if (j === 0) out.push(path[0]);
    else if (j >= cum.length) out.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const r = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      out.push({ lat: A.lat + (B.lat - A.lat) * r, lng: A.lng + (B.lng - A.lng) * r });
    }
  }
  // 去重（<5km 視為同點）
  const dedup: LatLng[] = [];
  for (const p of out) { if (!dedup.some(q => haversineKm(p, q) < 5)) dedup.push(p); }
  return dedup;
}

// 搜尋半徑：跟著總里程動態調整（5–15km）
function dynamicRadiusMeters(totalKm: number) {
  return Math.min(15000, Math.max(5000, Math.round(totalKm * 20)));
}

// 估算某點在折線上的「進度」（找最近頂點索引）
function progressOnPath(pt: LatLng, path: LatLng[]) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < path.length; i++) {
    const d = haversineKm(pt, path[i]);
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

function isAttractionAllowedByName(name: string) {
  if (NAME_BLOCK.test(name)) return false;
  if (NAME_ALLOW_BOOST.test(name)) return true;
  // 其它沒命中白名單也允許，但後面還有評分門檻
  return true;
}

// 評分門檻（針對 amusement_park 放寬）
function passRatingGate(p: any, type?: string, loosen = false) {
  const rating = p.rating ?? 0;
  const urt = p.user_ratings_total ?? 0;

  if (type === 'amusement_park') {
    return rating >= (loosen ? 3.4 : 3.6) && urt >= (loosen ? 15 : 20);
      }
  // 一般景點
  if (!loosen) return rating >= 3.8 && urt >= 50;
  return rating >= 3.5 && urt >= 15;
}

/* ============================ Google Maps ============================ */

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  let j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address };
}

async function reverseCity(lat: number, lng: number): Promise<{ city?: string } | undefined> {
  // 只做城市名稱，避免重覆區名
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  const comps: any[] = j.results?.[0]?.address_components || [];
  const find = (t: string) => comps.find(c => c.types?.includes(t))?.long_name as string | undefined;

  // 台灣常見階層：locality（直轄市）/ administrative_area_level_1、_2
  const locality = find('locality');
  const level2 = find('administrative_area_level_2'); // 縣/市
  const level1 = find('administrative_area_level_1');

  // 以 locality 優先，再來是 level2，其次 level1
  const city = locality || level2 || level1;
  if (!city) return { city: undefined };

  return { city: normalizeTwCity(city) };
}

function normalizeTwCity(s: string) {
  // 把「臺」統一成「台」，去除常見冗餘字尾
  let t = s.replace(/臺/g, '台');
  t = t.replace(/(市|縣|區)$/, (m) => m); // 保留單位
  return t;
}

// 清理地址：避免重複城市前綴；若原地址已包含城市開頭就不再重覆
function prependCity(city: string | undefined, origin?: string) {
  if (!origin) return city || '';
  if (!city) return origin;

  const short = origin.replace(/^\s+|\s+$/g, '');
  const cityNorm = city.replace(/臺/g, '台');
  const startsWithCity = short.startsWith(cityNorm);

  if (startsWithCity) return short; // 已有城市前綴
  return `${cityNorm} · ${short}`;
}

async function routeGoogle(origin: string, destination: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status !== 'OK' || !j.routes?.[0]) throw new Error(j.error_message || j.status || 'directions_failed');
  const route = j.routes[0], leg = route.legs[0];
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text,
  };
}

// Nearby：支援可選 keyword（用於樂園關鍵字掃描）
async function nearby(center: LatLng, type: string, radiusM: number, keyword?: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const q = new URLSearchParams({
    location: `${center.lat},${center.lng}`,
    radius: String(radiusM),
    type,
    language: LANG,
    key
  });
  if (keyword) q.set('keyword', keyword);
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${q.toString()}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

/* ============================ OSM/OSRM Fallback ============================ */

async function geocodeOSM(query: string) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'Accept-Language': LANG }, cache: 'no-store' });
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]) throw new Error('geocode_failed');
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name };
}

async function routeOSRM(origin: LatLng, dest: LatLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j = await fetchJson<any>(url);
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route = j.routes[0];
  const coords = route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  return { polyline: coords as LatLng[], distanceText: (route.distance / 1000).toFixed(1) + ' km', durationText: Math.round(route.duration / 60) + ' 分鐘' };
}

/* ============================ POI Collectors ============================ */

// 沿路取點：景點/餐廳/住宿 + 大半徑「樂園關鍵字」掃描
async function collectAlongRoute(path: LatLng[]) {
  const samples = sampleAlongPath(path);
  const totalKm = haversineKm(path[0], path[path.length - 1]);
  const radius  = dynamicRadiusMeters(totalKm);

  const map = new Map<string, { item: PlaceOut, score: number }>();

  // 1) 標準沿路蒐集（景點）
  for (const s of samples) {
    for (const t of ATTRACTION_TYPES) {
      const arr = await nearby(s, t, radius).catch(() => []);
      for (const p of arr) {
        const name = String(p.name || '');
        if (!isAttractionAllowedByName(name)) continue;
        const loosen = totalKm > 200;
        if (!passRatingGate(p, t, loosen)) continue;

        const id = p.place_id as string | undefined;
        const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1) * (1 / (1 + dist / 6));
        const prog = progressOnPath(loc, path);
        const item: PlaceOut = {
          name,
          lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating, place_id: id,
          _type: 'tourist_attraction',
          __progress: prog
        };
        const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        const cur = map.get(key);
        if (!cur || sc > cur.score) map.set(key, { item, score: sc });
      }
      await sleep(25);
    }

    // 餐廳/住宿
    for (const t of ['restaurant', 'lodging'] as const) {
      const arr = await nearby(s, t, radius).catch(() => []);
      for (const p of arr) {
        const id = p.place_id as string | undefined;
        const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1) * (1 / (1 + dist / 6));
        const prog = progressOnPath(loc, path);
        const item: PlaceOut = {
          name: p.name,
          lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating, place_id: id,
          _type: t, __progress: prog
        };
        const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        const cur = map.get(key);
        if (!cur || sc > cur.score) map.set(key, { item, score: sc });
      }
      await sleep(25);
    }
  }

  // 2) 「大型樂園」關鍵字掃描（大半徑 25–45km，每 3 個採樣點掃一次）
  const bigRadius = Math.min(45000, Math.max(25000, Math.round(totalKm * 35)));
  for (let i = 0; i < samples.length; i += 3) {
    const s = samples[i];
    for (const kw of SIGNATURE_PARK_KEYWORDS) {
      const arr = await nearby(s, 'amusement_park', bigRadius, kw).catch(() => []);
      for (const p of arr) {
        if (!passRatingGate(p, 'amusement_park', true)) continue; // 放寬門檻
        const id = p.place_id as string | undefined;
        const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const prog = progressOnPath(loc, path);

        const item: PlaceOut = {
          name: p.name,
          lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating, place_id: id,
          _type: 'tourist_attraction', __progress: prog
        };
        // 給關鍵字命中的樂園一點加成，避免被洗掉
        const bonus = 1.25;
        const sc = bonus * (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1);
        const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        const cur = map.get(key);
        if (!cur || sc > cur.score) map.set(key, { item, score: sc });
      }
      await sleep(20);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => (a.item.__progress! - b.item.__progress!) || (b.score - a.score))
    .map(x => x.item);
}

// 單一中心（距離很近時）
async function collectSingleCenter(center: LatLng) {
  const map = new Map<string, { item: PlaceOut, score: number }>();
  // 景點
  for (const t of ATTRACTION_TYPES) {
    const arr = await nearby(center, t, 3000).catch(() => []);
    for (const p of arr) {
      const name = String(p.name || '');
      if (!isAttractionAllowedByName(name)) continue;
      if (!passRatingGate(p, t, true)) continue; // 單點模式稍放寬
      const id = p.place_id as string | undefined;
      const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const sc = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1);
      const item: PlaceOut = {
        name,
        lat: loc.lat, lng: loc.lng,
        address: p.vicinity || p.formatted_address,
        rating: p.rating, place_id: id,
        _type: 'tourist_attraction'
  };
      const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
      const cur = map.get(key);
      if (!cur || sc > cur.score) map.set(key, { item, score: sc });
    }
    await sleep(20);
  }
  // 餐廳/住宿
  for (const t of ['restaurant', 'lodging'] as const) {
    const arr = await nearby(center, t, 3000).catch(() => []);
    for (const p of arr) {
      const id = p.place_id as string | undefined;
      const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const sc = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1);
      const item: PlaceOut = {
        name: p.name,
        lat: loc.lat, lng: loc.lng,
        address: p.vicinity || p.formatted_address,
        rating: p.rating, place_id: id,
        _type: t
      };
      const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
      const cur = map.get(key);
      if (!cur || sc > cur.score) map.set(key, { item, score: sc });
    }
    await sleep(20);
  }
  return Array.from(map.values()).sort((a, b) => b.score - a.score).map(x => x.item);
}

/* ============================ Itinerary Builder ============================ */

// 旅行社風格：先以景點作骨架，確保「沿主路線前進」，再補午餐/住宿
function buildAgencyStyleItinerary(pois: PlaceOut[], days: number): DaySlot[] {
  // 1) 只取景點，依 __progress 排序，避免同日南北往返
  const attractions = pois.filter(p => p._type === 'tourist_attraction').sort((a, b) => (a.__progress! - b.__progress!));
  const perDay = Math.max(2, Math.min(4, Math.ceil(attractions.length / days))); // 每天 2–4 景點
  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));

  for (let d = 0; d < days; d++) {
    const seg = attractions.slice(d * perDay, (d + 1) * perDay);
    const morning = seg.slice(0, Math.min(2, seg.length));
    const afternoon = seg.slice(morning.length, Math.min(morning.length + 2, seg.length));
    itinerary[d].morning = morning;
    itinerary[d].afternoon = afternoon;
        }

  // 2) 午餐：靠近當日所有景點幾何中心
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];
    const dayPts = [...slots.morning, ...slots.afternoon];
    if (dayPts.length === 0) continue;
    const cx = dayPts.reduce((s, p) => s + p.lat, 0) / dayPts.length;
    const cy = dayPts.reduce((s, p) => s + p.lng, 0) / dayPts.length;

    const candidates = pois.filter(p => p._type === 'restaurant');
    let best: PlaceOut | undefined, bs = -1;
    for (const r of candidates) {
      const sc = (r.rating || 0) / (1 + haversineKm({ lat: cx, lng: cy }, { lat: r.lat, lng: r.lng }) / 5);
      if (sc > bs) { bs = sc; best = r; }
    }
    if (best) itinerary[d].lunch = best;
      }

  // 3) 住宿：靠近下午最後一點（若無則靠近任一點）
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];
    const anchor = slots.afternoon[slots.afternoon.length - 1] || slots.morning[slots.morning.length - 1];
    if (!anchor) continue;

    const hotels = pois.filter(p => p._type === 'lodging');
    let best: PlaceOut | undefined, bs = -1;
    for (const h of hotels) {
      const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 5);
      if (sc > bs) { bs = sc; best = h; }
    }
    if (best) itinerary[d].lodging = best;
  }

  return itinerary;
}

/* ============================ Handler ============================ */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json({ error: 'bad_request', detail: 'origin/destination required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      // 1) 主要路線
      const r = await routeGoogle(origin, destination);
      const startLL = { lat: r.start.lat, lng: r.start.lng }, endLL = { lat: r.end.lat, lng: r.end.lng };
      const isSingle = haversineKm(startLL, endLL) <= NEAR_EQ_KM;

      // 2) POIs
      let pois: PlaceOut[] = [];
      if (isSingle) {
        pois = await collectSingleCenter(startLL);
      } else {
        const along = await collectAlongRoute(r.polyline);
        pois = along.slice(0, 80); // 上限，避免過多
      }

      // 3) 旅行社風格行程（南下/前進）
      const itinerary = buildAgencyStyleItinerary(pois, days);

      // 4) 只對「入選的點」做反向地理 → 在地址前加上城市
      const chosen = new Set<string>();
      itinerary.forEach(d => {
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p: any) => { if (p?.place_id) chosen.add(p.place_id); });
      });

      for (const p of pois) {
        if (!p.place_id || !chosen.has(p.place_id)) continue;
        try {
          const cityInfo = await reverseCity(p.lat, p.lng); // 只取 city
          p.city = cityInfo?.city;
          if (p.address) {
            p.address = prependCity(p.city, p.address);
          } else if (p.city) {
            p.address = p.city;
      }
          await sleep(35);
        } catch {/* 忽略單點失敗 */}
      }

      const out: PlanOut = {
        provider: 'google',
        polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,
        itinerary,
      };
      return NextResponse.json(out, { headers: { 'Cache-Control': 'private, max-age=60' } });

    } else {
      // 無 Google Key：提供最小資訊（不含附近 POI）
      const o = await geocodeOSM(origin), d = await geocodeOSM(destination);
      const ro = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      const out: PlanOut = {
        provider: 'osrm',
        polyline: ro.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: o.lat, lng: o.lng, address: o.formatted },
        end: { lat: d.lat, lng: d.lng, address: d.formatted },
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois: [], itinerary: Array.from({ length: days }, () => ({ morning: [], afternoon: [] })),
      };
      return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
    }

  } catch (e: any) {
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json({ error: 'server_error', detail: e?.message || 'Unknown error' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
