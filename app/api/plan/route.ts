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
  city?: string;          // 反向地理後的人類可讀（ex: 台北市 信義區）
  __progress?: number;    // 折線上的索引（代表沿路「前進程度」）
};

type DaySlot = {
  morning: PlaceOut[];  // 景點 1–2
  lunch?: PlaceOut;     // 餐廳 1
  afternoon: PlaceOut[];// 景點 1–2
  lodging?: PlaceOut;   // 住宿 1
};

const LANG = 'zh-TW';
const SEARCH_TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3;

/* ---------------- Common Utils ---------------- */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI/180;
  const dLng = (b.lng - a.lng) * Math.PI/180;
  const la1 = a.lat * Math.PI/180;
  const la2 = b.lat * Math.PI/180;
  const s1 = Math.sin(dLat/2);
  const s2 = Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(s1*s1 + Math.cos(la1)*Math.cos(la2)*s2*s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i=1;i<path.length;i++) acc.push(acc[i-1] + haversineKm(path[i-1], path[i]));
  return acc;
}

/** 沿途動態取樣（依總長度決定點數；並做 5km 去重） */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length-1];
  if (total === 0) return [path[0]];

  // 每 30–60km 取一點，至少 3 點，至多 28 點
  const step = Math.max(30, Math.min(60, total/12));
  const n = Math.min(28, Math.max(3, Math.round(total/step)+1));

  const out: LatLng[] = [];
  for (let i=0;i<n;i++) {
    const target = (i/(n-1))*total;
    let j=0;
    while (j<cum.length && cum[j] < target) j++;
    if (j===0) out.push(path[0]);
    else if (j>=cum.length) out.push(path[path.length-1]);
    else {
      const t0 = cum[j-1], t1 = cum[j];
      const A = path[j-1], B = path[j];
      const r = t1===t0 ? 0 : (target - t0)/(t1 - t0);
      out.push({ lat: A.lat + (B.lat-A.lat)*r, lng: A.lng + (B.lng-A.lng)*r });
    }
  }
  // 5km 去重
  const dedup: LatLng[] = [];
  for (const p of out) if (!dedup.some(q => haversineKm(p,q) < 5)) dedup.push(p);
  return dedup;
}

/** 依總長抓搜尋半徑（公尺） */
function dynamicRadiusMeters(totalKm: number) {
  return Math.min(15000, Math.max(3000, Math.round(totalKm*18)));
}

/* ---------------- Geocoding / Directions ---------------- */

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base='https://maps.googleapis.com/maps/api/geocode/json';
  let j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g = j.results[0];
  return { lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address };
}

async function routeGoogle(origin: string, destination: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status!=='OK' || !j.routes?.[0]) throw new Error(j.error_message||j.status||'directions_failed');
  const route=j.routes[0], leg=route.legs[0];
  const coords=polyline.decode(route.overview_polyline.points).map(([lat,lng]:[number,number])=>({lat,lng}));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text,
  };
}

/** 反向地理：穩定抓到「縣市 + 區」；若第一筆不足，再看下一筆 */
async function reverseCity(lat:number,lng:number): Promise<{ city?: string; district?: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;

  const pickCityDistrict = (comps: any[]) => {
    const has = (t:string) => (c:any) => c.types?.includes(t);
    const get = (t:string) => comps.find(has(t))?.long_name;

    // 台灣：level_2 通常是「台北市/新北市/桃園市/…」
    const lvl1 = get('administrative_area_level_1'); // 有時會是「台灣」
    const lvl2 = get('administrative_area_level_2') || get('locality') || get('postal_town');
    const lvl3 = get('administrative_area_level_3');
    const subl = comps.find((c:any)=> String(c.types).includes('sublocality_level_1'))?.long_name;

    const city = (lvl2 && lvl2 !== '台灣') ? lvl2 : (lvl1 && lvl1 !== '台灣' ? lvl1 : undefined);
    const district = subl || lvl3;
    return { city, district };
  };

  try {
    const j = await fetchJson<any>(url);
    const results: any[] = j.results || [];
    for (let i=0; i<Math.min(3, results.length); i++) {
      const { city, district } = pickCityDistrict(results[i]?.address_components || []);
      if (city || district) return { city, district };
    }
    return {};
  } catch { return {}; }
}

