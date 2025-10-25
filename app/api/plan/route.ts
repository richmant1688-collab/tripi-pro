// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/* ---------------- Types ---------------- */
type LatLng = { lat: number; lng: number };
type PlaceType = 'tourist_attraction' | 'restaurant' | 'lodging' | 'amusement_park';
type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  place_id?: string;
  _type: PlaceType;
  city?: string;       // 反地理後加上
  __pct?: number;      // 折線進度（內部用）
};

type DaySlot = {
  morning: PlaceOut[]; // 1–2 景點（含 amusement_park）
  lunch?: PlaceOut;    // 1 餐廳
  afternoon: PlaceOut[]; // 1–2 景點
  lodging?: PlaceOut;    // 1 住宿
};

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'amusement_park', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3;

/** 大型樂園注入的關鍵字 */
const BIG_PARK_QUERIES = [
  '六福村 主題樂園',
  '麗寶 樂園',
  '劍湖山 世界',
  '義大 世界 樂園',
  '義大遊樂世界',
];
const BIG_PARK_NAME_RE = /(六福|麗寶|劍湖山|義大)/;

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
  const la1 = a.lat * Math.PI/180, la2 = b.lat * Math.PI/180;
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(s1*s1 + Math.cos(la1)*Math.cos(la2)*s2*s2));
}
function cumulativeDistances(path: LatLng[]) {
  const acc=[0];
  for (let i=1;i<path.length;i++) acc.push(acc[i-1]+haversineKm(path[i-1],path[i]));
  return acc;
}
/** 投影到折線，回傳距起點 km 與進度 pct */
function progressOnPath(path: LatLng[], cum: number[], p: LatLng) {
  if (path.length<=1) return { km:0, pct:0 };
  let bestKm = 0, bestPct = 0, bestDist = Infinity;
  for (let i=0;i<path.length-1;i++){
    const A=path[i], B=path[i+1];
    const vx=B.lng-A.lng, vy=B.lat-A.lat;
    const wx=p.lng-A.lng, wy=p.lat-A.lat;
    const vv=vx*vx+vy*vy;
    const t = vv===0 ? 0 : Math.max(0, Math.min(1, (wx*vx+wy*vy)/vv));
    const proj:LatLng={ lat:A.lat+vy*t, lng:A.lng+vx*t };
    const d=haversineKm(p, proj);
    if (d<bestDist){
      bestDist=d;
      const km=cum[i] + haversineKm(A, proj);
      bestKm=km;
      const total=cum[cum.length-1] || 1e-9;
      bestPct=Math.max(0, Math.min(1, km/total));
    }
  }
  return { km:bestKm, pct:bestPct };
}

/** 等距取樣（8~16點），避免前段過密 */
function sampleAlongPath(path: LatLng[]) {
  if (!path.length) return [];
  const cum=cumulativeDistances(path);
  const total=cum[cum.length-1];
  const n=Math.min(16, Math.max(8, Math.round(total/35)+8));
  if (n<=1) return [path[0]];
  const out:LatLng[]=[];
  for (let i=0;i<n;i++){
    const target=(i/(n-1))*total;
    let lo=0, hi=cum.length-1;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      if (cum[mid]<target) lo=mid+1; else hi=mid;
    }
    const j=lo;
    if (j===0){ out.push(path[0]); continue; }
    const t0=cum[j-1], t1=cum[j];
    const A=path[j-1], B=path[j];
    const r=t1===t0?0:(target-t0)/(t1-t0);
    out.push({ lat:A.lat+(B.lat-A.lat)*r, lng:A.lng+(B.lng-A.lng)*r });
    }
  const dedup:LatLng[]=[];
  for (const p of out) if (!dedup.some(q=>haversineKm(p,q)<5)) dedup.push(p);
  return dedup;
}
function dynamicRadiusMeters(totalKm:number, pct:number){
  const base=Math.max(3500, Math.min(7000, Math.round(totalKm*18)));
  const tailBoost=Math.round(Math.pow(pct,1.5)*6000);
  return Math.max(3000, Math.min(15000, base+tailBoost));
}
function normTWCity(s?:string){
  if (!s) return s;
  return s.replace(/臺/g,'台');
}

