// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/* ===========================
   Types
=========================== */
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
  city?: string;
  district?: string;
  __progress?: number; // 以「沿路進度」做排序與切段
};

type DaySlot = {
  morning: PlaceOut[]; // 1–2
  lunch?: PlaceOut;    // 1
  afternoon: PlaceOut[]; // 1–2
  lodging?: PlaceOut;  // 1
};

type GoogleDir = {
  polyline: LatLng[];
  start: { lat:number; lng:number; address:string };
  end:   { lat:number; lng:number; address:string };
  distanceText: string;
  durationText: string;
};

const LANG = 'zh-TW';
const GOOGLE_BASES = {
  directions: 'https://maps.googleapis.com/maps/api/directions/json',
  geocode:    'https://maps.googleapis.com/maps/api/geocode/json',
  nearby:     'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
  details:    'https://maps.googleapis.com/maps/api/place/details/json',
};

// 景點類型（輪詢），加大南部命中率
const ATTRACTION_TYPES = [
  'tourist_attraction','park','museum','aquarium','zoo','amusement_park','art_gallery',
  'church','hindu_temple','mosque','synagogue','campground','library','stadium',
  'shopping_mall','university','natural_feature'
] as const;

const SEARCH_TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];

// 進度窗緩衝（僅向前擴）
const PROG_BACK = 0.00; // 當日下界不回頭
const PROG_FWD  = 0.06; // 當日上界微放寬
const LAST_DAY_MIN = 0.96; // 最後一天至少到全路線 96%

/* ===========================
   Utils
=========================== */
function sleep(ms:number){ return new Promise(res=>setTimeout(res,ms)); }

async function fetchJson<T=any>(url:string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function haversineKm(a:LatLng,b:LatLng){
  const R=6371;
  const dLat=(b.lat-a.lat)*Math.PI/180;
  const dLng=(b.lng-a.lng)*Math.PI/180;
  const la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(s1*s1 + Math.cos(la1)*Math.cos(la2)*s2*s2));
}

function cumulativeLengthKm(path:LatLng[]){
  const acc=[0];
  for(let i=1;i<path.length;i++) acc.push(acc[i-1]+haversineKm(path[i-1],path[i]));
  return acc;
}

function normalizeZhTW(s?: string){
  if(!s) return s;
  return s.replace(/区/g,'區').replace(/臺/g,'台').replace(/桃园/g,'桃園').replace(/台北市/g,'台北市');
}

// 台灣行政區白名單（關鍵字包含即可）
const TAIWAN_CITY_SUFFIX = /[市縣]$/;
const KNOWN_CITIES = [
  '台北市','新北市','桃園市','台中市','台南市','高雄市',
  '基隆市','新竹市','嘉義市',
  '新竹縣','苗栗縣','彰化縣','南投縣','雲林縣','嘉義縣','屏東縣',
  '宜蘭縣','花蓮縣','台東縣','金門縣','連江縣','澎湖縣'
];

function looksLikeCity(s?:string){
  if(!s) return false;
  const n = normalizeZhTW(s);
  if (KNOWN_CITIES.includes(n)) return true;
  return TAIWAN_CITY_SUFFIX.test(n);
}

/* ===========================
   Google helpers
=========================== */
async function geocodeGoogle(query: string){
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const u1=`${GOOGLE_BASES.geocode}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`;
  let j:any = await fetchJson(u1).catch(()=>null);
  if (!j?.results?.[0]) {
    const u2=`${GOOGLE_BASES.geocode}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`;
    j = await fetchJson(u2);
  }
  if (!j.results?.[0]) throw new Error(j?.error_message || 'geocode_failed');
  const g=j.results[0];
  return {
    lat: g.geometry.location.lat,
    lng: g.geometry.location.lng,
    formatted: g.formatted_address
  };
}

