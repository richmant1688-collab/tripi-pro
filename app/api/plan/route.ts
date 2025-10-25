// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

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
  city?: string; // 反向地理編碼後加上（例如「台北市 信義區」）
};

type DaySlot = {
  morning: PlaceOut[];  // 景點 1–2
  lunch?: PlaceOut;     // 餐廳 1
  afternoon: PlaceOut[];// 景點 1–2
  lodging?: PlaceOut;   // 住宿 1
};

const LANG = 'zh-TW';
const SEARCH_TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];

/* ---------------- Utilities ---------------- */

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
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  return acc;
}

/** 沿途動態取樣（依總長度決定點數；並做 5km 去重） */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  if (total === 0) return [path[0]];

  // 每 30–60km 取一點，至少 3 點，至多 28 點
  const step = Math.max(30, Math.min(60, total / 12));
  const n = Math.min(28, Math.max(3, Math.round(total / step) + 1));

  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let j = 0;
    while (j < cum.length && cum[j] < target) j++;
    if (j === 0) out.push(path[0]);
    else if (j >= cum.length) out.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const r = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      out.push({ lat: A.lat + (B.lat - A.lat) * r, lng: A.lng + (B.lng - A.lng) * r });
    }
  }
  // 5km 去重
  const dedup: LatLng[] = [];
  for (const p of out) if (!dedup.some(q => haversineKm(p, q) < 5)) dedup.push(p);
  return dedup;
}

/** 依總長抓搜尋半徑（公尺） */
function dynamicRadiusMeters(totalKm: number) {
  // 短程較小、長程較大；上限 15km
  return Math.min(15000, Math.max(3000, Math.round(totalKm * 18)));
}

/* ---------------- Geocoding / Directions ---------------- */

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  let j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address };
}

async function routeGoogle(origin: string, destination: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status !== 'OK' || !j.routes?.[0]) throw new Error(j.error_message || j.status || 'directions_failed');
  const route = j.routes[0], leg = route.legs[0];
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text,
  };
}

/** 反向地理：回傳「縣市」與「區」；避免重複、避免只拿到「台灣」 */
async function reverseCity(lat: number, lng: number): Promise<{ city?: string; district?: string }> {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY!;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
    const j = await fetchJson<any>(url);
    const comps: any[] = j.results?.[0]?.address_components || [];

    const find = (types: string[]) => comps.find(c => types.every(t => c.types?.includes(t)))?.long_name;

    // 在台灣常見：level_2 = 台北市/新北市/桃園市...；district 用 sublocality_level_1 或 level_3
    const level1 = find(['administrative_area_level_1']); // 有時是「台灣」
    const level2 = find(['administrative_area_level_2']) || find(['locality']) || find(['postal_town']);
    const level3 = find(['administrative_area_level_3']);
    const subloc = comps.find(c => String(c.types).includes('sublocality_level_1'))?.long_name;

    const city = (level2 && level2 !== '台灣') ? level2 : (level1 !== '台灣' ? level1 : undefined);
    const district = subloc || level3;

    return { city, district };
  } catch {
    return {};
  }
}

/** 將「縣市 · 區」乾淨地前置到 address；若已包含就不重複 */
function prefixCityToAddress(addr: string | undefined, city?: string, district?: string) {
  if (!city && !district) return addr;
  const parts = [city, district].filter(Boolean) as string[];
  const prefix = parts.join(' ');
  if (!addr) return prefix;
  const safe = addr.replace(/^台灣[,\s]*/,'').replace(/^臺灣[,\s]*/,'');
  // 若地址已含 city 或 district，不重複
  const already = (city && safe.includes(city)) || (district && safe.includes(district));
  return already ? safe : `${prefix} · ${safe}`;
}

/* ---------------- Google Places ---------------- */

async function nearby(center: LatLng, type: PlaceType, radiusM: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${center.lat},${center.lng}&radius=${radiusM}&type=${encodeURIComponent(type)}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

function scorePlace(p: any, distKm?: number) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const prox = typeof distKm === 'number' ? 1 / (1 + distKm / 5) : 1;
  return rating * pop * prox;
}

