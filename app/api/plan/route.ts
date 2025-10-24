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
  city?: string; // 例如：桃園市 桃園區
};

type DaySlot = {
  morning: PlaceOut[];    // 景點 1–2
  lunch?: PlaceOut;       // 餐廳 1
  afternoon: PlaceOut[];  // 景點 1–2
  lodging?: PlaceOut;     // 住宿 1
};

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3;

/* ======================= 小工具 ======================= */
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function fetchJson<T=any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R=6371;
  const dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  const la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(s1*s1+Math.cos(la1)*Math.cos(la2)*s2*s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc=[0];
  for (let i=1;i<path.length;i++) acc.push(acc[i-1]+haversineKm(path[i-1],path[i]));
  return acc;
}

/** 沿線採樣（較密） */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum=cumulativeLengthKm(path), total=cum[cum.length-1];
  if (total===0) return [path[0]];
  const step=Math.max(12, Math.min(35, total/22));
  const n=Math.min(48, Math.max(4, Math.round(total/step)+1));
  const out:LatLng[]=[];
  for (let i=0;i<n;i++){
    const target=(i/(n-1))*total;
    let j=0; while(j<cum.length && cum[j]<target) j++;
    if (j===0) out.push(path[0]);
    else if (j>=cum.length) out.push(path[path.length-1]);
    else {
      const t0=cum[j-1], t1=cum[j], A=path[j-1], B=path[j];
      const r=t1===t0?0:(target-t0)/(t1-t0);
      out.push({ lat:A.lat+(B.lat-A.lat)*r, lng:A.lng+(B.lng-A.lng)*r });
    }
  }
  // 去重（<6km）
  const dedup:LatLng[]=[];
  for (const p of out) if(!dedup.some(q=>haversineKm(p,q)<6)) dedup.push(p);
  return dedup;
}

/** 半徑較大（10–35km） */
function dynamicRadiusMeters(totalKm:number){
  return Math.min(35000, Math.max(10000, Math.round(totalKm*35)));
}

