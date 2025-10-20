// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

type LatLng = { lat: number; lng: number };

type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  place_id?: string;
  _type?: 'tourist_attraction' | 'restaurant' | 'lodging';
};

const LANG = 'zh-TW';
const POI_LIMIT = 40;

// 沿途採樣與搜尋參數
const ALONG_ROUTE_STEP_KM = 25;      // 取樣間距（公里）
const ALONG_ROUTE_MAX_SAMPLES = 12;  // 最多取樣點
const ALONG_RADIUS_M = 5000;         // 每個取樣點搜尋半徑（公尺）
const ALONG_TYPES = ['tourist_attraction', 'restaurant', 'lodging'] as const;

// 預設 POIs（無 Google 金鑰時的後援）
const PRESET_POIS: Record<string, { name: string; lat: number; lng: number }[]> = {
  墾丁: [
    { name: '鵝鑾鼻燈塔', lat: 21.9027, lng: 120.8526 },
    { name: '白沙灣', lat: 21.9562, lng: 120.7393 },
    { name: '墾丁大街', lat: 21.9487, lng: 120.7829 },
    { name: '船帆石', lat: 21.9399, lng: 120.8426 },
    { name: '小灣海水浴場', lat: 21.9466, lng: 120.7816 },
  ],
  台南: [
    { name: '赤崁樓', lat: 22.9971, lng: 120.2028 },
    { name: '安平古堡', lat: 23.0012, lng: 120.1597 },
    { name: '花園夜市', lat: 22.9997, lng: 120.2122 },
  ],
  花蓮: [
    { name: '太魯閣國家公園', lat: 24.1577, lng: 121.6219 },
    { name: '七星潭', lat: 24.0302, lng: 121.6271 },
  ],
};

/* ---------------- Utilities ---------------- */

async function fetchJson<T = any>(url: string) {
  const r = await fetch(url, { cache: 'no-store', headers: { 'Accept-Language': LANG } });
  return (await r.json()) as T;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
  return R * c;
}

// 路徑長度累積
function cumulativeLengthKm(path: LatLng[]): number[] {
  const acc: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  }
  return acc;
}

// 依路線總長等比取樣（頭尾都會包含），避免短段空白
function sampleAlongPath(path: LatLng[], stepKm = ALONG_ROUTE_STEP_KM, maxSamples = ALONG_ROUTE_MAX_SAMPLES): LatLng[] {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  if (total === 0) return [path[0]];

  const n = Math.min(maxSamples, Math.max(2, Math.floor(total / stepKm) + 1));
  const samples: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    let j = 0;
    while (j < cum.length && cum[j] < target) j++;
    if (j === 0) samples.push(path[0]);
    else if (j >= cum.length) samples.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const ratio = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      const A = path[j - 1], B = path[j];
      samples.push({ lat: A.lat + (B.lat - A.lat) * ratio, lng: A.lng + (B.lng - A.lng) * ratio });
    }
  }
  return samples;
}

// 將某個點對應到 polyline 上「最近的頂點索引」：用來排序／分段
function nearestIndexOnPath(p: LatLng, path: LatLng[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = haversineKm(p, path[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
  }
  }
  return best;
}

// 評分（熱門度 × 近路徑程度）
function scorePlace(p: any, distKm?: number) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const proximity = typeof distKm === 'number' ? 1 / (1 + distKm / 5) : 1; // 5km 半距離
  return rating * pop * proximity;
}

/* ---------------- Google：Geocode / Directions ---------------- */

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';

  // 先偏好台灣，沒結果再全域
  const tw = `${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`;
  let j = await fetchJson<any>(tw);
  if (!j.results?.[0]) {
    const global = `${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`;
    j = await fetchJson<any>(global);
  }
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address };
}

async function routeGoogle(origin: string, destination: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${encodeURIComponent(origin)}` +
    `&destination=${encodeURIComponent(destination)}` +
    `&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status !== 'OK' || !j.routes?.[0]) throw new Error(j.error_message || j.status || 'directions_failed');
  const route = j.routes[0];
  const leg = route.legs[0];
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text,
  };
}

