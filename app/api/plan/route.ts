// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/* ---------------- Types ---------------- */
type LatLng = { lat: number; lng: number };
type PlaceType = 'tourist_attraction' | 'restaurant' | 'lodging' | 'amusement_park';
type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  place_id?: string;
  _type: PlaceType;
  city?: string; // 反向地理後加上（前置用）
};

/* 行程：旅行社風格 */
type DaySlot = {
  morning: PlaceOut[]; // 1–2 景點（含 amusement_park）
  lunch?: PlaceOut;    // 1 餐廳
  afternoon: PlaceOut[]; // 1–2 景點
  lodging?: PlaceOut;    // 1 住宿
};

const LANG = 'zh-TW';
// 主要類型＋大型樂園
const TYPES: PlaceType[] = ['tourist_attraction', 'amusement_park', 'restaurant', 'lodging'];

// 視為「同點」門檻（公里），起訖太近就走單點模式
const NEAR_EQ_KM = 3;

/** 針對大型樂園做全台 TextSearch 注入的查詢詞 */
const BIG_PARK_QUERIES = [
  '六福村 主題樂園',
  '麗寶 樂園',
  '劍湖山 世界',
  '義大 世界 樂園',
  '義大遊樂世界',
];
const BIG_PARK_NAME_RE = /(六福|麗寶|劍湖山|義大)/;

/* ---------------- Utils ---------------- */
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
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
}

/** 折線累計距離（公里） */
function cumulativeDistances(path: LatLng[]) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  return acc;
}

/** 點投影到折線，回傳距起點累計距離與進度百分比 */
function progressOnPathKm(path: LatLng[], cum: number[], p: LatLng) {
  if (path.length <= 1) return { km: 0, pct: 0 };
  let bestKm = 0, bestPct = 0, bestDist = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const A = path[i], B = path[i + 1];
    // 以經緯度作為近似向量空間計算投影比例 t（0~1）
    const vx = B.lng - A.lng, vy = B.lat - A.lat;
    const wx = p.lng - A.lng, wy = p.lat - A.lat;
    const vv = vx * vx + vy * vy;
    const t = vv === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
    const proj: LatLng = { lat: A.lat + vy * t, lng: A.lng + vx * t };
    const d = haversineKm(p, proj);
    if (d < bestDist) {
      bestDist = d;
      const km = cum[i] + haversineKm(A, proj);
      bestKm = km;
      const total = cum[cum.length - 1] || 1e-9;
      bestPct = Math.max(0, Math.min(1, km / total));
    }
  }

  return { km: bestKm, pct: bestPct };
}

/** 等距取樣（8~16點），避免前段過密 */
function sampleAlongPath(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeDistances(path);
  const total = cum[cum.length - 1];
  const n = Math.min(16, Math.max(8, Math.round(total / 35) + 8)); // 35km/段，8~16
  if (n <= 1) return [path[0]];

  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const j = lo;
    if (j === 0) { out.push(path[0]); continue; }
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const r = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      out.push({ lat: A.lat + (B.lat - A.lat) * r, lng: A.lng + (B.lng - A.lng) * r });
    }
  const dedup: LatLng[] = [];
  for (const p of out) if (!dedup.some(q => haversineKm(p, q) < 5)) dedup.push(p);
  return dedup;
}

function dynamicRadiusMeters(totalKm: number, progressPct: number) {
  const base = Math.max(3500, Math.min(7000, Math.round(totalKm * 18)));
  const tailBoost = Math.round(Math.pow(progressPct, 1.5) * 6000);
  return Math.max(3000, Math.min(15000, base + tailBoost));
}

/* ---------------- Google Services ---------------- */
async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  let j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address };
}

function normCity(s?: string) {
  if (!s) return s;
  return s.replace(/^臺/g, '台').replace(/臺/g, '台');
}