/** 永遠把「縣市」前置；若原地址只有區名，會補上縣市，不重複 */
function prefixCityToAddress(addr: string | undefined, city?: string, district?: string) {
  if (!city && !district) return addr;
  const raw = (addr || '').replace(/^[臺台]灣[,\s]*/,'');
  const hasCity = city ? raw.includes(city) : false;
  const hasDistrict = district ? raw.includes(district) : false;

  if (hasCity && hasDistrict) return raw;           // 已完整，直接用
  if (hasCity && !hasDistrict) return raw;          // 已含縣市，不強加區名
  // 沒有縣市 → 必補；區名若已含就不再重複
  const parts = [city, hasDistrict ? undefined : district].filter(Boolean) as string[];
  const prefix = parts.join(' ');
  return raw ? `${prefix} · ${raw}` : prefix;
}

/* ---------------- Google Places ---------------- */

async function nearby(center:LatLng, type:PlaceType, radiusM:number) {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${center.lat},${center.lng}&radius=${radiusM}&type=${encodeURIComponent(type)}&language=${LANG}&key=${key}`;
  const j=await fetchJson<any>(url);
  if (j.status && j.status!=='OK' && j.status!=='ZERO_RESULTS') return [];
  return Array.isArray(j.results)? j.results : [];
}

function scorePlace(p:any, distKm?:number) {
  const rating=p.rating||0, urt=p.user_ratings_total||1;
  const pop=Math.log10(urt+1)+1;
  const prox= typeof distKm==='number' ? 1/(1+distKm/5) : 1;
  return rating*pop*prox;
}

/** 將 Google types 正規化成我們三類 */
function normalizeType(raw: string | undefined): PlaceType {
  if (!raw) return 'tourist_attraction';
  const t = raw.toLowerCase();
  if (t.includes('restaurant') || t==='food' || t==='meal_takeaway' || t==='meal_delivery') return 'restaurant';
  if (t.includes('lodging') || t.includes('hotel') || t.includes('motel') || t.includes('guest_house') || t.includes('hostel')) return 'lodging';
  const attractionAliases = [
    'tourist_attraction','point_of_interest','aquarium','zoo','museum','park','amusement_park',
    'natural_feature','art_gallery','church','temple','mosque','synagogue','beach','campground',
    'shopping_mall','library','stadium','university'
  ];
  if (attractionAliases.some(k => t.includes(k))) return 'tourist_attraction';

  return 'tourist_attraction';
}

/** 沿途：多類型合併，回傳附帶 place_id/_type/__progress */
async function placesAlongRoute(path:LatLng[]): Promise<PlaceOut[]> {
  const samples=sampleAlongPathDynamic(path);
  const totalKm=haversineKm(path[0], path[path.length-1]);
  const radius=dynamicRadiusMeters(totalKm);
  const byId=new Map<string,{item:PlaceOut,score:number,progress:number}>();

  const progressOf = (pt:LatLng) => {
    let best = Infinity, bi = 0;
    for (let i=0;i<path.length;i++){
      const d = haversineKm(pt, path[i]);
      if (d < best){ best = d; bi = i; }
    }
    return bi;
        };

  for (const s of samples){
    for (const t of SEARCH_TYPES){
      const arr=await nearby(s, t, radius);
      for (const p of arr){
        const id = p.place_id as string|undefined; if (!id) continue;
        const loc:LatLng={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
        const dist=haversineKm(s, loc);
        const sc=scorePlace(p, dist);
        const rawType: string | undefined = (Array.isArray(p.types) && p.types.length ? p.types[0] : undefined) || t;
        const pr=progressOf(loc);
        const item:PlaceOut={
          name:p.name, lat:loc.lat, lng:loc.lng,
          address:p.vicinity||p.formatted_address,
          rating:p.rating, place_id:id,
          _type: normalizeType(rawType),
          __progress: pr,
        };
        const cur=byId.get(id);
        if (!cur || sc>cur.score) byId.set(id, { item, score: sc, progress: pr });
      }
      await sleep(60);
    }
  }

  return Array.from(byId.values())
    .sort((a,b)=> a.progress - b.progress || b.score - a.score)
    .map(x=>x.item);
}

/** 單點：多類型 Nearby（起終點接近時使用） */
async function placesSingleCenter(center:LatLng): Promise<PlaceOut[]> {
  const byId=new Map<string,{item:PlaceOut,score:number}>();
  for (const t of SEARCH_TYPES){
    const arr=await nearby(center, t, 3000);
    for (const p of arr){
      const id=p.place_id as string|undefined; if (!id) continue;
      const loc={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
      const sc=scorePlace(p);
      const rawType: string | undefined = (Array.isArray(p.types) && p.types.length ? p.types[0] : undefined) || t;
      const item:PlaceOut={
        name:p.name, lat:loc.lat, lng:loc.lng,
        address:p.vicinity||p.formatted_address,
        rating:p.rating, place_id:id,
        _type: normalizeType(rawType),
        __progress: 0,
  };
      const cur=byId.get(id); if (!cur || sc>cur.score) byId.set(id,{item,score:sc});
    }
    await sleep(60);
  }
  return Array.from(byId.values()).sort((a,b)=>b.score-a.score).map(x=>x.item);
}

/* ---------------- 旅行社風格（進度導向切天：單向往南） ---------------- */

function buildAgencyStyleItineraryProgressive(allPois: PlaceOut[], days: number): DaySlot[] {
  const pois = allPois.map(p => ({ ...p, _type: normalizeType(p._type as any) }));
  const attractions = pois
    .filter(p => p._type !== 'restaurant' && p._type !== 'lodging')
    .sort((a,b) => (a.__progress ?? 0) - (b.__progress ?? 0));

  const restaurants = pois.filter(p => p._type === 'restaurant');
  const lodgings   = pois.filter(p => p._type === 'lodging');

  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));
  const used = new Set<string>();
  const key = (p: PlaceOut) => (p.place_id || p.name) + `@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

  const maxProgress = Math.max(...attractions.map(a => a.__progress ?? 0), 1);
  let cursor = -1; // 每天從 cursor 後面往南挑，保證不回頭

  const takeNear = (list: PlaceOut[], centerProg: number, count: number) => {
    const cand = list
        .filter(p => !used.has(key(p)))
      .map(p => [p, Math.abs((p.__progress ?? 0) - centerProg)] as const)
        .sort((a,b) => a[1] - b[1])
        .map(([p]) => p);
    const out: PlaceOut[] = [];
    for (const p of cand) {
      if (out.length >= count) break;
      out.push(p); used.add(key(p));
    }
    return out;
  };

  for (let d = 0; d < days; d++) {
    // 目標進度：均分整段；最後一天提高到 92% 以後，逼近終點
    const target = d === days-1 ? Math.round(maxProgress * 0.92)
                                : Math.round(((d + 0.6) / days) * maxProgress);

    // 只從「比 cursor 大」的景點挑，避免回頭
    const forward = attractions.filter(p => (p.__progress ?? 0) > cursor);
    // 初始窗口（±3% 長度），不足則擴窗
    let window = Math.max(3, Math.round(maxProgress * 0.03));
    let pool: PlaceOut[] = [];
    while (pool.length < 4 && window <= Math.round(maxProgress*0.5)) {
      const low = target - window, high = target + window;
      pool = forward
        .filter(p => !used.has(key(p)) && (p.__progress ?? 0) >= low && (p.__progress ?? 0) <= high)
        .sort((a,b) => Math.abs((a.__progress ?? 0)-target) - Math.abs((b.__progress ?? 0)-target));
      window = Math.round(window * 1.8) + 2;
    }
    // 還是不夠就直接取「cursor 後面最近的」補滿
    if (pool.length < 4) {
      const tail = forward
        .filter(p => !used.has(key(p)))
        .sort((a,b) => (a.__progress ?? 0) - (b.__progress ?? 0));
      pool = [...pool, ...tail].slice(0, 6);
    }

    // 挑上午 1–2、下午 1–2（優先靠近 target）
    const morning = takeNear(pool, target, 2);
    const afterPool = pool.filter(p => !used.has(key(p)));
    const afternoon = takeNear(afterPool, (morning[morning.length-1]?.__progress ?? target)+1, 2);

    itinerary[d].morning = morning;
    itinerary[d].afternoon = afternoon;

    // 更新 cursor（當日最後一個點的 progress）
    const last = afternoon[afternoon.length-1] || morning[morning.length-1];
    if (last && typeof last.__progress === 'number') cursor = Math.max(cursor, last.__progress!);

    // 餐廳：當日幾何中心附近
    const dayPts = [...morning, ...afternoon];
    if (dayPts.length) {
      const cx = dayPts.reduce((s,p)=>s+p.lat,0)/dayPts.length;
      const cy = dayPts.reduce((s,p)=>s+p.lng,0)/dayPts.length;
      let bestR: PlaceOut | undefined, bsR = -1;
      const rPool = restaurants.length ? restaurants : pois.filter(p => p._type !== 'lodging');
      for (const r of rPool) {
        const sc = (r.rating || 0) / (1 + haversineKm({lat:cx,lng:cy}, {lat:r.lat,lng:r.lng})/5);
        if (sc > bsR && !used.has(key(r))) { bsR = sc; bestR = r; }
      }
      if (bestR) { itinerary[d].lunch = bestR; used.add(key(bestR)); }
    }

    // 住宿：靠近下午最後一個點
    const anchor = afternoon[afternoon.length-1] || morning[morning.length-1];
    if (anchor) {
      let bestH: PlaceOut | undefined, bsH = -1;
      const hPool = lodgings.length ? lodgings : pois.filter(p => p._type !== 'restaurant');
      for (const h of hPool) {
        const sc = (h.rating || 0) / (1 + haversineKm({lat:anchor.lat,lng:anchor.lng}, {lat:h.lat,lng:h.lng})/5);
        if (sc > bsH && !used.has(key(h))) { bsH = sc; bestH = h; }
      }
      if (bestH) { itinerary[d].lodging = bestH; used.add(key(bestH)); }
    }
  }

  return itinerary;
}

