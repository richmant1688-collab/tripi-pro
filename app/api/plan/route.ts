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
  _type: 'tourist_attraction' | 'restaurant' | 'lodging';
};

const LANG = 'zh-TW';

// 起訖同點判定距離（km）
const NEAR_EQ_KM = 3;

// 沿途取樣／搜尋參數
const ALONG_ROUTE_STEP_KM = 20;     // 每 ~20km 取樣一次
const ALONG_ROUTE_MAX_SAMPLES = 12; // 最多 12 個採樣點
const ALONG_ROUTE_RADIUS_M = 5000;  // 每個採樣點搜尋半徑 5km
const POI_LIMIT = 40;               // 回傳 POIs 上限

// OSM 後援的少量預設 POIs（示例）
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

/* ---------------- Utils ---------------- */

async function fetchJson<T = any>(url: string) {
  const r = await fetch(url, { cache: 'no-store', headers: { 'Accept-Language': LANG } });
  return (await r.json()) as T;
}
function sleep(ms: number) { return new Promise((res) => setTimeout(res, ms)); }

function haversineKm(a: LatLng, b: LatLng) {
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

function sampleAlongPath(path: LatLng[], everyKm = ALONG_ROUTE_STEP_KM, maxPoints = ALONG_ROUTE_MAX_SAMPLES): LatLng[] {
  if (!path.length) return [];
  const samples: LatLng[] = [];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = haversineKm(path[i - 1], path[i]);
    acc += seg;
    if (acc >= everyKm) {
      samples.push(path[i]);
      acc = 0;
      if (samples.length >= maxPoints) break;
    }
  }
  if (samples.length === 0) {
    samples.push(path[Math.floor(path.length / 2)]);
  } else {
    samples.unshift(path[0]);
    samples.push(path[path.length - 1]);
  }
  // 相近點去重（5km 內視為同點）
  const dedup: LatLng[] = [];
  for (const p of samples) {
    if (!dedup.some((q) => haversineKm(p, q) < 5)) dedup.push(p);
  }
  return dedup.slice(0, maxPoints);
}

function scorePlace(p: any, distKm?: number) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const proximity = typeof distKm === 'number' ? 1 / (1 + distKm / 5) : 1; // 5km 半距離
  return rating * pop * proximity;
}

/* ---------------- Google Geocode / Directions ---------------- */

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
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
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]) => ({ lat, lng }));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text,
  };
}

/* ---------------- Places：單點模式（目的地周邊） ---------------- */

async function placesAtDestination(destination: string, lat: number, lng: number): Promise<PlaceOut[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const queries = [`${destination} 景點`, `${destination} 海灘`, `${destination} 美食`];
  const results: any[] = [];

  for (const q of queries) {
    const url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(q)}` +
      `&location=${lat},${lng}` +
      `&radius=40000` +
      `&language=${LANG}` +
      `&key=${key}`;

    const j = await fetchJson<any>(url);
    if (!j.status || j.status === 'OK' || j.status === 'ZERO_RESULTS') {
    if (Array.isArray(j.results)) results.push(...j.results);
    }
    await sleep(120);
  }

  const byId = new Map<string, { p: any; score: number }>();
  for (const item of results) {
    const id = item.place_id as string | undefined;
    if (!id) continue;
    const sc = scorePlace(item);
    const cur = byId.get(id);
    if (!cur || sc > cur.score) byId.set(id, { p: item, score: sc });
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, POI_LIMIT)
    .map(({ p }) => ({
    name: p.name,
    lat: p.geometry.location.lat,
    lng: p.geometry.location.lng,
      address: p.formatted_address || p.vicinity,
      rating: p.rating,
      place_id: p.place_id,
      _type: 'tourist_attraction', // 單點模式：預設景點徽章
    }));
}

/* ---------------- Places：沿途多點（景點＋餐廳＋住宿） ---------------- */

const ALONG_TYPES: PlaceOut['_type'][] = ['tourist_attraction', 'restaurant', 'lodging'];

async function nearbyAt(center: LatLng, type: PlaceOut['_type']) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${center.lat},${center.lng}` +
    `&radius=${ALONG_ROUTE_RADIUS_M}` +
    `&type=${type}` +
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
      if (!j.status || j.status === 'OK' || j.status === 'ZERO_RESULTS') {
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
      await sleep(100); // 輕節流
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, POI_LIMIT)
    .map(({ p, type }) => ({
      name: p.name,
      lat: p.geometry.location.lat,
      lng: p.geometry.location.lng,
      address: p.vicinity || p.formatted_address,
    rating: p.rating,
      place_id: p.place_id,
      _type: type,
  }));
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
      // Google 路線
      const r = await routeGoogle(origin, destination);

      // 判斷是否單點（<= NEAR_EQ_KM）
      const isSingle =
        haversineKm({ lat: r.start.lat, lng: r.start.lng }, { lat: r.end.lat, lng: r.end.lng }) <= NEAR_EQ_KM;

      let pois: PlaceOut[];
      if (isSingle) {
        const d = await geocodeGoogle(destination);
        pois = await placesAtDestination(destination, d.lat, d.lng);
      } else {
        pois = await placesAlongRoute(r.polyline);
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
        },
        { headers: { 'Cache-Control': 'private, max-age:60' } }
      );
    } else {
      // OSM/OSRM 後援
      const o = await geocodeOSM(origin);
      const d = await geocodeOSM(destination);
      const r = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      const preset: PlaceOut[] = (PRESET_POIS[destination] || []).map((p) => ({
        ...p,
        _type: 'tourist_attraction',
      }));

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
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