async function reverseCity(lat: number, lng: number): Promise<{ city?: string; district?: string } | undefined> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const pick = (t: string) => ac.find(c => c.types?.includes(t))?.long_name as string | undefined;
  const locality = pick('locality');
  const level2 = pick('administrative_area_level_2');
  const level1 = pick('administrative_area_level_1');
  const sublocal = pick('sublocality_level_1') || pick('administrative_area_level_3') || pick('neighborhood');

  const city = normCity(locality || level2 || level1);
  const district = normCity(sublocal);
  return { city, district };
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
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text,
  };
}

async function nearby(center: LatLng, type: PlaceType, radiusM: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${center.lat},${center.lng}&radius=${radiusM}&type=${encodeURIComponent(type)}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

/** Text Search（全國） */
async function textSearch(query: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

/** 評分：星等×人氣×近樣本×前進加權；大型樂園給 Bonus */
function scorePlace(p: any, distKm: number | undefined, progressPct: number, forceBigBonus = false) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const prox = typeof distKm === 'number' ? 1 / (1 + distKm / 5) : 1;
  const forward = 0.6 + 0.8 * progressPct;
  const name: string = (p.name || '') as string;
  const big = forceBigBonus || BIG_PARK_NAME_RE.test(name);
  const bigBoost = big ? 1.8 : 1.0; // 大型樂園 ×1.8
  return rating * pop * prox * forward * bigBoost;
}

/* ---------------- POI：沿途 & 單點 + 大型樂園注入 ---------------- */
async function placesAlongRoute(path: LatLng[]): Promise<{ list: PlaceOut[]; cum: number[]; totalKm: number }> {
  const cum = cumulativeDistances(path);
  const totalKm = cum[cum.length - 1] || 1;
  const samples = sampleAlongPath(path);

  const byId = new Map<string, { item: PlaceOut; score: number; progressPct: number }>();

  // 先做一般 Nearby（含 amusement_park，但會濾除弱小場）
  for (let si = 0; si < samples.length; si++) {
    const s = samples[si];
    const { pct } = progressOnPathKm(path, cum, s);
    const radius = dynamicRadiusMeters(totalKm, pct);

    for (const t of TYPES) {
      const arr = await nearby(s, t, radius);
      for (const p of arr) {
        const id = p.place_id as string | undefined; if (!id) continue;

        // 小型 amusement_park 過濾：若不是大型關鍵字且 urt < 500，直接忽略（避免台北滿地小館）
        if (t === 'amusement_park') {
          const urt = p.user_ratings_total || 0;
          const name: string = p.name || '';
          if (!BIG_PARK_NAME_RE.test(name) && urt < 500) continue;
        }

        const loc: LatLng = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const { pct: pp } = progressOnPathKm(path, cum, loc);
        const sc = scorePlace(p, dist, pp);
        const item: PlaceOut = {
          name: p.name, lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address, rating: p.rating, place_id: id, _type: t
        };
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc, progressPct: pp });
      }
      await sleep(80);
    }
    }

  // 再做「大型樂園」Text Search 全國注入：只納入距離路徑 ≤ 30km，進度 0.05~0.98 之間
  for (const q of BIG_PARK_QUERIES) {
    const parks = await textSearch(q);
      for (const p of parks) {
        const id = p.place_id as string | undefined; if (!id) continue;
        const loc: LatLng = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      // 找離路徑最近距離（粗略用所有頂點最小距離）
      let bestD = Infinity;
      for (const v of path) bestD = Math.min(bestD, haversineKm(loc, v));
      if (bestD > 30) continue; // 離路徑太遠不收
        const { pct: pp } = progressOnPathKm(path, cum, loc);
      if (pp < 0.05 || pp > 0.98) continue;

      const sc = scorePlace(p, bestD, pp, true /* force big */);
        const item: PlaceOut = {
          name: p.name, lat: loc.lat, lng: loc.lng,
        address: p.formatted_address || p.vicinity, rating: p.rating, place_id: id, _type: 'amusement_park'
        };
        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc, progressPct: pp });
      }
    await sleep(120);
  }

  const list = Array.from(byId.values())
    .sort((a, b) => a.progressPct - b.progressPct || b.score - a.score)
    .map(x => x.item);

  return { list, cum, totalKm };
}