async function reverseCity(lat:number,lng:number): Promise<{ city?: string; district?: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `${GOOGLE_BASES.geocode}?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  try{
    const data:any = await fetchJson(url);
    const results:any[] = data.results || [];
    const pick = (comps:any[])=>{
      const get = (t:string)=> comps.find((c:any)=>Array.isArray(c.types)&&c.types.includes(t))?.long_name as string|undefined;
      let city = get('administrative_area_level_2') || get('locality') || get('postal_town');
      const lvl1 = get('administrative_area_level_1');
      if ((!city || /台灣|臺灣/i.test(city)) && lvl1 && looksLikeCity(lvl1)) city = lvl1;
      if (!city) {
        const cand = comps.find((c:any)=> typeof c.long_name==='string' && looksLikeCity(c.long_name));
        if (cand) city = cand.long_name;
      }
    const subl = comps.find((c:any)=> String(c.types).includes('sublocality_level_1'))?.long_name;
      let district = subl || get('administrative_area_level_3');
      if (!district) {
        const dCand = comps.find((c:any)=> typeof c.long_name==='string' && /[區鄉鎮市]$/.test(c.long_name));
        if (dCand) district = dCand.long_name;
      }
      return { city: normalizeZhTW(city && city!=='台灣'?city:undefined), district: normalizeZhTW(district) };
  };
    for (let i=0;i<Math.min(6, results.length);i++){
      const { city, district } = pick(results[i]?.address_components || []);
      if (city || district) return { city, district };
    }
    return {};
  }catch{ return {}; }
}

async function placeDetails(place_id:string){
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const fields='address_component,formatted_address,formatted_phone_number,website,opening_hours';
  const url=`${GOOGLE_BASES.details}?place_id=${encodeURIComponent(place_id)}&language=${LANG}&fields=${fields}&key=${key}`;
  try{
    const j:any = await fetchJson(url);
    return j?.result;
  }catch{ return null; }
}

function prefixCityToAddress(addr: string | undefined, city?: string, district?: string){
  const raw = (addr||'').replace(/^[臺台]灣[,\s]*/,'');
  const parts: string[] = [];
  if (city && !raw.includes(city)) parts.push(city);
  if (district && !raw.includes(district)) parts.push(district);
  if (parts.length===0) return raw || undefined;
  return raw ? `${parts.join(' ')} · ${raw}` : parts.join(' ');
}

async function routeGoogle(origin:string, destination:string): Promise<GoogleDir>{
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`${GOOGLE_BASES.directions}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j:any = await fetchJson(url);
  if (j.status!=='OK' || !j.routes?.[0]) throw new Error(j.error_message||j.status||'directions_failed');
  const route=j.routes[0], leg=route.legs[0];
  const coords=polyline.decode(route.overview_polyline.points).map(([lat,lng]:[number,number])=>({lat,lng}));
  return {
    polyline: coords,
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text
  };
}

async function nearby(center:LatLng, type: string, radiusM:number, keyword?:string){
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const p = new URLSearchParams({
    location: `${center.lat},${center.lng}`,
    radius: String(radiusM),
    type: type,
    language: LANG,
    key
  });
  if (keyword) p.set('keyword', keyword);
  const url = `${GOOGLE_BASES.nearby}?${p.toString()}`;
  try{
    const j:any = await fetchJson(url);
  if (j.status && j.status!=='OK' && j.status!=='ZERO_RESULTS') return [];
  return Array.isArray(j.results)? j.results : [];
  }catch{ return []; }
}

function scorePlace(p:any, distKm:number){
  const rating=p.rating||0;
  const urt=p.user_ratings_total||1;
  const pop=Math.log10(urt+1)+1;
  const prox= 1/(1+ distKm/6);
  return rating*pop*prox;
}

/* ===========================
   Path sampling & radius
=========================== */
function sampleAlongPathDynamic(path:LatLng[]){
  if (!path.length) return [];
  const cum=cumulativeLengthKm(path);
  const total=cum[cum.length-1];
  if (total===0) return [path[0]];
  const step=Math.max(24, Math.min(48, total/16)); // 更密的採樣
  const n=Math.min(40, Math.max(4, Math.round(total/step)+1));
  const out:LatLng[]=[];
  for(let i=0;i<n;i++){
    const target=(i/(n-1))*total;
    let j=0; while(j<cum.length && cum[j]<target) j++;
    if (j===0) out.push(path[0]);
    else if (j>=cum.length) out.push(path[path.length-1]);
    else{
      const t0=cum[j-1], t1=cum[j], A=path[j-1], B=path[j];
      const r=t1===t0?0:(target-t0)/(t1-t0);
      out.push({ lat:A.lat+(B.lat-A.lat)*r, lng:A.lng+(B.lng-A.lng)*r });
    }
  }
  const dedup:LatLng[]=[];
  for(const p of out){ if(!dedup.some(q=>haversineKm(p,q)<4)) dedup.push(p); }
  return dedup;
}