/* ---------------- OSM/OSRM fallback ---------------- */

async function geocodeOSM(query: string) {
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r=await fetch(url,{ headers:{'Accept-Language':LANG}, cache:'no-store'});
  const j=await r.json();
  if (!Array.isArray(j)||!j[0]) throw new Error('geocode_failed');
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name };
}
async function routeOSRM(origin:LatLng, dest:LatLng){
  const url=`https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j=await fetchJson<any>(url);
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route=j.routes[0];
  const coords=route.geometry.coordinates.map(([lng,lat]:[number,number])=>({lat,lng}));
  return {
    polyline: coords as LatLng[],
    distanceText:(route.distance/1000).toFixed(1)+' km',
    durationText: Math.round(route.duration/60)+' 分鐘'
  };
}

/* ---------------- API Handler ---------------- */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json(
        { error:'bad_request', detail:'origin/destination required' },
        { status:400, headers:{ 'Cache-Control':'no-store' } }
      );
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      const r = await routeGoogle(origin, destination);
      const startLL={lat:r.start.lat,lng:r.start.lng}, endLL={lat:r.end.lat,lng:r.end.lng};
      const isSingle = haversineKm(startLL,endLL) <= NEAR_EQ_KM;

      // 撈 POIs
      let pois: PlaceOut[] = [];
      if (isSingle) {
        pois = await placesSingleCenter(startLL);
      } else {
        const along = await placesAlongRoute(r.polyline);
        pois = along.slice(0, 120); // 多留一些給切天挑選
      }

      // 旅行社風格（進度導向，單向往南）
      const itinerary = buildAgencyStyleItineraryProgressive(pois, days);

      // 只對「入選的點」做反向地理 + 前置縣市
      const chosen = new Set<string>();
      itinerary.forEach(d=>{
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{
          if (p?.place_id) chosen.add(p.place_id);
      });
      });

      for (const p of pois) {
        if (!p.place_id || !chosen.has(p.place_id)) continue;
        try {
          const loc = await reverseCity(p.lat, p.lng);
          p.city = [loc.city, loc.district].filter(Boolean).join(' ');
          p.address = prefixCityToAddress(p.address, loc.city, loc.district);
          await sleep(35);
        } catch {}
      }

      return NextResponse.json({
        provider: 'google',
        polyline: r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
        end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,            // 扁平池（仍保留，前端若要散點可用）
        itinerary,       // ✅ 旅行社風格（早/午/晚 + 餐廳/住宿）
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });

    } else {
      // 無 Google Key：回傳最小可視化資訊
      const o=await geocodeOSM(origin), d=await geocodeOSM(destination);
      const ro=await routeOSRM({lat:o.lat,lng:o.lng},{lat:d.lat,lng:d.lng});
      return NextResponse.json({
        provider:'osrm',
        polyline: ro.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start:{lat:o.lat,lng:o.lng, address:o.formatted},
        end:{lat:d.lat,lng:d.lng, address:d.formatted},
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois:[], itinerary:[],
      }, { headers:{ 'Cache-Control':'no-store' } });
    }
  } catch (e:any) {
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json(
      { error:'server_error', detail:e?.message||'Unknown error' },
      { status, headers:{ 'Cache-Control':'no-store' } }
    );
  }
}
