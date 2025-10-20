// app/api/forecast/route.ts
return NextResponse.json({ error: { code: 'VALIDATION', message: '需要 q 或有效的 lat+lon' } }, { status: 400 });
}


const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 8000);


const url = new URL(API);
if (q) url.searchParams.set('q', q);
if (isValidLatLon(lat, lon)) { url.searchParams.set('lat', lat as string); url.searchParams.set('lon', lon as string); }
url.searchParams.set('appid', KEY);
url.searchParams.set('units', units);
url.searchParams.set('lang', lang);


const r = await fetch(url, { signal: ctrl.signal, next: { revalidate: 600 } });
clearTimeout(timer);


if (!r.ok) {
return NextResponse.json({ error: { code: 'UPSTREAM', message: `OpenWeather ${r.status}` } }, { status: 502 });
}


const data = await r.json();


const list = Array.isArray(data?.list) ? data.list.map((it: any) => {
const temp = it?.main?.temp;
const feels = it?.main?.feels_like ?? it?.main?.feels;
const wind = it?.wind?.speed;
const rain = it?.rain?.['1h'] ?? it?.rain?.['3h'];
const snow = it?.snow?.['1h'] ?? it?.snow?.['3h'];
const advice = outfitAdvice({ temp, feels, wind, rain, snow });
return { ...it, tripi: { ...(it.tripi ?? {}), outfit_advice: advice } };
}) : [];


return NextResponse.json(
{ ...data, list },
{ headers: { 'Cache-Control': 'private, max-age=600', 'Vary': 'Accept-Encoding' } }
);
} catch (e: any) {
const aborted = e?.name === 'AbortError';
return NextResponse.json({ error: { code: aborted ? 'TIMEOUT' : 'UNKNOWN', message: e?.message ?? 'error' } }, { status: aborted ? 504 : 500 });
}
}