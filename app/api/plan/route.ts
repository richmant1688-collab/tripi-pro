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
  city?: string; // 反向地理編碼後加上
};

type DaySlot = {
  morning: PlaceOut[];    // 景點 1–2
  lunch?: PlaceOut;       // 餐廳 1
  afternoon: PlaceOut[];  // 景點 1–2
  lodging?: PlaceOut;     // 住宿 1
};

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3; // 起訖小於 3km 視為單點玩法

// ------------------------------------------------------------------
// Utils
// ------------------------------------------------------------------
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg += ' ' + (await r.text()).slice(0,200); } catch {}
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1*s1 + Math.cos(la1)*Math.cos(la2)*s2*s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i=1;i<path.length;i++) acc.push(acc[i-1] + haversineKm(path[i-1], path[i]));
  return acc;
}

/** 動態沿線採樣：總距離越長，點數越多，但有上下限 */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path), total = cum[cum.length-1];
  if (total === 0) return [path[0]];
  const step = Math.max(20, Math.min(50, total/15));      // 每 ~20–50km 取一個
  const n    = Math.min(24, Math.max(2, Math.round(total/step)+1)); // 最多 24 個點
  const out: LatLng[] = [];
  for (let i=0;i<n;i++){
    const target = (i/(n-1))*total;
    let j=0; while (j<cum.length && cum[j]<target) j++;
    if (j===0) out.push(path[0]);
    else if (j>=cum.length) out.push(path[path.length-1]);
    else {
      const t0=cum[j-1], t1=cum[j], A=path[j-1], B=path[j];
      const r=t1===t0?0:(target-t0)/(t1-t0);
      out.push({ lat: A.lat+(B.lat-A.lat)*r, lng: A.lng+(B.lng-A.lng)*r });
    }
  }
  // 去重（<5km 視為同點）
  const dedup: LatLng[] = [];
  for (const p of out) if (!dedup.some(q=>haversineKm(p,q)<5)) dedup.push(p);
  return dedup;
}

function dynamicRadiusMeters(totalKm:number){
  // 依總里程動態設定沿途搜尋半徑（5–15km）
  return Math.min(15000, Math.max(5000, Math.round(totalKm * 20)));
}

// ------------------------------------------------------------------
// Google APIs
// ------------------------------------------------------------------
async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  let j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j = await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g=j.results[0];
  return { lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address };
}

async function reverseCity(lat:number,lng:number): Promise<string|undefined> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const find = (t:string)=>ac.find(c=>c.types?.includes(t))?.long_name;
  // 以 台灣常見為主：縣市 + 行政區
  const lvl2 = find('administrative_area_level_2') || find('locality'); // 縣市
  const sub  = find('sublocality_level_1') || find('political');        // 區
  const parts = [lvl2, sub].filter(Boolean);
  return parts.length ? parts.join(' ') : (lvl2 || undefined);
}

async function routeGoogle(origin:string, destination:string){
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j   = await fetchJson<any>(url);
  if (j.status!=='OK' || !j.routes?.[0]) throw new Error(j.error_message||j.status||'directions_failed');
  const route=j.routes[0], leg=route.legs[0];
  const coords = polyline.decode(route.overview_polyline.points).map(([lat,lng]:[number,number])=>({lat,lng}));
  return {
    polyline: coords as LatLng[],
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end: { lat: leg.end_location.lat, lng: leg.end_location.lng, address: leg.end_address },
    distanceText: leg.distance.text, durationText: leg.duration.text,
  };
}

async function nearby(center:LatLng, type:PlaceType, radiusM:number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${center.lat},${center.lng}&radius=${radiusM}&type=${encodeURIComponent(type)}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status && j.status!=='OK' && j.status!=='ZERO_RESULTS') return [];
  return Array.isArray(j.results)? j.results : [];
}

function scorePlace(p:any, distKm?:number) {
  // 綜合評分（評分 * 人氣 * 鄰近性）
      const rating = p.rating || 0;
      const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;     // 1 ~ 3+ 關注度
  const prox = typeof distKm==='number' ? 1/(1 + distKm/5) : 1;
  return rating * pop * prox;
}

/** 計算沿線進度：用最近折線頂點索引近似 */
function progressIndex(path:LatLng[], pt:LatLng): number {
  let best=Infinity, bi=0;
  for (let i=0;i<path.length;i++){
    const d = haversineKm(pt, path[i]);
    if (d<best){ best=d; bi=i; }
  }
  return bi;
}

