// app/api/weather/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { outfitAdvice } from '../lib/weather-advice';

const API = 'https://api.openweathermap.org/data/2.5/weather';
const UNITS = new Set(['standard', 'metric', 'imperial']);

function sanitizeCity(q: string) {
  const ok = q.match(/[\p{L}\p{N}\s,.\-]/gu)?.join('') ?? '';
  return ok.trim().slice(0, 60);
}

function isValidLatLon(lat?: string | null, lon?: string | null) {
  if (!lat || !lon) return false;
  const la = Number(lat);
  const lo = Number(lon);
  return (
    Number.isFinite(la) &&
    Number.isFinite(lo) &&
    la >= -90 &&
    la <= 90 &&
    lo >= -180 &&
    lo <= 180
  );
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const qRaw = searchParams.get('q');
    const q = qRaw ? sanitizeCity(qRaw) : undefined;
    const lat = searchParams.get('lat');
    const lon = searchParams.get('lon');

    const unitsParam = searchParams.get('units') ?? 'metric';
    const units = UNITS.has(unitsParam) ? unitsParam : 'metric';
    const lang = (searchParams.get('lang') ?? 'zh_tw').toLowerCase();

    const KEY = process.env.OPENWEATHER_API_KEY;
    if (!KEY) {
      return NextResponse.json(
        { error: { code: 'CONFIG', message: 'OPENWEATHER_API_KEY missing' } },
        { status: 500 }
      );
    }

    if (!q && !isValidLatLon(lat, lon)) {
      return NextResponse.json(
        { error: { code: 'VALIDATION', message: '需要 q 或有效的 lat+lon' } },
        { status: 400 }
      );
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    const url = new URL(API);
    if (q) url.searchParams.set('q', q);
    if (isValidLatLon(lat, lon)) {
      url.searchParams.set('lat', lat as string);
      url.searchParams.set('lon', lon as string);
    }
    url.searchParams.set('appid', KEY);
    url.searchParams.set('units', units);
    url.searchParams.set('lang', lang);

    const r = await fetch(url, { signal: ctrl.signal, next: { revalidate: 60 } });
    clearTimeout(timer);

    if (!r.ok) {
      return NextResponse.json(
        { error: { code: 'UPSTREAM', message: `OpenWeather ${r.status}` } },
        { status: 502 }
      );
    }

    const data = await r.json();

    const temp = data?.main?.temp;
    const feels = data?.main?.feels_like;
    const wind = data?.wind?.speed;
    const rain = data?.rain?.['1h'] ?? data?.rain?.['3h'];
    const snow = data?.snow?.['1h'] ?? data?.snow?.['3h'];

    const outfit_advice = outfitAdvice({ temp, feels, wind, rain, snow });

    return NextResponse.json(
      { ...data, outfit_advice },
      { headers: { 'Cache-Control': 'private, max-age=60', Vary: 'Accept-Encoding' } }
    );
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return NextResponse.json(
      { error: { code: aborted ? 'TIMEOUT' : 'UNKNOWN', message: e?.message ?? 'error' } },
      { status: aborted ? 504 : 500 }
    );
  }
}