async function placesSingleCenter(center: LatLng): Promise<PlaceOut[]> {
  const byId = new Map<string, { item: PlaceOut; score: number }>();
  for (const t of TYPES) {
    const arr = await nearby(center, t, 4000);
    for (const p of arr) {
      const id = p.place_id as string | undefined; if (!id) continue;
      if (t === 'amusement_park') {
        const urt = p.user_ratings_total || 0;
        const name: string = p.name || '';
        if (!BIG_PARK_NAME_RE.test(name) && urt < 500) continue;
      }
      const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const sc = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1);
      const item: PlaceOut = { name: p.name, lat: loc.lat, lng: loc.lng, address: p.vicinity || p.formatted_address, rating: p.rating, place_id: id, _type: t };
      const cur = byId.get(id); if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
    }
    await sleep(80);
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score).map(x => x.item);
}

/* ---------------- 行程切日（按進度分帶） ---------------- */
function bandedAgencyItinerary(pois: PlaceOut[], days: number, path: LatLng[], cum: number[]) : DaySlot[] {
  const progress = (p: PlaceOut) => progressOnPathKm(path, cum, { lat: p.lat, lng: p.lng }).pct;

  const bands: PlaceOut[][] = Array.from({ length: days }, () => []);
  for (const p of pois) {
    let idx = Math.floor(progress(p) * days);
    if (idx < 0) idx = 0;
    if (idx >= days) idx = days - 1;
    bands[idx].push(p);
  }

  const typeRank: Record<PlaceType, number> = {
    amusement_park: 0, tourist_attraction: 1, restaurant: 2, lodging: 3
  } as const;

  bands.forEach(b => b.sort((a, b2) => (typeRank[a._type] - typeRank[b2._type]) || (b2.rating || 0) - (a.rating || 0)));

  const daySlots: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));

  function borrowToFill(i: number, need: number, pred: (p: PlaceOut) => boolean): PlaceOut[] {
    const picked: PlaceOut[] = [];
    const idxs: number[] = [i];
    for (let step = 1; step < days && picked.length < need; step++) {
      const r = i + step; if (r < days) idxs.push(r);
      const l = i - step; if (l >= 0) idxs.push(l);
    }
    for (const bi of idxs) {
      if (picked.length >= need) break;
      const pool = bands[bi];
      for (let k = 0; k < pool.length && picked.length < need; k++) {
        if (pred(pool[k])) picked.push(pool.splice(k--, 1)[0]);
      }
    }
    return picked;
        }

  for (let d = 0; d < days; d++) {
    const base = bands[d].splice(0, Math.min(8, bands[d].length));

    const attractions = base.filter(p => p._type === 'amusement_park' || p._type === 'tourist_attraction');

    if (attractions.length < 3) {
      const extra = borrowToFill(d, 3 - attractions.length, p => p._type === 'amusement_park' || p._type === 'tourist_attraction');
      attractions.push(...extra);
    }

    const morning = attractions.slice(0, Math.min(2, attractions.length));
    const afternoon = attractions.slice(morning.length, Math.min(morning.length + 2, attractions.length));

    daySlots[d].morning = morning;
    daySlots[d].afternoon = afternoon;

    // 午餐：靠近本日幾何中心
    const dayPts = [...morning, ...afternoon];
    if (dayPts.length) {
    const cx = dayPts.reduce((s, p) => s + p.lat, 0) / dayPts.length;
    const cy = dayPts.reduce((s, p) => s + p.lng, 0) / dayPts.length;
      const pickResto = (poolIdx: number[]) => {
    let best: PlaceOut | undefined, bs = -1;
        for (const bi of poolIdx) {
          const pool = bands[bi];
          for (let k = 0; k < pool.length; k++) {
            const p = pool[k];
            if (p._type !== 'restaurant') continue;
            const sc = (p.rating || 0) / (1 + haversineKm({ lat: cx, lng: cy }, { lat: p.lat, lng: p.lng }) / 5);
            if (sc > bs) { bs = sc; best = p; pool.splice(k--, 1); }
    }
        }
        return best;
      };
      daySlots[d].lunch = pickResto([d]) || pickResto([d + 1, d - 1].filter(x => x >= 0 && x < days));
      }

    // 住宿：靠近下午最後一個點；若無則靠近期末點
    const anchor = daySlots[d].afternoon[daySlots[d].afternoon.length - 1] || dayPts[dayPts.length - 1];
    if (anchor) {
      const pickHotel = (poolIdx: number[]) => {
    let best: PlaceOut | undefined, bs = -1;
        for (const bi of poolIdx) {
          const pool = bands[bi];
          for (let k = 0; k < pool.length; k++) {
            const p = pool[k];
            if (p._type !== 'lodging') continue;
            const sc = (p.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: p.lat, lng: p.lng }) / 5);
            if (sc > bs) { bs = sc; best = p; pool.splice(k--, 1); }
          }
        }
        return best;
      };
      daySlots[d].lodging = pickHotel([d]) || pickHotel([d + 1, d - 1].filter(x => x >= 0 && x < days));
    }
  }

  return daySlots;
}

