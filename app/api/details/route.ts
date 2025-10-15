// app/api/places/details/route.ts
import { NextRequest, NextResponse } from 'next/server';

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
    const placeId = searchParams.get('place_id');
    if (!placeId) return badRequest('place_id is required');

    const fields = [
      'name',
      'website',
      'formatted_phone_number',
      'formatted_address',
      'rating',
      'user_ratings_total',
      'opening_hours',
      'geometry/location',
      'url',
    ].join(',');

    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&language=${LANG}` +
      `&key=${key}`;

    const j = await fetchJson<any>(url);
    if (j.status && j.status !== 'OK') {
      return NextResponse.json(
        { error: 'upstream_error', detail: j.error_message || j.status },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const r = j.result || {};
    return NextResponse.json(
      {
        name: r.name,
        website: r.website,
        formatted_phone_number: r.formatted_phone_number,
        formatted_address: r.formatted_address,
        rating: r.rating,
        user_ratings_total: r.user_ratings_total,
        opening_hours: r.opening_hours,
        geometry: r.geometry,
        url: r.url,
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