function dynamicRadiusMeters(totalKm:number){
  return Math.min(25000, Math.max(4000, Math.round(totalKm*25)));
}

/* ===========================
   Collect POIs along the route
=========================== */
function progressOfPointOnPath(pt:LatLng, path:LatLng[]){
  // 最近頂點索引近似，轉 0..1
  let best=Infinity, bi=0;
    for (let i=0;i<path.length;i++){
      const d = haversineKm(pt, path[i]);
    if (d<best){ best=d; bi=i; }
    }
  return path.length<=1? 0 : bi/(path.length-1);
}

async function collectAlongRoute(path:LatLng[]){
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length-1]);
  const radius  = dynamicRadiusMeters(totalKm);

  const map = new Map<string,{item:PlaceOut,score:number}>();

  for (const s of samples){
    // 多型別景點（輪詢）
    for (const t of ATTRACTION_TYPES){
      const arr1 = await nearby(s, 'tourist_attraction', radius).catch(()=>[]);
      const arr2 = await nearby(s, t, radius).catch(()=>[]);
      for (const p of [...arr1,...arr2]){
        const id = p.place_id as string | undefined;
        const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc   = scorePlace(p, dist);
        const prog = progressOfPointOnPath(loc, path);
        const item:PlaceOut = {
          name: p.name, lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating, place_id: id,
          _type: 'tourist_attraction',
          __progress: prog
        };
        const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        const cur = map.get(key);
        if (!cur || sc>cur.score) map.set(key, { item, score: sc });
      }
      await sleep(40);
    }

    // 餐廳/住宿
    for (const t of ['restaurant','lodging'] as const){
      const arr = await nearby(s, t, radius);
      for (const p of arr){
        const id = p.place_id as string | undefined;
        const loc = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc   = scorePlace(p, dist);
        const prog = progressOfPointOnPath(loc, path);
        const item:PlaceOut = {
          name: p.name, lat: loc.lat, lng: loc.lng,
          address: p.vicinity || p.formatted_address,
          rating: p.rating, place_id: id,
          _type: t,
          __progress: prog
        };
        const key = id || `${item.name}@${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        const cur = map.get(key);
        if (!cur || sc>cur.score) map.set(key, { item, score: sc });
      }
      await sleep(40);
    }
  }

  return Array.from(map.values())
    .sort((a,b)=> (a.item.__progress! - b.item.__progress!) || (b.score - a.score))
    .map(x=>x.item);
}

/* ===========================
   Waypoint 分段 + 進度區間切天
=========================== */
function clamp01(x:number){ return Math.max(0, Math.min(1, x)); }

function pickAttractionsForDay(
  attractions: PlaceOut[],
  minP: number,
  maxP: number,
  need: number,
  lastProgress: number
){
  // 僅在[minP,maxP]內挑點，並保證進度遞增
  const pool = attractions.filter(a=>{
    const p=a.__progress ?? 0;
    return p>=minP && p<=maxP && p>lastProgress+1e-6;
  });
  pool.sort((a,b)=> (a.__progress!-b.__progress!) || (b.rating??0)-(a.rating??0));
  const picked:PlaceOut[]=[];
  for(const a of pool){
    if (picked.length>=need) break;
    // 去重：距上一選點 < 1.2km 視為太近
    if (picked.length>0){
      const prev = picked[picked.length-1];
      if (haversineKm(prev, a) < 1.2) continue;
    }
    picked.push(a);
  }
  return picked;
}

function centroid(list:LatLng[]){
  const n=list.length||1;
  return {
    lat: list.reduce((s,p)=>s+p.lat,0)/n,
    lng: list.reduce((s,p)=>s+p.lng,0)/n
  };
}

function bestByScore(cands:PlaceOut[], target:LatLng){
  let best:PlaceOut|undefined; let bs=-1;
  for (const r of cands){
    const dist = haversineKm(target, r);
    const sc = (r.rating||0) / (1 + dist/6);
    if (sc>bs){ bs=sc; best=r; }
  }
  return best;
}

function buildItineraryProgressive(pois:PlaceOut[], days:number): DaySlot[] {
  const attractions = pois.filter(p=>p._type==='tourist_attraction').sort((a,b)=>(a.__progress!-b.__progress!));
  const restaurants = pois.filter(p=>p._type==='restaurant');
  const lodgings    = pois.filter(p=>p._type==='lodging');

  const maxP = Math.max( ...attractions.map(a=>a.__progress ?? 0), 1 );
  const res: DaySlot[] = Array.from({length:days}, ()=>({ morning:[], afternoon:[] }));

  let cursor = -0.001; // 上一個選到的 attraction 進度

  for (let d=0; d<days; d++){
    // 當日進度區間
    const segStart = d/days, segEnd = (d+1)/days;
    let minP = clamp01(segStart + PROG_BACK);
    let maxP = clamp01(segEnd   + PROG_FWD);
    if (d===days-1) maxP = Math.max(maxP, LAST_DAY_MIN);

    // 需挑的景點數（早 1–2、午餐後 下午 1–2）
    const needMorning = 1 + Math.round(Math.random()); // 1~2
    const needAfternoon = 1 + Math.round(Math.random());

    let pickedMorning = pickAttractionsForDay(attractions, minP, maxP, needMorning, cursor);
    // 若不足 -> 只向前擴窗
    let expandStep = 0;
    while (pickedMorning.length<needMorning && maxP<1 && expandStep<3){
      maxP = clamp01(maxP + 0.08);
      pickedMorning = pickAttractionsForDay(attractions, minP, maxP, needMorning, cursor);
      expandStep++;
    }
    if (pickedMorning.length>0) cursor = pickedMorning[pickedMorning.length-1].__progress ?? cursor;

    // 下午
    let pickedAfternoon = pickAttractionsForDay(attractions, minP, maxP, needAfternoon, cursor);
    expandStep = 0;
    while (pickedAfternoon.length<needAfternoon && maxP<1 && expandStep<3){
      maxP = clamp01(maxP + 0.08);
      pickedAfternoon = pickAttractionsForDay(attractions, minP, maxP, needAfternoon, cursor);
      expandStep++;
    }
    if (pickedAfternoon.length>0) cursor = pickedAfternoon[pickedAfternoon.length-1].__progress ?? cursor;

    // 填入
    res[d].morning = pickedMorning;
    res[d].afternoon = pickedAfternoon;

    // 午餐：幾何中心附近餐廳
    const dayPts = [...pickedMorning, ...pickedAfternoon];
    if (dayPts.length>0 && restaurants.length>0){
      const c = centroid(dayPts);
      const best = bestByScore(restaurants, c);
      if (best) res[d].lunch = best;
    }

    // 住宿：靠近下午最後一點
    const anchor = pickedAfternoon[pickedAfternoon.length-1] || pickedMorning[pickedMorning.length-1];
    if (anchor && lodgings.length>0){
      const best = bestByScore(lodgings, { lat: anchor.lat, lng: anchor.lng });
      if (best) res[d].lodging = best;
      }
    }

  return res;
}

/* ===========================
   OSM/OSRM Fallback
=========================== */
async function geocodeOSM(query:string){
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r=await fetch(url,{ headers:{'Accept-Language':LANG}, cache:'no-store'});
  const j=await r.json();
  if(!Array.isArray(j)||!j[0]) throw new Error('geocode_failed');
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name };
}
async function routeOSRM(origin:LatLng, dest:LatLng){
  const url=`https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j:any=await fetchJson(url);
  if(!j.routes?.[0]) throw new Error('route_failed');
  const route=j.routes[0];
  const coords=route.geometry.coordinates.map(([lng,lat]:[number,number])=>({lat,lng}));
  return {
    polyline: coords as LatLng[],
    distanceText:(route.distance/1000).toFixed(1)+' km',
    durationText: Math.round(route.duration/60)+' 分鐘'
  };
}

/* ===========================
   Enrich chosen items with City/District (Details first, reverse fallback)
=========================== */
async function enrichChosenCityAddress(chosen:PlaceOut[]){
  for (const p of chosen){
    try{
      let city: string|undefined, district: string|undefined;

      if (p.place_id){
        const det = await placeDetails(p.place_id);
        const comps:any[] = det?.address_components || [];
        if (comps.length){
          const byType = (t:string)=> comps.find(c=>Array.isArray(c.types)&&c.types.includes(t))?.long_name as string|undefined;
          let c = byType('administrative_area_level_2') || byType('locality') || byType('postal_town');
          const lvl1 = byType('administrative_area_level_1');
          if ((!c || /台灣|臺灣/i.test(c)) && lvl1 && looksLikeCity(lvl1)) c = lvl1;
          if (!c){
            const cand = comps.find((cc:any)=> typeof cc.long_name==='string' && looksLikeCity(cc.long_name));
            if (cand) c = cand.long_name;
          }
          const subl = comps.find(cc=> String(cc.types).includes('sublocality_level_1'))?.long_name;
          let d = subl || byType('administrative_area_level_3');
          if (!d){
            const dCand = comps.find((cc:any)=> typeof cc.long_name==='string' && /[區鄉鎮市]$/.test(cc.long_name));
            if (dCand) d = dCand.long_name;
          }
          city = normalizeZhTW(c && c!=='台灣'? c: undefined);
          district = normalizeZhTW(d);
        }
      }

      if (!city && !district){
        const rv = await reverseCity(p.lat, p.lng);
        city = city || rv.city;
        district = district || rv.district;
      }

      p.city = city;
      p.district = district;
      if (p.address) p.address = prefixCityToAddress(p.address, city, district);
      else if (city || district) p.address = prefixCityToAddress(undefined, city, district);

      await sleep(40);
    }catch{/* ignore single-point failure */}
  }
}

/* ===========================
   Handler
=========================== */
export async function POST(req: NextRequest){
  try{
    const body = await req.json();
    const { origin, destination, days=5 } = body || {};
    if (!origin || !destination){
      return NextResponse.json({ error:'bad_request', detail:'origin/destination required' }, { status:400, headers:{'Cache-Control':'no-store'} });
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle){
      // 1) 路線
      const r = await routeGoogle(origin, destination);
      const path = r.polyline;

      // 2) 收集沿途 POI
      const allPois = await collectAlongRoute(path);

      // 3) 產生旅行社風格行程（強制南進）
      const itinerary = buildItineraryProgressive(allPois, days);

      // 4) 只對「入選」的點做 City/District 補全與前綴
      const chosen: PlaceOut[] = [];
      for (const d of itinerary){
        for (const x of [...d.morning, d.lunch, ...d.afternoon, d.lodging]){
          if (x) chosen.push(x);
      }
      }
      await enrichChosenCityAddress(chosen);

      // 5) 回傳
      return NextResponse.json({
        provider: 'google',
        polyline: path.map(p=>[p.lat,p.lng]) as [number,number][],
        start: r.start,
        end:   r.end,
        distanceText: r.distanceText,
        durationText: r.durationText,
        // 扁平池（裁到 90 以內，避免過量）
        pois: allPois.slice(0, 90).map(p=>{
          // 避免前端看到未選點卻沒城市：不做 city 前綴（只給原始地址）；入選的已在 enrich 中處理
          const { city, district, ...rest } = p;
          return rest;
        }),
        itinerary
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });

    }else{
      // 無 Google Key：回傳最小可視化資訊
      const o = await geocodeOSM(origin);
      const d = await geocodeOSM(destination);
      const ro = await routeOSRM({lat:o.lat,lng:o.lng},{lat:d.lat,lng:d.lng});
      return NextResponse.json({
        provider:'osrm',
        polyline: ro.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start:{lat:o.lat,lng:o.lng, address:o.formatted},
        end:{lat:d.lat,lng:d.lng, address:d.formatted},
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois: [], itinerary: []
      }, { headers:{'Cache-Control':'no-store'} });
    }

  }catch(e:any){
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json({ error:'server_error', detail:e?.message||'Unknown error' }, { status, headers:{'Cache-Control':'no-store'} });
  }
}
