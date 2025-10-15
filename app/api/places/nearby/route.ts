// app/api/places/nearby/route.ts
import { NextRequest, NextResponse } from 'next/server';

type NearbyItem = {
  name: string;
  vicinity?: string;
  place_id: string;
  rating?: number;
  user_ratings_total?: number;
  _type: string;
  location?: { lat: number; lng: number };
};

const LANG = 'zh-TW';

function badRequest(detail: string) {
  return NextResponse.json({ error: 'bad_request', detail }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}

async function fetchJson<T = any>(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  const j = (await r.json()) as T;
  return j;
}

export async function GET(req: NextRequest) {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return NextResponse.json(
        { error: 'config_error', detail: 'Missing GOOGLE_MAPS_API_KEY' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { searchParams } = new URL(req.url);
    const loc = searchParams.get('location'); // "lat,lng"
    const radiusStr = searchParams.get('radius'); // meters
    const types = searchParams.getAll('type'); // can repeat
    const keyword = searchParams.get('keyword') || '';

    if (!loc) return badRequest('location is required, e.g. 25.0478,121.5170');
    if (!radiusStr) return badRequest('radius is required');
    if (types.length === 0) return badRequest('at least one type is required');

    const [latStr, lngStr] = loc.split(',');
    const lat = Number(latStr);
    const lng = Number(lngStr);
    const radius = Number(radiusStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return badRequest('invalid location');
    if (!Number.isFinite(radius) || radius <= 0) return badRequest('invalid radius');

    // Nearby Search 只接受單一 type，一次打一種再合併去重
    const results: Array<{ _type: string; data: any[] }> = [];

    for (const t of types) {
      const url =
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
        `?location=${lat},${lng}` +
        `&radius=${radius}` +
        `&type=${encodeURIComponent(t)}` +
        (keyword ? `&keyword=${encodeURIComponent(keyword)}` : '') +
        `&language=${LANG}` +
        `&key=${key}`;

      const j = await fetchJson<any>(url);
      if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
        // 不中斷整體流程，改為部分錯誤時返回空陣列，但保留錯誤資訊於 detail（可視需要改為 throw）
        console.warn('Places Nearby error:', j.status, j.error_message);
        results.push({ _type: t, data: [] });
      } else {
        results.push({ _type: t, data: Array.isArray(j.results) ? j.results : [] });
      }

      // 輕微節流，避免配額壓力
      await new Promise((res) => setTimeout(res, 120));
    }

    // 合併去重，並保留來源 type
    const byId = new Map<string, { item: NearbyItem; score: number }>();
    for (const bucket of results) {
      for (const p of bucket.data) {
        const placeId = p.place_id as string | undefined;
        if (!placeId) continue;
        const score = (p.rating || 0) * (Math.log10((p.user_ratings_total || 1) + 1) + 1);
        const entry: NearbyItem = {
          name: p.name,
          vicinity: p.vicinity,
          place_id: placeId,
          rating: p.rating,
          user_ratings_total: p.user_ratings_total,
          _type: bucket._type,
          location: p.geometry?.location
            ? { lat: p.geometry.location.lat, lng: p.geometry.location.lng }
            : undefined,
        };
        const cur = byId.get(placeId);
        if (!cur || score > cur.score) byId.set(placeId, { item: entry, score });
      }
    }

    const items = Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);

    return NextResponse.json(
      {
        count: items.length,
        items,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