/** 類型正規化：非餐廳/住宿一律視為景點 */
function normalizeType(raw: string | undefined): PlaceType {
  if (!raw) return 'tourist_attraction';
  const t = raw.toLowerCase();

  // 餐廳
  if (t.includes('restaurant') || t === 'food' || t === 'meal_takeaway' || t === 'meal_delivery') {
    return 'restaurant';
  }
  // 住宿
  if (t.includes('lodging') || t.includes('hotel') || t.includes('motel') || t.includes('guest_house') || t.includes('hostel')) {
    return 'lodging';
  }

  const attractionAliases = [
    'tourist_attraction','point_of_interest','aquarium','zoo','museum','park','amusement_park',
    'natural_feature','art_gallery','church','hindu_temple','mosque','synagogue','temple',
    'rv_park','campground','beach','landmark','shopping_mall','library','stadium','university'
  ];
  if (attractionAliases.some(k => t.includes(k))) return 'tourist_attraction';

  return 'tourist_attraction';
}

/** 沿途：多類型合併；依進度排序；回傳附帶 place_id/_type（已正規化） */
async function placesAlongRoute(path: LatLng[]): Promise<PlaceOut[]> {
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length - 1]);
  const radius = dynamicRadiusMeters(totalKm);
  const byId = new Map<string, { item: PlaceOut, score: number, progress: number }>();

  // 以「最近折線頂點索引」近似進度
  const progressOf = (pt: LatLng) => {
    let best = Infinity, bi = 0;
    for (let i = 0; i < path.length; i++) {
      const d = haversineKm(pt, path[i]);
      if (d < best) { best = d; bi = i; }
    }
    return bi;
        };

  for (const s of samples) {
    for (const t of SEARCH_TYPES) {
      const arr = await nearby(s, t, radius);
      for (const p of arr) {
        const id: string | undefined = p.place_id;
        if (!id) continue;
        const loc: LatLng = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc = scorePlace(p, dist);
        const rawType: string | undefined = (Array.isArray(p.types) && p.types.length ? p.types[0] : undefined) || t;
        const item: PlaceOut = {
          name: p.name,
          lat: loc.lat,
          lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating,
          place_id: id,
          _type: normalizeType(rawType),
        };
        const pr = progressOf(loc);
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc, progress: pr });
      }
      await sleep(60);
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => a.progress - b.progress || b.score - a.score)
    .map(x => x.item);
}

/** 單點：多類型 Nearby（出發地≈目的地時使用） */
async function placesSingleCenter(center: LatLng): Promise<PlaceOut[]> {
  const byId = new Map<string, { item: PlaceOut, score: number }>();
  for (const t of SEARCH_TYPES) {
    const arr = await nearby(center, t, 3000);
    for (const p of arr) {
      const id: string | undefined = p.place_id;
      if (!id) continue;
      const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const sc = scorePlace(p);
      const rawType: string | undefined = (Array.isArray(p.types) && p.types.length ? p.types[0] : undefined) || t;
      const item: PlaceOut = {
        name: p.name,
        lat: loc.lat,
        lng: loc.lng,
        address: p.vicinity || p.formatted_address,
        rating: p.rating,
        place_id: id,
        _type: normalizeType(rawType),
  };
      const cur = byId.get(id);
      if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
    }
    await sleep(60);
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score).map(x => x.item);
}

/* ---------------- 行程切天（旅行社風格 + 缺口補齊） ---------------- */

