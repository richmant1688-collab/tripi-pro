
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

type LatLng = { lat: number, lng: number };

const PRESET_POIS: Record<string, {name: string; lat: number; lng: number}[]> = {
  '墾丁': [
    { name: '鵝鑾鼻燈塔', lat: 21.9027, lng: 120.8526 },
    { name: '白沙灣', lat: 21.9562, lng: 120.7393 },
    { name: '墾丁大街', lat: 21.9487, lng: 120.7829 },
    { name: '船帆石', lat: 21.9399, lng: 120.8426 },
    { name: '小灣海水浴場', lat: 21.9466, lng: 120.7816 }
  ],
  '台南': [
    { name: '赤崁樓', lat: 22.9971, lng: 120.2028 },
    { name: '安平古堡', lat: 23.0012, lng: 120.1597 },
    { name: '花園夜市', lat: 22.9997, lng: 120.2122 }
  ],
  '花蓮': [
    { name: '太魯閣國家公園', lat: 24.1577, lng: 121.6219 },
    { name: '七星潭', lat: 24.0302, lng: 121.6271 }
  ]
};

async function geocodeGoogle(query: string): Promise<LatLng & {formatted: string}> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&language=zh-TW&key=${key}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.results?.[0]) throw new Error('geocode_failed');
  const g = j.results[0];
  return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address };
}

async function routeGoogle(origin: string, destination: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=zh-TW&region=tw&mode=driving&key=${key}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK') throw new Error('directions_failed');
  const route = j.routes[0];
  const leg = route.legs[0];
  const coords = polyline.decode(route.overview_polyline.points).map(([lat, lng]) => [lat, lng]);
  return {
    polyline: coords as [number,number][],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text
  };
}

async function placesGoogle(destination: string, lat: number, lng: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const queries = [`${destination} 景點`, `${destination} 海灘`, `${destination} 美食`];
  const results: any[] = [];
  for (const q of queries) {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&location=${lat},${lng}&radius=40000&language=zh-TW&key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    if (Array.isArray(j.results)) results.push(...j.results);
    await new Promise(res => setTimeout(res, 150));
  }
  const byId = new Map<string, any>();
  for (const item of results) {
    if (!item.place_id) continue;
    const score = (item.rating || 0) * (Math.log10((item.user_ratings_total || 1) + 1) + 1);
    const cur = byId.get(item.place_id);
    if (!cur || score > cur.score) byId.set(item.place_id, { ...item, score });
  }
  const sorted = Array.from(byId.values()).sort((a,b) => b.score - a.score).slice(0, 40);
  return sorted.map(p => ({
    name: p.name,
    lat: p.geometry.location.lat,
    lng: p.geometry.location.lng,
    address: p.formatted_address,
    rating: p.rating
  }));
}

async function geocodeOSM(query: string) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'Accept-Language': 'zh-TW' } });
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]) throw new Error('geocode_failed');
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name };
}

async function routeOSRM(origin: {lat:number,lng:number}, dest: {lat:number,lng:number}) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route = j.routes[0];
  const coords = route.geometry.coordinates.map(([lng, lat]: [number,number]) => [lat, lng]);
  return {
    polyline: coords as [number,number][],
    distanceText: (route.distance/1000).toFixed(1)+' km',
    durationText: Math.round(route.duration/60)+' 分鐘'
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      const o = await geocodeGoogle(origin);
      const d = await geocodeGoogle(destination);
      const r = await routeGoogle(origin, destination);
      const pois = await placesGoogle(destination, d.lat, d.lng);

      return NextResponse.json({
        provider: 'google',
        polyline: r.polyline,
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end:   { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois
      });
    } else {
      const o = await geocodeOSM(origin);
      const d = await geocodeOSM(destination);
      const r = await routeOSRM({lat:o.lat, lng:o.lng}, {lat:d.lat, lng:d.lng});
      const preset = PRESET_POIS[destination] || [];
      return NextResponse.json({
        provider: 'osrm',
        polyline: r.polyline,
        start: { lat: o.lat, lng: o.lng, address: o.formatted },
        end:   { lat: d.lat, lng: d.lng, address: d.formatted },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois: preset
      });
    }
  } catch (e: any) {
    return NextResponse.json({ error: 'server_error', detail: e?.message }, { status: 500 });
  }
}