/* ---------------- Google Services ---------------- */
async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const base='https://maps.googleapis.com/maps/api/geocode/json';
  let j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g=j.results[0];
  return { lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address };
}

async function reverseCity(lat:number,lng:number): Promise<{city?:string; district?:string}> {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j=await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const pick = (t:string)=>ac.find(c=>c.types?.includes(t))?.long_name as string|undefined;

  // 台灣多數情況：city 在 level_2 / locality；district 在 sublocality_level_1 / level_3
  const locality = pick('locality');
  const level2 = pick('administrative_area_level_2');
  const level1 = pick('administrative_area_level_1');
  const sublocal = pick('sublocality_level_1') || pick('administrative_area_level_3') || pick('neighborhood');

  const city = normTWCity(locality || level2 || level1);
  const district = normTWCity(sublocal);
  return { city, district };
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
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
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

async function textSearch(query: string) {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`;
  const j=await fetchJson<any>(url);
  if (j.status && j.status!=='OK' && j.status!=='ZERO_RESULTS') return [];
  return Array.isArray(j.results)? j.results : [];
}

/** 評分：星等×人氣×近樣本×前進加權；大型樂園給 Bonus */
function scorePlace(p:any, distKm:number|undefined, progressPct:number, forceBig=false){
  const rating=p.rating||0;
  const urt=p.user_ratings_total||1;
  const pop=Math.log10(urt+1)+1;
  const prox= typeof distKm==='number' ? 1/(1+distKm/5) : 1;
  const forward = 0.6 + 0.8 * progressPct;
  const big = forceBig || BIG_PARK_NAME_RE.test((p.name||'') as string);
  const bigBoost = big ? 1.8 : 1.0;
  return rating * pop * prox * forward * bigBoost;
}

/* ---------------- POI 收集：沿途 + 大型樂園注入 ---------------- */
async function placesAlongRoute(path:LatLng[]){
  const cum=cumulativeDistances(path);
  const totalKm=cum[cum.length-1] || 1;
  const samples=sampleAlongPath(path);

  const byId=new Map<string,{item:PlaceOut,score:number,pct:number}>();

  for (const s of samples){
    const { pct } = progressOnPath(path, cum, s);
    const radius=dynamicRadiusMeters(totalKm, pct);

    for (const t of TYPES){
      const arr=await nearby(s, t, radius);
      for (const p of arr){
        const id=p.place_id as string|undefined; if (!id) continue;

        if (t==='amusement_park'){
          const urt=p.user_ratings_total||0;
          const name:string=p.name||'';
          if (!BIG_PARK_NAME_RE.test(name) && urt < 500) continue; // 小型親子館濾掉
      }

        const loc:LatLng={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
        const d=haversineKm(s, loc);
        const { pct:pp }=progressOnPath(path, cum, loc);
        const sc=scorePlace(p, d, pp);
        const item:PlaceOut={ name:p.name, lat:loc.lat, lng:loc.lng, address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t, __pct:pp };
        const cur=byId.get(id);
        if (!cur || sc>cur.score) byId.set(id,{ item, score:sc, pct:pp });
      }
      await sleep(70);
    }
    }

  // 大型樂園全國注入（距路徑 <= 30km，進度 5%~98%）
  for (const q of BIG_PARK_QUERIES){
    const parks=await textSearch(q);
    for (const p of parks){
      const id=p.place_id as string|undefined; if (!id) continue;
      const loc:LatLng={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };

      let bestD=Infinity;
      for (const v of path) bestD=Math.min(bestD, haversineKm(loc, v));
      if (bestD>30) continue;

      const { pct:pp }=progressOnPath(path, cum, loc);
      if (pp<0.05 || pp>0.98) continue;

      const sc=scorePlace(p, bestD, pp, true);
      const item:PlaceOut={ name:p.name, lat:loc.lat, lng:loc.lng, address:p.formatted_address||p.vicinity, rating:p.rating, place_id:id, _type:'amusement_park', __pct:pp };
      const cur=byId.get(id);
      if (!cur || sc>cur.score) byId.set(id,{ item, score:sc, pct:pp });
      }
    await sleep(120);
  }

  const list = Array.from(byId.values())
    .sort((a,b)=> a.pct - b.pct || b.score - a.score)
    .map(x=>x.item);

  return { list, cum, totalKm };
}

async function placesSingleCenter(center:LatLng): Promise<PlaceOut[]>{
  const byId=new Map<string,{item:PlaceOut,score:number}>();
  for (const t of TYPES){
    const arr=await nearby(center, t, 4000);
    for (const p of arr){
      const id=p.place_id as string|undefined; if (!id) continue;
      if (t==='amusement_park'){
        const urt=p.user_ratings_total||0;
        const name:string=p.name||'';
        if (!BIG_PARK_NAME_RE.test(name) && urt<500) continue;
      }
      const loc={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
      const sc=(p.rating||0) * (Math.log10((p.user_ratings_total||1)+1)+1);
      const item:PlaceOut={ name:p.name, lat:loc.lat, lng:loc.lng, address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t, __pct:0 };
      const cur=byId.get(id); if (!cur || sc>cur.score) byId.set(id,{item,score:sc});
    }
    await sleep(70);
        }
  return Array.from(byId.values()).sort((a,b)=>b.score-a.score).map(x=>x.item);
}

/* ---------------- 行程切日（嚴格前進視窗，不向過去借點） ---------------- */
function planAgencyStrictForward(pois:PlaceOut[], days:number, path:LatLng[], cum:number[]): DaySlot[] {
  const totalDays = Math.max(1, days|0);
  const used = new Set<string>(); // 使用過的 place_id

  // 依進度排序
  const arr = [...pois].sort((a,b)=>(a.__pct??0)-(b.__pct??0));

  const daySlots: DaySlot[] = Array.from({length:totalDays}, ()=>({ morning:[], afternoon:[] }));

  function takeFromWindow(startPct:number, endPct:number, want:number, pred:(p:PlaceOut)=>boolean): PlaceOut[] {
    const picked:PlaceOut[]=[];
    // 先在視窗內取
    for (let i=0;i<arr.length && picked.length<want;i++){
      const p=arr[i];
      if (used.has(p.place_id||`@${i}`)) continue;
      const pct = p.__pct ?? 0;
      if (pct>=startPct && pct<endPct && pred(p)) {
        picked.push(p); used.add(p.place_id||`@${i}`);
      }
    }
    // 若不足，僅向「未來」擴張（不往前）
    let expand = endPct;
    while (picked.length < want && expand < 1.0001) {
      const nextEnd = Math.min(1.0001, expand + 0.12); // 逐步放寬
      for (let i=0;i<arr.length && picked.length<want;i++){
        const p=arr[i];
        if (used.has(p.place_id||`@${i}`)) continue;
        const pct = p.__pct ?? 0;
        if (pct>=expand && pct<nextEnd && pred(p)) {
          picked.push(p); used.add(p.place_id||`@${i}`);
        }
      }
      expand = nextEnd;
      if (expand >= 1.0001) break;
    }
    return picked;
  }

  for (let d=0; d<totalDays; d++){
    const startPct = d / totalDays;
    const endPct   = (d+1) / totalDays;

    // 景點優先：大型樂園 > 一般景點
    const isAttraction = (p:PlaceOut)=> p._type==='amusement_park' || p._type==='tourist_attraction';

    // 早上 1–2
    const morning = takeFromWindow(startPct, endPct, 2, isAttraction);
    // 下午 1–2（排除上午已拿者）
    const afternoon = takeFromWindow(startPct, endPct, Math.max(0, 2 - Math.max(0, morning.length-1)), isAttraction);

    daySlots[d].morning = morning.slice(0,2);
    daySlots[d].afternoon = afternoon.slice(0,2);

    // 午餐：靠近本日幾何中心（向未來擴張選餐廳）
    const pts=[...daySlots[d].morning, ...daySlots[d].afternoon];
    if (pts.length){
      const cx=pts.reduce((s,p)=>s+p.lat,0)/pts.length;
      const cy=pts.reduce((s,p)=>s+p.lng,0)/pts.length;
      const resto = takeFromWindow(startPct, endPct, 1, p=>p._type==='restaurant')
        .concat(takeFromWindow(endPct, endPct+0.2, 1, p=>p._type==='restaurant'))
        .sort((a,b)=>{
          const da=haversineKm({lat:cx,lng:cy},{lat:a.lat,lng:a.lng});
          const db=haversineKm({lat:cx,lng:cy},{lat:b.lat,lng:b.lng});
          const ra=(a.rating||0), rb=(b.rating||0);
          return (ra/ (1+da/5)) > (rb/(1+db/5)) ? -1 : 1;
        })[0];
      if (resto) daySlots[d].lunch = resto;
    }

    // 住宿：靠近午後最後一個點；若無則靠近本日最後一點
    const anchor = daySlots[d].afternoon[daySlots[d].afternoon.length-1] || daySlots[d].morning[daySlots[d].morning.length-1];
    if (anchor){
      const hotel = takeFromWindow(startPct, endPct+0.15, 1, p=>p._type==='lodging')
        .sort((a,b)=>{
          const da=haversineKm(anchor,{lat:a.lat,lng:a.lng});
          const db=haversineKm(anchor,{lat:b.lat,lng:b.lng});
          const ra=(a.rating||0), rb=(b.rating||0);
          return (ra/ (1+da/5)) > (rb/(1+db/5)) ? -1 : 1;
        })[0];
      if (hotel) daySlots[d].lodging = hotel;
    }
  }

  return daySlots;
}

/* ---------------- 地址前置（只處理入選點，避免重複） ---------------- */
function prependCityToAddress(p: PlaceOut, city?: string, district?: string) {
  const parts:string[]=[];
  if (city) parts.push(city);
  if (district) parts.push(district);
  const prefix = parts.join(' · ');

  if (!prefix) return;

    const addr = p.address || '';
  // 已含 city 則不再重複；若已含 district 但缺 city，補 city 前綴即可
    if (city && addr.includes(city)) return;
  if (district && addr.includes(district)) {
    p.address = city ? `${city} · ${addr}` : addr;
    return;
  }
  p.address = `${prefix} · ${addr}`;
}

/* ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days: _days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json(
        { error:'bad_request', detail:'origin/destination required' },
        { status:400, headers:{ 'Cache-Control':'no-store' } }
      );
    }
    const days = Math.max(1, Math.min(14, Number(_days)||5));
    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (!hasGoogle) {
      // 無金鑰：回傳最小骨架
      return NextResponse.json({
        provider:'osrm',
          polyline: [],
        start:{ lat:0, lng:0, address: origin },
        end:{ lat:0, lng:0, address: destination },
        distanceText:'', durationText:'',
        pois:[], itinerary:[]
      }, { headers:{ 'Cache-Control':'no-store' }});
    }

    // 1) 路線
      const r = await routeGoogle(origin, destination);
    const startLL={lat:r.start.lat,lng:r.start.lng}, endLL={lat:r.end.lat,lng:r.end.lng};
    const nearlySame = haversineKm(startLL,endLL) <= NEAR_EQ_KM;

    // 2) POIs
      let pois: PlaceOut[] = [];
    let path: LatLng[] = [startLL, endLL];
    let cum = [0, haversineKm(startLL,endLL)];

    if (nearlySame) {
      pois = await placesSingleCenter(startLL);
      } else {
      const along = await placesAlongRoute(r.polyline);
      pois = along.list.slice(0, 90);
      path = r.polyline;
      cum = along.cum;
      }

    // 3) 切日（嚴格前進）
    const itinerary = planAgencyStrictForward(pois, days, path, cum);

    // 4) 只對「入選」反地理，加上「縣市 · 區」前綴
    const chosen = new Set<string>();
    itinerary.forEach(d=>{
      [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{
        if (p?.place_id) chosen.add(p.place_id);
      });
      });

      for (const p of pois) {
      if (!p.place_id || !chosen.has(p.place_id)) continue;
        try {
        const { city, district } = await reverseCity(p.lat, p.lng);
        if (city) p.city = city;
        prependCityToAddress(p, city, district);
        await sleep(40);
      } catch {}
      }

    return NextResponse.json({
        provider: 'google',
      polyline: path.map(({lat,lng})=>[lat,lng]) as [number,number][],
      start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
      end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,
        itinerary,
    }, { headers: { 'Cache-Control': 'private, max-age=60' } });

  } catch (e:any) {
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json(
      { error:'server_error', detail:e?.message||'Unknown error' },
      { status, headers:{ 'Cache-Control':'no-store' } }
    );
  }
}