/** 沿途搜尋 + 依「沿路前進進度」排序（關鍵：避免同日來回） */
async function placesAlongRoute(path:LatLng[]): Promise<Array<PlaceOut & {__prog:number}>> {
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length-1]);
  const radius  = dynamicRadiusMeters(totalKm);
  const byId    = new Map<string,{item:PlaceOut & {__prog:number},score:number}>();

  for (const s of samples){
    for (const t of TYPES){
      const arr = await nearby(s, t, radius);
      for (const p of arr){
        const id = p.place_id as string|undefined; if (!id) continue;
        const loc:LatLng = { lat:p.geometry.location.lat, lng:p.geometry.location.lng };
        const dist = haversineKm(s, loc);
        const sc   = scorePlace(p, dist);
        const item:PlaceOut & {__prog:number} = {
      name: p.name,
          lat: loc.lat, lng: loc.lng,
      address: p.vicinity || p.formatted_address,
    rating: p.rating,
          place_id: id,
          _type: t,
          __prog: progressIndex(path, loc),
        };

        const cur = byId.get(id);
        if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
      }
      await sleep(80); // 拖一下避免 QPS 過高
    }
  }

  // 先按沿路進度排，若同進度再看評分
  return Array.from(byId.values())
    .map(x=>x.item)
    .sort((a,b)=> a.__prog - b.__prog || (b.rating??0)-(a.rating??0));
}

/** 旅行社式排程：依進度等分，上午/午餐/下午/住宿 */
function buildAgencyStyleItineraryByProgress(sorted: Array<PlaceOut & {__prog:number}>, days:number): DaySlot[] {
  const itinerary:DaySlot[] = Array.from({length:days}, ()=>({ morning:[], afternoon:[] }));
  if (sorted.length===0) return itinerary;

  const progMin = sorted[0].__prog, progMax = sorted[sorted.length-1].__prog;
  const step = Math.max(1, Math.floor((progMax - progMin + 1)/days));

  // 只拿景點作骨架
  const attractions = sorted.filter(p=>p._type==='tourist_attraction');

  for (let d=0; d<days; d++){
    const segStart = progMin + d*step;
    const segEnd   = d===days-1 ? progMax+1 : segStart + step;
    const inSeg    = attractions.filter(p=>p.__prog>=segStart && p.__prog<segEnd);

    const morning   = inSeg.slice(0, Math.min(2, inSeg.length));
    const afternoon = inSeg.slice(morning.length, Math.min(morning.length+2, inSeg.length));
    itinerary[d].morning   = morning;
    itinerary[d].afternoon = afternoon;
  }

  // 午餐：靠近當日幾何中心的高分餐廳
  const restaurants = sorted.filter(p=>p._type==='restaurant');
  for (let d=0; d<days; d++){
    const pts=[...itinerary[d].morning, ...itinerary[d].afternoon];
    if (!pts.length) continue;
    const cx=pts.reduce((s,p)=>s+p.lat,0)/pts.length;
    const cy=pts.reduce((s,p)=>s+p.lng,0)/pts.length;
    let best:PlaceOut|undefined, bs=-1;
    for (const r of restaurants){
      const sc = (r.rating||0) / (1 + haversineKm({lat:cx,lng:cy}, {lat:r.lat,lng:r.lng})/5);
      if (sc>bs){ bs=sc; best=r; }
    }
    if (best) itinerary[d].lunch = best;
  }

  // 住宿：靠近下午最後一景點的高分住宿
  const lodgings = sorted.filter(p=>p._type==='lodging');
  for (let d=0; d<days; d++){
    const anchor = itinerary[d].afternoon[itinerary[d].afternoon.length-1]
                || itinerary[d].morning[itinerary[d].morning.length-1];
    if (!anchor) continue;
    let best:PlaceOut|undefined, bs=-1;
    for (const h of lodgings){
      const sc = (h.rating||0) / (1 + haversineKm({lat:anchor.lat,lng:anchor.lng}, {lat:h.lat,lng:h.lng})/5);
      if (sc>bs){ bs=sc; best=h; }
    }
    if (best) itinerary[d].lodging = best;
  }

  return itinerary;
}

// ------------------------------------------------------------------
// OSM/OSRM fallback（無 Google Key 時使用）
// ------------------------------------------------------------------
async function geocodeOSM(query: string) {
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r = await fetch(url,{ headers:{'Accept-Language':LANG}, cache:'no-store'});
  const j = await r.json();
  if (!Array.isArray(j)||!j[0]) throw new Error('geocode_failed');
  return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), formatted: j[0].display_name };
}

