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
  morning: PlaceOut[];
  lunch?: PlaceOut;
  afternoon: PlaceOut[];
  lodging?: PlaceOut;
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
const SAMPLE_MIN = 6;
const SAMPLE_MAX = 14;
const SAMPLE_SEGMENT_KM = 45;
const SAMPLE_DEDUP_KM = 5;
const NEARBY_CONCURRENCY = 6;
const REVERSE_GEOCODE_CONCURRENCY = 4;
const NEARBY_RETRY_LIMIT = 3;
const NEARBY_TIMEOUT_MS = 6000;
const ATTRACTION_KEYWORD_LIMIT = 1;
const MAX_RESPONSE_POIS = 40;
const MAX_RESPONSE_POLYLINE_POINTS = 120;
/** 擴充的景點類型（古蹟、寺廟、步道、博物館、花園、遊樂園等） */
const ATTRACTION_TYPES: PlaceType[] = [
  'tourist_attraction',
  'park',
  'museum',
  'amusement_park',
  'zoo',
  'aquarium',
  'place_of_worship',
];

/** 餐廳與住宿保留，行程拼裝需要 */
const FOOD_TYPES: PlaceType[] = ['restaurant'];
const HOTEL_TYPES: PlaceType[] = ['lodging'];

/** 提升古蹟/步道/博物館/花園探索覆蓋的中文關鍵字（Nearby 可加 keyword） */
const ATTRACTION_CN_KEYWORDS = [
  '古蹟','步道','博物館','花園','樂園','水族館','動物園','美術館'
];

/** ---------------- Utils ---------------- */
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (!tasks.length) return [];
  const safeLimit = Math.max(1, Math.min(limit, tasks.length));
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) break;
      out[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return out;
}

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

/** 依路線動態採樣點：長程更多採樣、短程也至少取 8-24 個點（較先前更輕量） */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const n = Math.max(SAMPLE_MIN, Math.min(SAMPLE_MAX, Math.ceil(total / SAMPLE_SEGMENT_KM) + SAMPLE_MIN));
  const positions: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / Math.max(1, n - 1)) * total;
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
  const dedup: LatLng[] = [];
  for (const p of positions) {
    if (!dedup.some(q => haversineKm(p, q) < SAMPLE_DEDUP_KM)) dedup.push(p);
  }
  return dedup;
}
function dynamicRadiusMeters(totalKm: number) {
  const base = Math.min(15000, Math.max(4000, Math.round(totalKm * 20)));
  return base;
}

/** 從 Geocoding components 取出 city/district（針對台灣更穩定） */
function extractCityDistrict(components: any[]): { city?: string; district?: string } {
  const hasType = (c: any, t: string) => Array.isArray(c.types) && c.types.includes(t);
  const get = (t: string) => components.find((c: any) => hasType(c, t))?.long_name as string | undefined;

  // 台灣常見：縣市在 level_1（台北市/新北市/桃園市/台中市/台南市/高雄市/…）
  // 次選 locality（部分外島/鄉鎮市可能落這）
  let city = get('administrative_area_level_1') || get('locality') || get('postal_town') || get('administrative_area_level_2');

  // 區/鎮：level_3 或 sublocality_level_1；再退到 neighborhood/locality
  let district =
    get('administrative_area_level_3') ||
    get('sublocality_level_1') ||
    get('neighborhood') ||
    (get('locality') && get('locality') !== city ? get('locality') : undefined);

  const norm = (s?: string) => s?.replace(/\s+/g, '')?.replace(/[·・•‧．\.]/g, '') || undefined;
  city = norm(city);
  district = norm(district);

  // 去掉包含關係造成的重複（如「台北市信義區」→ district 以「信義區」為主）
  if (city && district && district.startsWith(city)) {
    district = district.slice(city.length);
    district = norm(district);
  }

  return { city, district };
}

