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
const TYPES = ['tourist_attraction', 'restaurant', 'lodging'] as const;
const TYPE_SET = new Set(TYPES);
const NEAR_EQ_KM = 3; // 起訖≤3km 視為同點

/* ---------------- Utilities ---------------- */

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
  return R * c;
}

function cumulativeLengthKm(path: LatLng[]): number[] {
  const acc: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  }
  return acc;
}

/** 動態等距採樣：以總長約分成 ~15 段，步距限制 20–50km，樣本數上限 24 */
function sampleAlongPathDynamic(path: LatLng[]): LatLng[] {
  if (path.length === 0) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1]; // km
  if (total === 0) return [path[0]];

  const stepKm = Math.max(20, Math.min(50, total / 15));
  const n = Math.min(24, Math.max(2, Math.round(total / stepKm) + 1));
  const samples: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    // 在 cum 中找到第一個 >= target 的點
    let j = 0;
    while (j < cum.length && cum[j] < target) j++;
    if (j === 0) samples.push(path[0]);
    else if (j >= cum.length) samples.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const ratio = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      samples.push({ lat: A.lat + (B.lat - A.lat) * ratio, lng: A.lng + (B.lng - A.lng) * ratio });
    }
  }

  // 相近點去重（<5km 視為重複）
  const dedup: LatLng[] = [];
  for (const p of samples) {
    if (!dedup.some((q) => haversineKm(p, q) < 5)) dedup.push(p);
  }
  return dedup;
}

/** 根據總距離動態決定 radius（5–15km） */
function dynamicRadiusMeters(totalKm: number) {
  const m = Math.round(totalKm * 20) * 1; // 1km ≈ 20m*?（450km→9000m≈9km）
  return Math.min(15000, Math.max(5000, m));
}

/* ---------------- Google APIs ---------------- */

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
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text,
  };
}

async function nearbyAt(center: LatLng, type: (typeof TYPES)[number], radiusM: number, keyword?: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${center.lat},${center.lng}` +
    `&radius=${radiusM}` +
    `&type=${encodeURIComponent(type)}` +
    (keyword ? `&keyword=${encodeURIComponent(keyword)}` : '') +
    `&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return [];
  return Array.isArray(j.results) ? j.results : [];
}

/** 單點模式：以 destination 為中心，多類型 Nearby 合併去重 */
async function placesSingleCenter(center: LatLng, radiusM = 3000): Promise<PlaceOut[]> {
  const byId = new Map<string, { item: PlaceOut; score: number }>();

  for (const t of TYPES) {
    const arr = await nearbyAt(center, t, radiusM);
    for (const p of arr) {
          const id = p.place_id as string | undefined;
          if (!id) continue;
      const rating = p.rating || 0;
      const urt = p.user_ratings_total || 1;
      const pop = Math.log10(urt + 1) + 1;
      const s = rating * pop;
      const item: PlaceOut = {
        name: p.name,
        lat: p.geometry?.location?.lat,
        lng: p.geometry?.location?.lng,
        address: p.vicinity || p.formatted_address,
        rating: p.rating,
        place_id: id,
        _type: t,
      };
          const cur = byId.get(id);
      if (!cur || s > cur.score) byId.set(id, { item, score: s });
    }
    await sleep(120);
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.item);
}

/** 沿途模式：依折線動態等距採樣，對每個採樣點 × 多類型 Nearby，合併/去重/排序 */
async function placesAlongRoute(path: LatLng[]): Promise<PlaceOut[]> {
  if (path.length === 0) return [];
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length - 1]);
  const radiusM = dynamicRadiusMeters(totalKm);

  const byId = new Map<string, { item: PlaceOut; score: number }>();

  for (const s of samples) {
    for (const t of TYPES) {
      const arr = await nearbyAt(s, t, radiusM);
      for (const p of arr) {
        const id = p.place_id as string | undefined;
        if (!id) continue;

        const baseLoc = p.geometry?.location
          ? { lat: p.geometry.location.lat, lng: p.geometry.location.lng }
          : null;
        const distKm = baseLoc ? haversineKm(s, baseLoc) : undefined;

        const rating = p.rating || 0;
        const urt = p.user_ratings_total || 1;
        const pop = Math.log10(urt + 1) + 1;
        const proximity = typeof distKm === 'number' ? 1 / (1 + distKm / 5) : 1; // 5km 半距離
        const sscore = rating * pop * proximity;

        const item: PlaceOut = {
      name: p.name,
          lat: baseLoc?.lat!,
          lng: baseLoc?.lng!,
      address: p.vicinity || p.formatted_address,
    rating: p.rating,
          place_id: id,
          _type: t,
        };

        const cur = byId.get(id);
        if (!cur || sscore > cur.score) byId.set(id, { item, score: sscore });
      }
      await sleep(100); // 輕節流
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.item);
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
      const r = await routeGoogle(origin, destination);

      // 判斷是否「單點」：起訖距離 ≤ NEAR_EQ_KM
      const isSingle =
        haversineKm({ lat: r.start.lat, lng: r.start.lng }, { lat: r.end.lat, lng: r.end.lng }) <= NEAR_EQ_KM;

      let pois: PlaceOut[] = [];
      if (isSingle) {
        // 單點模式：用起點做多類型 Nearby（或用終點都可，差異不大）
        pois = await placesSingleCenter({ lat: r.start.lat, lng: r.start.lng }, 3000);
      } else {
        // 沿途模式：動態採樣 + 多類型 Nearby
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
        { headers: { 'Cache-Control': 'private, max-age=60' } }
      );
    } else {
      // 無 Google Key：使用 OSM/OSRM（本模式不含 Places）
      const o = await geocodeOSM(origin);
      const d = await geocodeOSM(destination);
      const r = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      return NextResponse.json(
        {
          provider: 'osrm',
          polyline: r.polyline.map(({ lat, lng }) => [lat, lng]) as [number, number][],
          start: { lat: o.lat, lng: o.lng, address: o.formatted },
          end: { lat: d.lat, lng: d.lng, address: d.formatted },
          distanceText: r.distanceText,
          durationText: r.durationText,
          pois: [] as PlaceOut[],
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