async function routeOSRM(origin:LatLng, dest:LatLng){
  const url=`https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j = await fetchJson<any>(url);
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route=j.routes[0];
  const coords=route.geometry.coordinates.map(([lng,lat]:[number,number])=>({lat,lng}));
  return { polyline: coords as LatLng[], distanceText:(route.distance/1000).toFixed(1)+' km', durationText: Math.round(route.duration/60)+' 分鐘' };
}

// ------------------------------------------------------------------
// Route Handler
// ------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(()=> ({}));
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json({ error:'bad_request', detail:'origin/destination required' }, { status:400, headers:{'Cache-Control':'no-store'} });
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      // 1) 路線
      const r = await routeGoogle(origin, destination);
      const startLL={lat:r.start.lat,lng:r.start.lng}, endLL={lat:r.end.lat,lng:r.end.lng};
      const isSingle = haversineKm(startLL,endLL) <= NEAR_EQ_KM;

      // 2) 蒐集候選點（單點 or 沿途）
      let poisRaw: Array<PlaceOut & {__prog:number}> = [];

      if (isSingle) {
        // 單點玩法：以起點 3km radius 搜尋三類型，按評分/人氣排序
        const key=process.env.GOOGLE_MAPS_API_KEY!;
        const arr: Array<PlaceOut & {__prog:number}> = [];
        for (const t of TYPES){
          const url=`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${startLL.lat},${startLL.lng}&radius=3000&type=${t}&language=${LANG}&key=${key}`;
          const j=await fetchJson<any>(url);
          const res = Array.isArray(j.results)? j.results : [];
          for (const p of res){
            const id=p.place_id as string|undefined; if (!id) continue;
            arr.push({
              name:p.name, lat:p.geometry.location.lat, lng:p.geometry.location.lng,
              address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t,
              __prog: 0,
            });
          }
          await sleep(80);
        }
        poisRaw = arr.sort((a,b)=> (b.rating??0)-(a.rating??0));
      } else {
        // 沿路搜尋：依進度排序（避免同日來回南北）
        poisRaw = await placesAlongRoute(r.polyline);
      }

      // 3) 限量保留，避免太多
      const poisCapped = poisRaw.slice(0, 100);

      // 4) 依進度切等分、產生旅行社式日程
      const safeDays = Math.max(1, Math.min(14, Number.isFinite(days) ? days : 5));
      const itinerary = buildAgencyStyleItineraryByProgress(poisCapped, safeDays);

      // 5) 只對「被選入日程的點」做反向地理編碼，前置 city 至 address
      const chosenIds = new Set<string>();
      itinerary.forEach(d=>{
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{ if(p?.place_id) chosenIds.add(p.place_id); });
      });

      for (const p of poisCapped) {
        if (!p.place_id || !chosenIds.has(p.place_id)) continue;
        try {
          const city = await reverseCity(p.lat, p.lng);
          p.city = city;
          if (p.address) {
            p.address = city ? `${city} · ${p.address}` : p.address;
          } else if (city) {
            p.address = city;
          }
          await sleep(30);
        } catch {}
      }

      // 6) 回傳
      return NextResponse.json({
          provider: 'google',
        polyline: r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
        end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
          distanceText: r.distanceText,
          durationText: r.durationText,
        pois: poisCapped.map(({__prog, ...rest})=>rest), // 兼容舊欄位
        itinerary,                                        // 新欄位（早/午/下午/住宿）
      }, { headers: { 'Cache-Control': 'private, max-age=60' }});

    } else {
      // 沒有 Google Key：只用 OSRM 回路線，不做餐廳/住宿/景點
      const o=await geocodeOSM(origin), d=await geocodeOSM(destination);
      const ro=await routeOSRM({lat:o.lat,lng:o.lng},{lat:d.lat,lng:d.lng});
      return NextResponse.json({
        provider:'osrm',
        polyline: ro.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start:{lat:o.lat,lng:o.lng, address:o.formatted},
        end:{lat:d.lat,lng:d.lng, address:d.formatted},
        distanceText: ro.distanceText, durationText: ro.durationText,
        pois:[], itinerary:[],
      }, { headers:{'Cache-Control':'no-store'}});
    }
  } catch (e:any) {
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json({ error:'server_error', detail:e?.message||'Unknown error' }, { status, headers:{'Cache-Control':'no-store'} });
  }
}

// 可選：若你想在 Edge Runtime 執行（降低冷啟動），取消註解
// export const runtime = 'edge';