/* ---------------- 地址前置縣市（只處理入選點） ---------------- */
function prependCityToAddress(p: PlaceOut, city?: string, district?: string) {
  const parts: string[] = [];
  if (city) parts.push(city);
  if (district) parts.push(district);
  const prefix = parts.join(' · ');

  if (!prefix) return;

  if (p.address) {
    const addr = p.address || '';
    if (city && addr.includes(city)) return;
    if (district && addr.includes(district)) { p.address = `${city ? city + ' · ' : ''}${addr}`; return; }
    p.address = `${prefix} · ${addr}`;
  } else {
    p.address = prefix;
  }
}

/* ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days: _days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json(
        { error: 'bad_request', detail: 'origin/destination required' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const days = Math.max(1, Math.min(14, Number(_days) || 5));
    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (!hasGoogle) {
      return NextResponse.json(
        {
          provider: 'osrm',
          polyline: [],
          start: { lat: 0, lng: 0, address: origin },
          end: { lat: 0, lng: 0, address: destination },
          distanceText: '', durationText: '',
          pois: [], itinerary: [],
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // 1) 路線
      const r = await routeGoogle(origin, destination);
    const startLL = { lat: r.start.lat, lng: r.start.lng };
    const endLL = { lat: r.end.lat, lng: r.end.lng };
    const nearlySame = haversineKm(startLL, endLL) <= NEAR_EQ_KM;

    // 2) 取 POIs
      let pois: PlaceOut[] = [];
    let cum: number[] = [], totalKm = 0;

    if (nearlySame) {
      pois = await placesSingleCenter(startLL);
      cum = [0]; totalKm = 0;
      } else {
      const along = await placesAlongRoute(r.polyline);
      pois = along.list.slice(0, 90); // 上限
      cum = cumulativeDistances(r.polyline);
      totalKm = along.totalKm;
      }

    // 3) 切日（進度分帶 + 旅行社邏輯）
    const itinerary = nearlySame
      ? bandedAgencyItinerary(pois, days, [startLL, endLL], [0, haversineKm(startLL, endLL)])
      : bandedAgencyItinerary(pois, days, r.polyline, cum);

    // 4) 只對入選點反地理，前置縣市
    const chosenIds = new Set<string>();
      itinerary.forEach(d => {
      [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p: any) => {
        if (p?.place_id) chosenIds.add(p.place_id);
      });
      });

      for (const p of pois) {
      if (!p.place_id || !chosenIds.has(p.place_id)) continue;
        try {
        const geo = await reverseCity(p.lat, p.lng);
        if (geo) {
          p.city = geo.city;
          prependCityToAddress(p, geo.city, geo.district);
      }
        await sleep(50);
      } catch { /* ignore */ }
      }

    return NextResponse.json(
      {
        provider: 'google',
        polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,
        itinerary,
      },
      { headers: { 'Cache-Control': 'private, max-age=60' } }
    );
  } catch (e: any) {
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
