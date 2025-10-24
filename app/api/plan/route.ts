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
  city?: string;
};
type DaySlot = { morning: PlaceOut[]; lunch?: PlaceOut; afternoon: PlaceOut[]; lodging?: PlaceOut };

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3;

/* ---------------- utils ---------------- */
function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }
async function fetchJson<T=any>(url:string, init?:RequestInit){ const r=await fetch(url,{cache:'no-store',...init}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<T>; }
function haversineKm(a:LatLng,b:LatLng){ const R=6371,dLa=(b.lat-a.lat)*Math.PI/180,dLo=(b.lng-a.lng)*Math.PI/180,la1=a.lat*Math.PI/180,la2=b.lat*Math.PI/180,s1=Math.sin(dLa/2),s2=Math.sin(dLo/2); return 2*R*Math.asin(Math.sqrt(s1*s1+Math.cos(la1)*Math.cos(la2)*s2*s2)); }
function cumulativeLengthKm(path:LatLng[]){ const acc=[0]; for(let i=1;i<path.length;i++) acc.push(acc[i-1]+haversineKm(path[i-1],path[i])); return acc; }
function sampleAlongPathDynamic(path:LatLng[]){
  if(!path.length) return [];
  const cum=cumulativeLengthKm(path), total=cum[cum.length-1];
  if(total===0) return [path[0]];
  const step=Math.max(10, Math.min(30, total/28));
  const n=Math.min(64, Math.max(6, Math.round(total/step)+1));
  const out:LatLng[]=[];
  for(let i=0;i<n;i++){
    const target=(i/(n-1))*total; let j=0; while(j<cum.length && cum[j]<target) j++;
    if(j===0) out.push(path[0]);
    else if(j>=cum.length) out.push(path[path.length-1]);
    else {
      const t0=cum[j-1], t1=cum[j], A=path[j-1], B=path[j];
      const r=t1===t0?0:(target-t0)/(t1-t0);
      out.push({lat:A.lat+(B.lat-A.lat)*r, lng:A.lng+(B.lng-A.lng)*r});
    }
  }
  const dedup:LatLng[]=[]; for(const p of out){ if(!dedup.some(q=>haversineKm(p,q)<6)) dedup.push(p); }
  return dedup;
}
function dynamicRadiusMeters(totalKm:number){ return Math.min(42000, Math.max(14000, Math.round(totalKm*40))); }
function extractCityFromAddress(addr?:string){
  if(!addr) return;
  const rep=addr.replace(/台北/g,'臺北').replace(/台中/g,'臺中').replace(/台南/g,'臺南').replace(/台東/g,'臺東');
  const m = rep.match(/([^\s·,，。]{1,6}[市縣])\s*([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  if (m) return `${m[1]} ${m[2]}`;
  const m2 = rep.match(/([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  return m2?.[1];
}
function ensureCityPrefixed(p:PlaceOut){
  const city = p.city || extractCityFromAddress(p.address); if(!city) return;
  if(p.address){
    const a=p.address.replace(/\s+/g,''), c=city.replace(/\s+/g,'');
    const dist=city.split(' ')[1];
    if(a.startsWith(c) || (dist && a.startsWith(dist))) return;
  }
  p.city=city; p.address = p.address ? `${city} · ${p.address}` : city;
}

/* ---------------- Google APIs ---------------- */
async function geocodeGoogle(q:string){
  const k=process.env.GOOGLE_MAPS_API_KEY!;
  const base='https://maps.googleapis.com/maps/api/geocode/json';
  let j=await fetchJson<any>(`${base}?address=${encodeURIComponent(q)}&language=${LANG}&region=tw&key=${k}`);
  if(!j.results?.[0]) j=await fetchJson<any>(`${base}?address=${encodeURIComponent(q)}&language=${LANG}&key=${k}`);
  if(!j.results?.[0]) throw new Error(j.error_message||'geocode_failed');
  const g=j.results[0];
  return {lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address};
}
async function reverseCity(lat:number,lng:number){
  try{
    const k=process.env.GOOGLE_MAPS_API_KEY!;
    const j=await fetchJson<any>(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${k}`);
    const ac:any[]=j.results?.[0]?.address_components||[];
    const f=(t:string)=>ac.find(c=>c.types?.includes(t))?.long_name;
    const a1=f('administrative_area_level_1'), a2=f('administrative_area_level_2'), loc=f('locality'), sub=f('sublocality_level_1');
    const city=(a2&&/[市縣]$/.test(a2)?a2:undefined)||(a1&&/[市縣]$/.test(a1)?a1:undefined)||(loc&&/[市縣]$/.test(loc)?loc:undefined);
    const dist=(loc&&/[區鄉鎮市]$/.test(loc)?loc:undefined)||(sub&&/[區鄉鎮市]$/.test(sub)?sub:undefined);
    return city&&dist?`${city} ${dist}`:city||dist||undefined;
  }catch{ return undefined; }
}
async function routeGoogle(origin:string,destination:string){
  const k=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=tw&mode=driving&key=${k}`;
  const j=await fetchJson<any>(url);
  if(j.status!=='OK'||!j.routes?.[0]) throw new Error(j.error_message||j.status||'directions_failed');
  const r=j.routes[0], leg=r.legs[0];
  const coords=polyline.decode(r.overview_polyline.points).map(([lat,lng]:[number,number])=>({lat,lng}));
  return {
    polyline:coords as LatLng[],
    start:{lat:leg.start_location.lat,lng:leg.start_location.lng,address:leg.start_address},
    end:{lat:leg.end_location.lat,lng:leg.end_location.lng,address:leg.end_address},
    distanceText:leg.distance.text, durationText:leg.duration.text
  };
}
async function nearby(center:LatLng,type:PlaceType,r:number){
  const k=process.env.GOOGLE_MAPS_API_KEY!;
  const j=await fetchJson<any>(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${center.lat},${center.lng}&radius=${r}&type=${encodeURIComponent(type)}&language=${LANG}&key=${k}`);
  if(j.status && j.status!=='OK' && j.status!=='ZERO_RESULTS') return [];
  return Array.isArray(j.results)?j.results:[];
}
function scorePlace(p:any,distKm?:number){
  const rating=p.rating||0, urt=p.user_ratings_total||1;
  const pop=Math.log10(urt+1)+1;
  const prox=typeof distKm==='number'?1/(1+distKm/5):1;
  return rating*pop*prox;
}
function progressRatio(path:LatLng[],pt:LatLng){
  let best=Infinity, bi=0;
  for(let i=0;i<path.length;i++){ const d=haversineKm(pt,path[i]); if(d<best){best=d; bi=i;} }
  return path.length>1? bi/(path.length-1):0;
}
async function placesAlongRoute(path:LatLng[]):Promise<Array<PlaceOut & {__prog:number}>>{
  const samples=sampleAlongPathDynamic(path);
  const total=haversineKm(path[0],path[path.length-1]);
  const radius=dynamicRadiusMeters(total);
  const map=new Map<string,{item:PlaceOut & {__prog:number},score:number}>();
  for(const s of samples){
    for(const t of TYPES){
      const arr=await nearby(s,t,radius);
      for(const p of arr){
        const id=p.place_id as string|undefined; if(!id) continue;
        const loc:LatLng={lat:p.geometry.location.lat,lng:p.geometry.location.lng};
        const item:PlaceOut & {__prog:number}={
          name:p.name,lat:loc.lat,lng:loc.lng,
          address:p.vicinity||p.formatted_address,
          rating:p.rating,place_id:id,_type:t,
          __prog:progressRatio(path,loc)
        };
        const sc=scorePlace(p,haversineKm(s,loc));
        const cur=map.get(id);
        if(!cur||sc>cur.score) map.set(id,{item,score:sc});
    }
      await sleep(40);
  }
  }
  return Array.from(map.values()).map(x=>x.item).sort((a,b)=> a.__prog-b.__prog || (b.rating??0)-(a.rating??0));
}

/* ---------------- itinerary: NO-BACKTRACK guarantee ---------------- */
function buildItinerarySouthbound(sorted:Array<PlaceOut & {__prog:number}>, days:number): DaySlot[] {
  const it:DaySlot[]=Array.from({length:days},()=>({morning:[],afternoon:[]}));
  if(!sorted.length) return it;

  const A=sorted.filter(p=>p._type==='tourist_attraction');
  const R=sorted.filter(p=>p._type==='restaurant');
  const H=sorted.filter(p=>p._type==='lodging');

  const used=new Set<string>();
  const key=(p:PlaceOut)=>p.place_id || `${p.name}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const eps = 0.01;            // 最小前進步長
  let lastProg = -eps;         // 上日最大進度

    const remain = (arr:typeof A)=>arr.filter(p=>!used.has(key(p)));

  for(let d=0; d<days; d++){
    const s=d/days, e=(d+1)/days, mid=(s+e)/2, target=(s+e)/2;
    const fwdMin = lastProg + eps;   // 當天所有選點必須 > fwdMin

    // 1) 當日區間內且往前
    let cand = remain(A).filter(p=>p.__prog>fwdMin && p.__prog<e);

    // 2) 不足 → 放寬到 e+0.25（仍需 > fwdMin）
    if (cand.length < 2) {
      const more = remain(A).filter(p=>p.__prog>fwdMin && p.__prog<Math.min(1, e+0.25));
      const ids=new Set(cand.map(key)); for(const x of more){ if(!ids.has(key(x))) cand.push(x); }
    }

    // 3) 全域補點（仍需 > fwdMin）
    if (cand.length < 2) {
      const global = remain(A)
        .filter(p=>p.__prog>fwdMin)
        .sort((a,b)=> (Math.abs(a.__prog-target)-Math.abs(b.__prog-target)) || (b.rating??0)-(a.rating??0));
      for (const g of global){
        if (cand.length>=4) break;
        if (!cand.find(x=>key(x)===key(g))) cand.push(g);
      }
    }

    // 4) 最後保底：若仍 <2，找「進度 > fwdMin」的最前面幾個（純前進，不回頭）
    if (cand.length < 2) {
      const anyFwd = remain(A).filter(p=>p.__prog>fwdMin).sort((a,b)=> a.__prog-b.__prog || (b.rating??0)-(a.rating??0));
      for (const g of anyFwd){
        if (cand.length>=2) break;
        if (!cand.find(x=>key(x)===key(g))) cand.push(g);
      }
    }

    // 排序與裁切
    cand = cand
      .sort((a,b)=> (Math.abs(a.__prog-target)-Math.abs(b.__prog-target)) || (b.rating??0)-(a.rating??0))
      .slice(0,4);

    cand.forEach(p=>used.add(key(p)));

    const first=cand.filter(p=>p.__prog<=mid), second=cand.filter(p=>p.__prog>mid);
    const morning=(first.length?first:cand.slice(0,Math.min(2,cand.length))).slice(0,2);
    const afternoon=(second.length?second:cand.slice(morning.length)).slice(0,2);
    it[d].morning=morning;
    it[d].afternoon=afternoon;

    // 更新 lastProg（如果當天仍沒選到點，就把進度推到 e）
    const todayMax = cand.length ? Math.max(...cand.map(p=>p.__prog)) : e;
    lastProg = Math.max(lastProg, todayMax);

    // 午餐：盡量選「__prog ≥ fwdMin」且接近今日點群中心；若當日無點，則挑接近 target 且 __prog ≥ fwdMin 的餐廳
    if(R.length){
    let best:PlaceOut|undefined, bs=-1;
      const poolBase = R.filter((r:any)=> r.__prog>=fwdMin);
      if (poolBase.length){
        const pts=[...morning, ...afternoon];
      if(pts.length){
        const cx=pts.reduce((s,p)=>s+p.lat,0)/pts.length, cy=pts.reduce((s,p)=>s+p.lng,0)/pts.length;
          for(const r of poolBase){
          const sc=(r.rating||0)/(1+haversineKm({lat:cx,lng:cy},{lat:r.lat,lng:r.lng})/5);
          if(sc>bs){bs=sc; best=r;}
        }
      }else{
          best = poolBase
            .slice()
            .sort((a:any,b:any)=> Math.abs(a.__prog-target)-Math.abs(b.__prog-target) || (b.rating??0)-(a.rating??0))[0];
        }
      }
      if(best) it[d].lunch=best;
  }

    // 住宿：優先「__prog ≥ max(fwdMin, e-0.15)」，接近 e 的旅館；若找不到，再放寬只要 ≥ fwdMin
    if(H.length){
      const lower = Math.max(fwdMin, e-0.15);
    const usedHotels=new Set<string>(it.slice(0,d).map(x=>x.lodging).filter(Boolean).map(h=>key(h!)));
      const pref = H
        .filter((h:any)=>h.__prog>=lower && !usedHotels.has(key(h)))
        .sort((a:any,b:any)=> Math.abs(a.__prog-e)-Math.abs(b.__prog-e) || (b.rating??0)-(a.rating??0));
      const alt  = H
        .filter((h:any)=>h.__prog>=fwdMin && !usedHotels.has(key(h)))
        .sort((a:any,b:any)=> Math.abs(a.__prog-e)-Math.abs(b.__prog-e) || (b.rating??0)-(a.rating??0));
      const hotel = pref[0] || alt[0];
    if(hotel) it[d].lodging=hotel;
  }
  }

  return it;
}

/* ---------------- OSM/OSRM fallback ---------------- */
async function geocodeOSM(q:string){ const j=await fetchJson<any>(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`); if(!Array.isArray(j)||!j[0]) throw new Error('geocode_failed'); return {lat:parseFloat(j[0].lat), lng:parseFloat(j[0].lon), formatted:j[0].display_name}; }
async function routeOSRM(o:LatLng,d:LatLng){ const j=await fetchJson<any>(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`); if(!j.routes?.[0]) throw new Error('route_failed'); const r=j.routes[0]; const coords=r.geometry.coordinates.map(([lng,lat]:[number,number])=>({lat,lng})); return { polyline:coords as LatLng[], distanceText:(r.distance/1000).toFixed(1)+' km', durationText: Math.round(r.duration/60)+' 分鐘' }; }

/* ---------------- Handler ---------------- */
export async function POST(req:NextRequest){
  try{
    const body=await req.json().catch(()=>({})); const { origin, destination, days=5 } = body||{};
    if(!origin||!destination) return NextResponse.json({error:'bad_request',detail:'origin/destination required'},{status:400,headers:{'Cache-Control':'no-store'}});

    if(process.env.GOOGLE_MAPS_API_KEY){
      const r=await routeGoogle(origin,destination);
      const start={lat:r.start.lat,lng:r.start.lng}, end={lat:r.end.lat,lng:r.end.lng};
      const close=haversineKm(start,end)<=NEAR_EQ_KM;

      let cands:Array<PlaceOut & {__prog:number}>=[];

      if(close){
        const k=process.env.GOOGLE_MAPS_API_KEY!;
        for(const t of TYPES){
          const j=await fetchJson<any>(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${start.lat},${start.lng}&radius=5000&type=${t}&language=${LANG}&key=${k}`);
          const arr = Array.isArray(j.results)?j.results:[];
          for(const p of arr){
            const id=p.place_id as string|undefined; if(!id) continue;
            cands.push({ name:p.name, lat:p.geometry.location.lat, lng:p.geometry.location.lng, address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t, __prog:0 });
          }
          await sleep(30);
        }
        cands.sort((a,b)=>(b.rating??0)-(a.rating??0));
      }else{
        cands = await placesAlongRoute(r.polyline);
          }

      const cap=cands.slice(0,220);
      const safeDays=Math.max(1,Math.min(14, Number.isFinite(days)?days:5));
      const itinerary=buildItinerarySouthbound(cap, safeDays);

      // 只對入選點做反地理 & 正常化
      const chosenIds=new Set<string>(); itinerary.forEach(d=>[...d.morning,d.lunch,...d.afternoon,d.lodging].forEach((p:any)=>{ if(p?.place_id) chosenIds.add(p.place_id); }));
      for(const p of cap){
        if(p.place_id && chosenIds.has(p.place_id)){ try{ p.city=(await reverseCity(p.lat,p.lng))||extractCityFromAddress(p.address); }catch{ p.city=extractCityFromAddress(p.address); } }
        else { p.city=extractCityFromAddress(p.address); }
        ensureCityPrefixed(p); await sleep(6);
      }
      const norm=(q?:PlaceOut)=>{ if(q) ensureCityPrefixed(q); };
      for(const d of itinerary){ d.morning.forEach(ensureCityPrefixed); norm(d.lunch); d.afternoon.forEach(ensureCityPrefixed); norm(d.lodging); }

      return NextResponse.json({
        provider:'google',
        polyline:r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start:{lat:r.start.lat,lng:r.start.lng,address:r.start.address},
        end:{lat:r.end.lat,lng:r.end.lng,address:r.end.address},
        distanceText:r.distanceText, durationText:r.durationText,
        pois: cap.map(({__prog, ...rest})=>rest),
        itinerary,
      }, { headers:{'Cache-Control':'private, max-age=60'} });

    }else{
      const o=await geocodeOSM(origin), d=await geocodeOSM(destination);
      const ro=await routeOSRM({lat:o.lat,lng:o.lng},{lat:d.lat,lng:d.lng});
      return NextResponse.json({ provider:'osrm', polyline:ro.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][], start:{lat:o.lat,lng:o.lng,address:o.formatted}, end:{lat:d.lat,lng:d.lng,address:d.formatted}, distanceText:ro.distanceText, durationText:ro.durationText, pois:[], itinerary:[] }, { headers:{'Cache-Control':'no-store'}});
    }
  }catch(e:any){
    const status = e?.name==='AbortError'?504:500;
    return NextResponse.json({error:'server_error',detail:e?.message||'Unknown error'},{status,headers:{'Cache-Control':'no-store'}});
  }
}

// export const runtime = 'edge';
