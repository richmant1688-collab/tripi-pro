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
  __progress?: number;    // ← 折線索引：沿路「前進程度」用來切天
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

/* ---------------- Utils ---------------- */

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

/** 反向地理：回傳「縣市」與「區」；避免只拿到「台灣」 */
async function reverseCity(lat:number,lng:number): Promise<{ city?: string; district?: string }> {
  try {
    const key=process.env.GOOGLE_MAPS_API_KEY!;
    const url=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
    const j=await fetchJson<any>(url);
    const comps: any[] = j.results?.[0]?.address_components || [];

    const has = (t: string) => (c:any) => c.types?.includes(t);
    const get = (t: string) => comps.find(has(t))?.long_name;

    // 台灣常見：level_2 是「台北市/新北市/桃園市…」，有時 locality 也會是縣市
    const level1 = get('administrative_area_level_1'); // 可能是「台灣」
    const level2 = get('administrative_area_level_2') || get('locality') || get('postal_town');
    const level3 = get('administrative_area_level_3');
    const subloc = comps.find((c:any)=> String(c.types).includes('sublocality_level_1'))?.long_name;

    const city = (level2 && level2 !== '台灣') ? level2 : (level1 && level1 !== '台灣' ? level1 : undefined);
    const district = subloc || level3;

    return { city, district };
  } catch { return {}; }
}

/** 永遠把「縣市」前置；如果地址只有區名，也會加上縣市，不重複 */
function prefixCityToAddress(addr: string | undefined, city?: string, district?: string) {
  if (!city && !district) return addr;
  const safe = (addr || '').replace(/^台灣[,\s]*/,'').replace(/^臺灣[,\s]*/,'');
  const hasCity = city ? safe.includes(city) : false;
  const hasDistrict = district ? safe.includes(district) : false;

  // 如果已經含有縣市就不重複；若只有區名，仍需補上縣市
  if (hasCity) return safe || city;
  const parts = [city, hasDistrict ? undefined : district].filter(Boolean) as string[];
  const prefix = parts.join(' ');
  return safe ? `${prefix} · ${safe}` : prefix;
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

/** 類型正規化 */
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

/** 單點：多類型 Nearby */
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

/* ---------------- 旅行社風格（進度導向切天） ---------------- */

function buildAgencyStyleItineraryProgressive(allPois: PlaceOut[], days: number): DaySlot[] {
  // 類型保險正規化
  const pois = allPois.map(p => ({ ...p, _type: normalizeType(p._type as any) }));

  // 把景點（非餐廳/住宿）拿來當骨架，並依 __progress 排序
  const attractions = pois
    .filter(p => p._type !== 'restaurant' && p._type !== 'lodging')
    .sort((a,b) => (a.__progress ?? 0) - (b.__progress ?? 0));

  const restaurants = pois.filter(p => p._type === 'restaurant');
  const lodgings   = pois.filter(p => p._type === 'lodging');

  // 準備行程容器
  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));
  const used = new Set<string>();
  const key = (p: PlaceOut) => (p.place_id || p.name) + `@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

  const maxProgress = Math.max(...attractions.map(a => a.__progress ?? 0), 0) || 1;

  // 依天挑選：每一天有一個 targetProgress，逐步擴大視窗直到湊到 2+2
  for (let d = 0; d < days; d++) {
    const target = Math.round(((d + 0.5) / days) * maxProgress);
    const wantMorning = 2, wantAfternoon = 2;

    let window = Math.round(maxProgress * 0.03) || 3; // 初始 ±3% 進度
    const pickFrom = (arr: PlaceOut[], count: number) => {
      const picked: PlaceOut[] = [];
      for (const p of arr) {
        if (picked.length >= count) break;
        if (used.has(key(p))) continue;
        picked.push(p); used.add(key(p));
  }
      return picked;
    };

    // 以 targetProgress 由近到遠擴大挑選
    let candidates: PlaceOut[] = [];
    while ((candidates.length < wantMorning + wantAfternoon) && window <= maxProgress) {
      const low = target - window, high = target + window;
      candidates = attractions
        .filter(p => !used.has(key(p)))
        .map(p => [p, Math.abs((p.__progress ?? 0) - target)] as const)
        .filter(([p,_dist]) => (p.__progress ?? 0) >= low && (p.__progress ?? 0) <= high)
        .sort((a,b) => a[1] - b[1])
        .map(([p]) => p);
      window = Math.round(window * 1.8) + 2; // 擴大
    }

    // 若仍不足，從未用過的 attractions 由 target 距離近者補
    if (candidates.length < wantMorning + wantAfternoon) {
      const fallback = attractions
        .filter(p => !used.has(key(p)))
        .map(p => [p, Math.abs((p.__progress ?? 0) - target)] as const)
        .sort((a,b) => a[1] - b[1])
        .map(([p]) => p);
      candidates = [...candidates, ...fallback].slice(0, wantMorning + wantAfternoon);
    }

    itinerary[d].morning = pickFrom(candidates, wantMorning);
    itinerary[d].afternoon = pickFrom(candidates.filter(p => !used.has(key(p))), wantAfternoon);

    // 餐廳：當天幾何中心附近
    const dayPts = [...itinerary[d].morning, ...itinerary[d].afternoon];
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

    // 住宿：靠近下午最後一個點，否則上午最後一個點
    const anchor = itinerary[d].afternoon[itinerary[d].afternoon.length-1] || itinerary[d].morning[itinerary[d].morning.length-1];
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

  // 最後保底：若某天上午/下午為空，從全體 attractions 補
  const remain = attractions.filter(p => !used.has(key(p)));
  for (let d = 0; d < days; d++) {
    const slots = itinerary[d];
    const fill = (arr: PlaceOut[], need: number) => {
      while (arr.length < need && remain.length) {
        const p = remain.shift()!;
        arr.push(p); used.add(key(p));
      }
    };
    fill(slots.morning, 1);
    fill(slots.afternoon, 1);
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

/* ---------------- Handler ---------------- */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json({ error:'bad_request', detail:'origin/destination required' }, { status:400, headers:{'Cache-Control':'no-store'} });
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

      // 旅行社風格（進度導向）
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
        pois,
        itinerary,
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });

    } else {
      const o=await geocodeOSM(origin), d=await geocodeOSM(destination);
      const ro=await routeOSRM({lat:o.lat,lng:o.lng},{lat:d.lat,lng:d.lng});
      return NextResponse.json({
        provider:'osrm',
        polyline: ro.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start:{lat:o.lat,lng:o.lng, address:o.formatted},
        end:{lat:d.lat,lng:d.lng, address:d.formatted},
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois:[], itinerary:[],
      }, { headers:{'Cache-Control':'no-store'} });
    }
  } catch (e:any) {
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json({ error:'server_error', detail:e?.message||'Unknown error' }, { status, headers:{'Cache-Control':'no-store'} });
  }
}