function buildAgencyStyleItinerary(allPois: PlaceOut[], days: number): DaySlot[] {
  // 類型保險正規化
  const pois = allPois.map(p => ({ ...p, _type: normalizeType(p._type as any) }));

  const restaurants = pois.filter(p => p._type === 'restaurant');
  const lodgings   = pois.filter(p => p._type === 'lodging');
  // 凡非餐廳/住宿，一律視為景點
  const attractions = pois.filter(p => p._type !== 'restaurant' && p._type !== 'lodging');
  const baseAttractions = attractions.length ? attractions : pois;

  // 每天 2–4 個景點
  const total = Math.max(baseAttractions.length, days * 3);
  const perDay = Math.max(2, Math.min(4, Math.ceil(total / days)));

  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));

  let idx = 0;
  for (let d = 0; d < days; d++) {
    const seg = baseAttractions.slice(idx, idx + perDay);
    idx += perDay;
    const morning = seg.slice(0, Math.min(2, seg.length));
    const afternoon = seg.slice(morning.length, Math.min(morning.length + 2, seg.length));
    itinerary[d].morning = morning;
    itinerary[d].afternoon = afternoon;
  }

  // 每天選餐廳（靠近當日幾何中心）
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];
    const dayPts = [...slots.morning, ...slots.afternoon];
    if (!dayPts.length) continue;

    const cx = dayPts.reduce((s, p) => s + p.lat, 0) / dayPts.length;
    const cy = dayPts.reduce((s, p) => s + p.lng, 0) / dayPts.length;

    const cand = restaurants.length ? restaurants : pois.filter(p => p._type !== 'lodging');
    let best: PlaceOut | undefined, bs = -1;
    for (const r of cand) {
      const sc = (r.rating || 0) / (1 + haversineKm({ lat: cx, lng: cy }, { lat: r.lat, lng: r.lng }) / 5);
      if (sc > bs) { bs = sc; best = r; }
    }
    if (best) itinerary[d].lunch = best;
  }

  // 每天選住宿（靠近下午最後一點，否則上午最後一點）
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];
    const anchor = slots.afternoon[slots.afternoon.length - 1] || slots.morning[slots.morning.length - 1];
    if (!anchor) continue;

    const hotels = lodgings.length ? lodgings : pois.filter(p => p._type !== 'restaurant');
    let best: PlaceOut | undefined, bs = -1;
    for (const h of hotels) {
      const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 5);
      if (sc > bs) { bs = sc; best = h; }
    }
    if (best) itinerary[d].lodging = best;
  }

  // 缺口補齊：每天至少上午 1、下午 1
  const used = new Set<string>();
  const key = (p: PlaceOut) => (p.place_id || p.name) + '@' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
  const mark = (p?: PlaceOut) => { if (p) used.add(key(p)); };

  itinerary.forEach(d => {
    d.morning.forEach(mark);
    mark(d.lunch);
    d.afternoon.forEach(mark);
    mark(d.lodging);
  });

  const remaining = baseAttractions.filter(p => !used.has(key(p)));
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];

    const needMorning = Math.max(1, Math.min(2, slots.morning.length || 1)) - slots.morning.length;
    for (let i = 0; i < needMorning && remaining.length; i++) slots.morning.push(remaining.shift()!);

    const needAfternoon = Math.max(1, Math.min(2, slots.afternoon.length || 1)) - slots.afternoon.length;
    for (let i = 0; i < needAfternoon && remaining.length; i++) slots.afternoon.push(remaining.shift()!);
      }

  return itinerary;
}

/* ---------------- OSM/OSRM fallback（無 Google Key） ---------------- */

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
  return {
    polyline: coords as LatLng[],
    distanceText: (route.distance / 1000).toFixed(1) + ' km',
    durationText: Math.round(route.duration / 60) + ' 分鐘'
  };
}

/* ---------------- Handler ---------------- */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json({ error: 'bad_request', detail: 'origin/destination required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      // 取得路線
      const r = await routeGoogle(origin, destination);
      const startLL = { lat: r.start.lat, lng: r.start.lng };
      const endLL   = { lat: r.end.lat,   lng: r.end.lng   };
      const totalDirect = haversineKm(startLL, endLL);
      const isSingle = totalDirect <= 3; // 起訖幾乎相同時，走單點模式

      // 沿途/單點撈 POIs
      let pois: PlaceOut[] = [];
      if (isSingle) {
        pois = await placesSingleCenter(startLL);
      } else {
        const along = await placesAlongRoute(r.polyline);
        pois = along.slice(0, 80); // 避免過量
      }

      // 產生行程（旅行社切法 + 缺口補齊）
      const itinerary = buildAgencyStyleItinerary(pois, days);

      // 只對「入選的點」補上 city/district，並把 city/district 前置到 address
      const chosenIds = new Set<string>();
      itinerary.forEach(d => {
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p: any) => {
          if (p?.place_id) chosenIds.add(p.place_id);
      });
      });

      for (const p of pois) {
        if (!p.place_id || !chosenIds.has(p.place_id)) continue;
        try {
          const loc = await reverseCity(p.lat, p.lng);
          p.city = [loc.city, loc.district].filter(Boolean).join(' ');
          p.address = prefixCityToAddress(p.address, loc.city, loc.district);
          await sleep(40);
        } catch { /* ignore */ }
      }

      return NextResponse.json({
        provider: 'google',
        polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end:   { lat: r.end.lat,   lng: r.end.lng,   address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,            // 扁平池
        itinerary,       // ✅ 早/午/晚
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });

    } else {
      // 無 Google Key：回傳最小可視化資訊
      const o = await geocodeOSM(origin), d = await geocodeOSM(destination);
      const ro = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      return NextResponse.json({
        provider: 'osrm',
        polyline: ro.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: o.lat, lng: o.lng, address: o.formatted },
        end:   { lat: d.lat, lng: d.lng, address: d.formatted },
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois: [], itinerary: [],
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch (e: any) {
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json({ error: 'server_error', detail: e?.message || 'Unknown error' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