/* ---------------- Google：Along-route Places（多類型） ---------------- */

async function nearbyAt(center: LatLng, type: typeof ALONG_TYPES[number]) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${center.lat},${center.lng}` +
    `&radius=${ALONG_RADIUS_M}` +
    `&type=${encodeURIComponent(type)}` +
    `&language=${LANG}` +
    `&key=${key}`;
  return await fetchJson<any>(url);
}

async function placesAlongRoute(path: LatLng[]): Promise<PlaceOut[]> {
  const samples = sampleAlongPath(path);
  const byId = new Map<string, { p: any; score: number; type: PlaceOut['_type'] }>();

  for (const s of samples) {
    for (const t of ALONG_TYPES) {
      const j = await nearbyAt(s, t);
      if (!j || (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS')) {
        // 忽略錯誤，繼續下一筆
      } else {
        for (const p of j.results ?? []) {
          const id = p.place_id as string | undefined;
          if (!id) continue;
          const loc = p.geometry?.location;
          const distKm = loc ? haversineKm({ lat: loc.lat, lng: loc.lng }, s) : undefined;
          const sc = scorePlace(p, distKm);
          const cur = byId.get(id);
          if (!cur || sc > cur.score) byId.set(id, { p, score: sc, type: t });
        }
      }
      await sleep(100); // 輕量節流
    }
  }

  // 轉成輸出格式，並標上 _type
  const arr: PlaceOut[] = Array.from(byId.values()).map(({ p, type }) => ({
      name: p.name,
      lat: p.geometry.location.lat,
      lng: p.geometry.location.lng,
      address: p.vicinity || p.formatted_address,
    rating: p.rating,
      place_id: p.place_id,
      _type: type,
  }));

  // ✅ 智慧排序：依 POI 在 polyline 上「最近索引」排序（確保行進方向一致）
  const withIdx = arr.map((x) => ({ x, idx: nearestIndexOnPath({ lat: x.lat, lng: x.lng }, path) }));
  withIdx.sort((a, b) => a.idx - b.idx);

  // 取前 POI_LIMIT
  return withIdx.slice(0, POI_LIMIT).map((v) => v.x);
}

/* ---------------- OSM / OSRM 後援 ---------------- */

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
    durationText: Math.round(route.duration / 60) + ' 分鐘',
  };
}

/* ---------------- Handler ---------------- */

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
      // 取得路線
      const r = await routeGoogle(origin, destination);

      // 依沿途搜尋多類型地點並排序到行進方向
      let pois = await placesAlongRoute(r.polyline);

      // ✅ 依「路線進度比例」把 POIs 重新「分日排序」後再扁平化（前端可以等分切也會接近）
      const L = r.polyline.length - 1 || 1;
      const poisWithIdx = pois.map((p) => ({
        p,
        idx: nearestIndexOnPath({ lat: p.lat, lng: p.lng }, r.polyline),
      }));
      // dayIndex ∈ [0, days-1]
      for (const it of poisWithIdx) {
        const ratio = it.idx / L;
        (it as any).dayIndex = Math.min(days - 1, Math.max(0, Math.floor(ratio * days)));
      }
      poisWithIdx.sort((a, b) => (a as any).dayIndex - (b as any).dayIndex || a.idx - b.idx);
      pois = poisWithIdx.map((v) => v.p);

      return NextResponse.json(
        {
          provider: 'google',
          polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
          start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
          end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
          distanceText: r.distanceText,
          durationText: r.durationText,
          pois, // 已依行進方向 + 分日順序排好
        },
        { headers: { 'Cache-Control': 'private, max-age=60' } }
      );
    } else {
      // 後援路線（無 Google）
      const o = await geocodeOSM(origin);
      const d = await geocodeOSM(destination);
      const r = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      const preset = PRESET_POIS[destination] || [];
      return NextResponse.json(
        {
          provider: 'osrm',
          polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
          start: { lat: o.lat, lng: o.lng, address: o.formatted },
          end: { lat: d.lat, lng: d.lng, address: d.formatted },
          distanceText: r.distanceText,
          durationText: r.durationText,
          pois: preset,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