/** 從中文地址抽出「市/縣 + 區/鄉/鎮/市」（能抓到就回傳） */
function extractCityFromAddress(addr?: string): string|undefined {
  if (!addr) return;
  const m = addr.match(/([^\s·,，。]{1,6}[市縣])\s*([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  if (m) return `${m[1]} ${m[2]}`;
  const m2 = addr.match(/([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  if (m2) return m2[1];
}

/** 前置 city，避免把「區」重複兩次 */
function ensureCityPrefixed(p: PlaceOut) {
  if (!p) return;
  const city = p.city || extractCityFromAddress(p.address);
  if (!city) return;
  if (p.address) {
    const a = p.address.replace(/\s+/g,'');
    const c = city.replace(/\s+/g,'');
    if (a.startsWith(c)) return; // 已前置
    if (a.startsWith(city.split(' ')[1] || '')) return; // address 以「某某區」起頭時避免重複
  }
  p.city = city;
  p.address = p.address ? `${city} · ${p.address}` : city;
}

/* ======================= Google APIs ======================= */
async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const base='https://maps.googleapis.com/maps/api/geocode/json';
  let j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g=j.results[0];
  return { lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address };
}

/** 優先組成「市/縣 + 區」 */
async function reverseCity(lat:number,lng:number): Promise<string|undefined> {
  try{
    const key=process.env.GOOGLE_MAPS_API_KEY!;
    const url=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
    const j=await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const find = (t:string)=>ac.find(c=>c.types?.includes(t))?.long_name;

    const a1=find('administrative_area_level_1'); // 例：台南市（有時）
    const a2=find('administrative_area_level_2'); // 例：台南市（有時）
    const locality=find('locality');              // 例：台南市/台南區（有時）
    const sub = find('sublocality_level_1');      // 例：信義區

    const cityOrCounty =
      (a2 && /[市縣]$/.test(a2) ? a2 : undefined) ||
      (a1 && /[市縣]$/.test(a1) ? a1 : undefined) ||
      (locality && /[市縣]$/.test(locality) ? locality : undefined);

    const district =
      (locality && /[區鄉鎮市]$/.test(locality) ? locality : undefined) ||
      (sub && /[區鄉鎮市]$/.test(sub) ? sub : undefined);

    if (cityOrCounty && district) return `${cityOrCounty} ${district}`;
    if (cityOrCounty) return cityOrCounty;
    if (district) return district;
    return undefined;
  }catch{ return undefined; }
}

async function routeGoogle(origin:string, destination:string){
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${key}`;
  const j=await fetchJson<any>(url);
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

/** 回傳 [0,1] 的路徑進度比例 */
function progressRatio(path:LatLng[], pt:LatLng): number {
  let best=Infinity, bi=0;
  for (let i=0;i<path.length;i++){
    const d=haversineKm(pt, path[i]);
    if (d<best){ best=d; bi=i; }
  }
  return path.length>1 ? bi/(path.length-1) : 0;
}

async function placesAlongRoute(path:LatLng[]): Promise<Array<PlaceOut & {__prog:number}>> {
  const samples=sampleAlongPathDynamic(path);
  const totalKm=haversineKm(path[0], path[path.length-1]);
  const radius=dynamicRadiusMeters(totalKm);
  const byId=new Map<string,{item:PlaceOut & {__prog:number},score:number}>();

  for (const s of samples){
    for (const t of TYPES){
      const arr=await nearby(s, t, radius);
      for (const p of arr){
        const id=p.place_id as string|undefined; if (!id) continue;
        const loc:LatLng={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
        const dist=haversineKm(s, loc);
        const sc=scorePlace(p, dist);
        const item:PlaceOut & {__prog:number} = {
          name:p.name, lat:loc.lat, lng:loc.lng,
          address:p.vicinity||p.formatted_address,
          rating:p.rating, place_id:id, _type:t,
          __prog: progressRatio(path, loc),
        };
        const cur=byId.get(id);
        if (!cur || sc>cur.score) byId.set(id,{item,score:sc});
      }
      await sleep(60);
    }
  }

  return Array.from(byId.values())
    .map(x=>x.item)
    .sort((a,b)=> a.__prog - b.__prog || (b.rating??0)-(a.rating??0));
}

/* ====== 旅行社式：以進度「嚴格分段」→ 僅向南補點，確保後段也有 ====== */
function buildAgencyStyleItinerary(sorted: Array<PlaceOut & {__prog:number}>, days:number): DaySlot[] {
  const itinerary:DaySlot[] = Array.from({length:days}, ()=>({ morning:[], afternoon:[] }));
  if (sorted.length===0) return itinerary;

  const attractions = sorted.filter(p=>p._type==='tourist_attraction');
  const restaurants = sorted.filter(p=>p._type==='restaurant');
  const lodgings   = sorted.filter(p=>p._type==='lodging');

  // 依天建立「主要區間」，不足才向南(向後)擴張
  for (let d=0; d<days; d++){
    const start = d/days;
    const end   = (d+1)/days;
    const mid   = (start+end)/2;

    const inWindow = (p:PlaceOut & {__prog:number}, s:number, e:number)=> p.__prog>=s && p.__prog<e;

    // 初始：本日區間
    let cand = attractions.filter(p=>inWindow(p,start,end));
    // 不足則只向「後方」擴張，再不夠才少量向前擴張
    if (cand.length < 2) {
      const e2 = Math.min(1, end + 0.25);
      cand = attractions.filter(p=>inWindow(p,start,e2));
    }
    if (cand.length < 2) {
      const s2 = Math.max(0, start - 0.08);
      cand = attractions.filter(p=>inWindow(p,s2, Math.min(1,end+0.25)));
    }

    // 依評分 & 靠近本日中點排序
    cand.sort((a,b)=>{
      const byRate = (b.rating??0)-(a.rating??0);
      if (byRate!==0) return byRate;
      const da = Math.abs(a.__prog - mid);
      const db = Math.abs(b.__prog - mid);
      return da - db;
    });

    // 取最多 4 個；上午偏向區間前半、下午偏向後半
    const picked = cand.slice(0, 4);
    const firstHalf  = picked.filter(p=>p.__prog <= mid);
    const secondHalf = picked.filter(p=>p.__prog >  mid);
    const morning = (firstHalf.length ? firstHalf : picked.slice(0,2)).slice(0,2);
    const afternoon = (secondHalf.length ? secondHalf : picked.slice(morning.length)).slice(0,2);
    itinerary[d].morning = morning;
    itinerary[d].afternoon = afternoon;
  }

  // 午餐：在本日區間附近挑高分餐廳（±0.08）
  for (let d=0; d<days; d++){
    const start = d/days, end=(d+1)/days;
    const pts=[...itinerary[d].morning, ...itinerary[d].afternoon];
    if (!pts.length || !restaurants.length) continue;
    const near = restaurants
      .filter((r:any)=> r.__prog>=Math.max(0,start-0.08) && r.__prog<=Math.min(1,end+0.08))
      .sort((a,b)=> (b.rating??0)-(a.rating??0));
    const pool = (near.length? near : restaurants);
    const cx=pts.reduce((s,p)=>s+p.lat,0)/pts.length;
    const cy=pts.reduce((s,p)=>s+p.lng,0)/pts.length;
    let best:PlaceOut|undefined, bs=-1;
    for (const r of pool){
      const sc = (r.rating||0) / (1 + haversineKm({lat:cx,lng:cy}, {lat:r.lat,lng:r.lng})/5);
      if (sc>bs){ bs=sc; best=r; }
    }
    if (best) itinerary[d].lunch = best;
  }

  // 住宿：挑靠近「本日尾端」(end) 的住宿
  for (let d=0; d<days; d++){
    const end = (d+1)/days;
    const anchor = itinerary[d].afternoon[itinerary[d].afternoon.length-1]
                || itinerary[d].morning[itinerary[d].morning.length-1];
    if (!lodgings.length || !anchor) continue;
    const near = lodgings
      .slice()
      .sort((a:any,b:any)=> Math.abs(a.__prog-end) - Math.abs(b.__prog-end) || (b.rating??0)-(a.rating??0));
    itinerary[d].lodging = near[0];
  }

  return itinerary;
}

/* ======================= OSM/OSRM 後備 ======================= */
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
  return { polyline: coords as LatLng[], distanceText:(route.distance/1000).toFixed(1)+' km', durationText: Math.round(route.duration/60)+' 分鐘' };
}

/* ======================= Handler ======================= */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(()=> ({}));
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json({ error:'bad_request', detail:'origin/destination required' }, { status:400, headers:{'Cache-Control':'no-store'} });
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      // 路線
      const r = await routeGoogle(origin, destination);
      const startLL={lat:r.start.lat,lng:r.start.lng}, endLL={lat:r.end.lat,lng:r.end.lng};
      const isSingle = haversineKm(startLL,endLL) <= NEAR_EQ_KM;

      // 候選點
      let candidates: Array<PlaceOut & {__prog:number}> = [];
      if (isSingle) {
        const key=process.env.GOOGLE_MAPS_API_KEY!;
        for (const t of TYPES){
          const url=`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${startLL.lat},${startLL.lng}&radius=5000&type=${t}&language=${LANG}&key=${key}`;
          const j=await fetchJson<any>(url);
          const res = Array.isArray(j.results)? j.results : [];
          for (const p of res){
            const id=p.place_id as string|undefined; if (!id) continue;
            candidates.push({
              name:p.name, lat:p.geometry.location.lat, lng:p.geometry.location.lng,
              address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t,
              __prog: 0,
            });
          }
          await sleep(50);
        }
        candidates.sort((a,b)=> (b.rating??0)-(a.rating??0));
      } else {
        candidates = await placesAlongRoute(r.polyline);
      }

      // 分配 + 限量
      const poisCapped = candidates.slice(0, 140);
      const safeDays = Math.max(1, Math.min(14, Number.isFinite(days) ? days : 5));
      const itinerary = buildAgencyStyleItinerary(poisCapped, safeDays);

      // 反地理 + 正常化：保證「市/縣 + 區」前置；避免重複區名
      const chosenIds = new Set<string>();
      itinerary.forEach(d=>{
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{ if(p?.place_id) chosenIds.add(p.place_id); });
      });

      for (const p of poisCapped) {
        if (p.place_id && chosenIds.has(p.place_id)) {
          try { p.city = (await reverseCity(p.lat, p.lng)) || extractCityFromAddress(p.address); }
          catch { p.city = extractCityFromAddress(p.address); }
        } else {
          p.city = extractCityFromAddress(p.address);
        }
          ensureCityPrefixed(p);
        await sleep(10);
          }
      // 再保險一次（itinerary 內）
      const normalize = (q?: PlaceOut)=>{ if(q) ensureCityPrefixed(q); };
      for (const d of itinerary) {
        d.morning.forEach(ensureCityPrefixed);
        normalize(d.lunch);
        d.afternoon.forEach(ensureCityPrefixed);
        normalize(d.lodging);
      }

      return NextResponse.json({
          provider: 'google',
        polyline: r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
        end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
          distanceText: r.distanceText,
          durationText: r.durationText,
        pois: poisCapped.map(({__prog, ...rest})=>rest),
        itinerary,
      }, { headers: { 'Cache-Control': 'private, max-age=60' }});

    } else {
      // 無 Google Key：只給路線
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

// export const runtime = 'edge';