/** 乾淨地把「縣市 / 行政區」前置到地址，避免重複顯示 */
function formatAddressWithCity(address?: string, city?: string, district?: string) {
  const parts: string[] = [];
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  if (city) parts.push(city);
  if (district) parts.push(district);

  let rest = address ? clean(address) : '';
  const head = parts.join(' · ');

  // 去掉原字串中已重複的開頭（縣市/區）
  if (rest) {
    const rmRaw = [city, district].filter(Boolean).join('|');
    if (rmRaw) {
      const rm = rmRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  for (let attempt = 0; attempt < NEARBY_RETRY_LIMIT; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), NEARBY_TIMEOUT_MS);
      const j = await fetchJson<any>(url, { signal: ac.signal });
      clearTimeout(timer);

      if (j.status === 'OK' || j.status === 'ZERO_RESULTS') {
        return Array.isArray(j.results) ? j.results : [];
      }

      const retryable = j.status === 'OVER_QUERY_LIMIT' || j.status === 'UNKNOWN_ERROR';
      if (retryable && attempt < NEARBY_RETRY_LIMIT - 1) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return [];
    } catch {
      if (attempt < NEARBY_RETRY_LIMIT - 1) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return [];
    }
  }
  return [];
}
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

  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const stride = Math.max(1, Math.floor(path.length / 220));
  const lookupIdx: number[] = [];
  for (let i = 0; i < path.length; i += stride) lookupIdx.push(i);
  if (lookupIdx[lookupIdx.length - 1] !== path.length - 1) lookupIdx.push(path.length - 1);

  const progressOf = (pt: LatLng) => {
    let best = Infinity;
    let bestIdx = 0;
    for (const idx of lookupIdx) {
      const d = haversineKm(pt, path[idx]);
      if (d < best) {
        best = d;
        bestIdx = idx;
      }
    }
    const prog = cum[bestIdx] / (total || 1);
    return Math.max(0, Math.min(1, prog));
  };

  const byId = new Map<string, { item: PlaceOut; score: number }>();

  const ingest = (arr: any[], type: PlaceType, sample: LatLng, boost = 1) => {
    for (const p of arr) {
      const id = p.place_id as string | undefined;
      if (!id || !p.geometry?.location) continue;
      const point = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const sc = scorePlace(p, haversineKm(sample, point)) * boost;
      const item = asPlaceOut(p, type, progressOf(point));
      if (!item) continue;
      const cur = byId.get(id);
      if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
    }
  };

  const tasks: Array<() => Promise<void>> = [];

  for (let si = 0; si < samples.length; si++) {
    const s = samples[si];
    for (const t of ATTRACTION_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, radius);
        ingest(arr, t, s);
      });

      if (si % 2 === 0) {
        for (const kw of ATTRACTION_CN_KEYWORDS.slice(0, ATTRACTION_KEYWORD_LIMIT)) {
          tasks.push(async () => {
            const arr2 = await nearby(s, t, Math.round(radius * 0.8), kw);
            ingest(arr2, t, s, 1.05);
          });
        }
      }
    }
  }

  for (const s of samples) {
    for (const t of FOOD_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, Math.max(3000, Math.round(radius * 0.5)));
        ingest(arr, t, s);
      });
    }
  }

  for (const s of samples) {
    for (const t of HOTEL_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, Math.max(5000, Math.round(radius * 0.6)));
        ingest(arr, t, s);
      });
    }
  }

  await runWithConcurrency(tasks, NEARBY_CONCURRENCY);

  const pois = Array.from(byId.values())
    .sort((a, b) => {
      const pa = a.item.progress ?? 0;
      const pb = b.item.progress ?? 0;
      return pa - pb || b.score - a.score;
    })
    .map(x => x.item);

  const seen = new Set<string>();
  const clean: PlaceOut[] = [];
  for (const p of pois) {
    const k = `${(p.name || '').trim()}@${(p.address || '').slice(0, 24)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(p);
  }
  return clean;
}
function buildAgencyStyleItinerary(pois: PlaceOut[], days: number): DaySlot[] {
  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));

  const attractions = pois.filter(p => ATTRACTION_TYPES.includes(p._type as any));
  const restaurants = pois.filter(p => FOOD_TYPES.includes(p._type as any));
  const hotels = pois.filter(p => HOTEL_TYPES.includes(p._type as any));

  for (let d = 0; d < days; d++) {
    const start = d / days;
    const end = (d + 1) / days;
    const bucket = attractions.filter(p => {
      const pr = p.progress ?? 0;
      return pr >= start - 0.03 && pr < end + 0.03;
    }).slice(0, 24);

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

  // 跨桶回填，確保上午/下午至少 2 個
  const allAttractionsSorted = attractions.slice().sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));
  const idOf = (p: PlaceOut) => p.place_id || `${p.name}@${p.lat},${p.lng}`;
  for (let d = 0; d < days; d++) {
    const needM = Math.max(0, 2 - itinerary[d].morning.length);
    const needA = Math.max(0, 2 - itinerary[d].afternoon.length);
    if (needM || needA) {
      const picked = new Set([...itinerary[d].morning, ...itinerary[d].afternoon].map(idOf));
      const start = d / days, end = (d + 1) / days;
      const near = allAttractionsSorted.filter(p => {
        const pr = p.progress ?? 0;
        return pr >= start - 0.1 && pr <= end + 0.1 && !picked.has(idOf(p));
      });
      while (itinerary[d].morning.length < 2 && near.length) itinerary[d].morning.push(near.shift()!);
      while (itinerary[d].afternoon.length < 2 && near.length) itinerary[d].afternoon.push(near.shift()!);
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

  const geoCache = new Map<string, Promise<{ city?: string; district?: string; formatted: string }>>();
  const reverseCached = (lat: number, lng: number) => {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = geoCache.get(key);
    if (hit) return hit;
    const req = reverseGeocodeGoogle(lat, lng);
    geoCache.set(key, req);
    return req;
  };

  const tasks = Array.from(chosenIds).map(id => async () => {
    const p = idToPoi.get(id);
    if (!p) return;
    try {
      const rev = await reverseCached(p.lat, p.lng);
      p.city = rev.city;
      p.district = rev.district;
      p.address = formatAddressWithCity(p.address, rev.city, rev.district);
    } catch {
      if (p.address) p.address = p.address.trim();
    }
  });

  await runWithConcurrency(tasks, REVERSE_GEOCODE_CONCURRENCY);
}
function toPolylineArray(path: LatLng[], maxPoints = MAX_RESPONSE_POLYLINE_POINTS): [number, number][] {
  if (!path.length) return [];
  if (path.length <= maxPoints) return path.map(({ lat, lng }) => [lat, lng] as [number, number]);

  const out: [number, number][] = [];
  const step = (path.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(path.length - 1, Math.round(i * step));
    const p = path[idx];
    out.push([p.lat, p.lng]);
  }
  return out;
}

function compactPlaceForResponse(p: PlaceOut): PlaceOut {
  return {
    name: p.name,
    lat: Number(p.lat.toFixed(6)),
    lng: Number(p.lng.toFixed(6)),
    address: p.address?.slice(0, 80),
    rating: p.rating,
    user_ratings_total: p.user_ratings_total,
    place_id: p.place_id,
    _type: p._type,
    city: p.city,
    district: p.district,
    progress: typeof p.progress === 'number' ? Number(p.progress.toFixed(4)) : undefined,
  };
}

function compactDaySlot(day: DaySlot): DaySlot {
  return {
    morning: day.morning.map(compactPlaceForResponse),
    lunch: day.lunch ? compactPlaceForResponse(day.lunch) : undefined,
    afternoon: day.afternoon.map(compactPlaceForResponse),
    lodging: day.lodging ? compactPlaceForResponse(day.lodging) : undefined,
  };
}

function slimPoisForResponse(pois: PlaceOut[], itinerary: DaySlot[], limit = MAX_RESPONSE_POIS): PlaceOut[] {
  const keyOf = (p: PlaceOut) => p.place_id || `${p.name}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const picked = new Map<string, PlaceOut>();

  for (const day of itinerary) {
    for (const p of [...day.morning, day.lunch, ...day.afternoon, day.lodging]) {
      if (!p) continue;
      const k = keyOf(p);
      if (!picked.has(k)) picked.set(k, p);
    }
  }

  const out: PlaceOut[] = [];
  for (const p of picked.values()) {
    out.push(compactPlaceForResponse(p));
    if (out.length >= limit) return out;
  }

  for (const p of pois) {
    const k = keyOf(p);
    if (picked.has(k)) continue;
    out.push(compactPlaceForResponse(p));
    if (out.length >= limit) break;
  }
  return out;
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
      const r = await directionsGoogle(origin, destination);
      const startLL = { lat: r.start.lat, lng: r.start.lng };
      const endLL = { lat: r.end.lat, lng: r.end.lng };
      const isSingle = haversineKm(startLL, endLL) <= NEAR_EQ_KM;

      let pois: PlaceOut[] = [];
      if (isSingle) {
        const fakePath = [startLL, { lat: startLL.lat - 0.5, lng: startLL.lng + 0.2 }];
        pois = await harvestPOIsAlongPath(fakePath);
      } else {
        pois = await harvestPOIsAlongPath(r.polyPts);
      }

      const itinerary = buildAgencyStyleItinerary(pois, days);
      await enrichChosenPOIsWithCity(itinerary, pois);

      return NextResponse.json({
        provider: 'google',
        polyline: toPolylineArray(r.polyPts),
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois: slimPoisForResponse(pois, itinerary),
        itinerary: itinerary.map(compactDaySlot),
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });
    } else {
      const o = await geocodeOSM(origin), d = await geocodeOSM(destination);
      const ro = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      return NextResponse.json({
        provider: 'osrm',
        polyline: toPolylineArray(ro.polyPts),
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
