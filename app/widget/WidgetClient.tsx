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
  morning: PlaceOut[]; // 景點 1–2
  lunch?: PlaceOut;    // 餐廳 1
  afternoon: PlaceOut[]; // 景點 1–2
  lodging?: PlaceOut;    // 住宿 1
};

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3;

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }
async function fetchJson<T=any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<T>;
}
function haversineKm(a: LatLng, b: LatLng) {
  const R=6371; const dLat=(b.lat-a.lat)*Math.PI/180, dLng=(b.lng-a.lng)*Math.PI/180;
  const la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(s1*s1+Math.cos(la1)*Math.cos(la2)*s2*s2));
}
function cumulativeLengthKm(path: LatLng[]) {
  const acc=[0]; for(let i=1;i<path.length;i++) acc.push(acc[i-1]+haversineKm(path[i-1],path[i])); return acc;
}
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum=cumulativeLengthKm(path), total=cum[cum.length-1];
  if (total===0) return [path[0]];
  const step=Math.max(20, Math.min(50, total/15)), n=Math.min(24, Math.max(2, Math.round(total/step)+1));
  const out:LatLng[]=[];
  for (let i=0;i<n;i++){
    const target=(i/(n-1))*total; let j=0; while(j<cum.length && cum[j]<target) j++;
    if (j===0) out.push(path[0]);
    else if (j>=cum.length) out.push(path[path.length-1]);
    else {
      const t0=cum[j-1], t1=cum[j]; const A=path[j-1], B=path[j];
      const r=t1===t0?0:(target-t0)/(t1-t0);
      out.push({ lat: A.lat+(B.lat-A.lat)*r, lng: A.lng+(B.lng-A.lng)*r });
    }
  }
  // 去重（<5km）
  const dedup:LatLng[]=[]; for(const p of out){ if(!dedup.some(q=>haversineKm(p,q)<5)) dedup.push(p); }
  return dedup;
}
function dynamicRadiusMeters(totalKm:number){ return Math.min(15000, Math.max(5000, Math.round(totalKm*20))); }

async function geocodeGoogle(query: string): Promise<LatLng & { formatted: string }> {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const base='https://maps.googleapis.com/maps/api/geocode/json';
  let j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=tw&key=${key}`);
  if (!j.results?.[0]) j=await fetchJson<any>(`${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`);
  if (!j.results?.[0]) throw new Error(j.error_message || 'geocode_failed');
  const g=j.results[0]; return { lat:g.geometry.location.lat, lng:g.geometry.location.lng, formatted:g.formatted_address };
}

async function reverseCity(lat:number,lng:number): Promise<string|undefined> {
  const key=process.env.GOOGLE_MAPS_API_KEY!;
  const url=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j=await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const find = (t:string)=>ac.find(c=>c.types?.includes(t))?.long_name;
  const lvl1=find('administrative_area_level_1');
  const lvl2=find('administrative_area_level_2') || find('locality');
  const sub =find('sublocality_level_1') || find('political');
  const parts=[lvl2, sub].filter(Boolean);
  return parts.length ? parts.join(' ') : lvl1 || undefined;
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

function scorePlace(p:any, distKm?:number) {
  const rating=p.rating||0, urt=p.user_ratings_total||1;
  const pop=Math.log10(urt+1)+1;
  const prox= typeof distKm==='number' ? 1/(1+distKm/5) : 1;
  return rating*pop*prox;
}

/** 沿途：多類型合併；回傳附帶 place_id/_type */
async function placesAlongRoute(path:LatLng[]): Promise<PlaceOut[]> {
  const samples=sampleAlongPathDynamic(path);
  const totalKm=haversineKm(path[0], path[path.length-1]);
  const radius=dynamicRadiusMeters(totalKm);
  const byId=new Map<string,{item:PlaceOut,score:number,progress:number}>();

  // 預先算每個點在折線上的「進度」（用最近頂點索引近似）
  const progressOf = (pt:LatLng) => {
    let best=0, bi=0;
    for (let i=0;i<path.length;i++){
      const d=haversineKm(pt, path[i]);
      if (i===0 || d<best){ best=d; bi=i; }
    }
    return bi; // 以頂點索引做近似進度
  };

  for (const s of samples){
    for (const t of TYPES){
      const arr=await nearby(s, t, radius);
      for (const p of arr){
        const id=p.place_id as string|undefined; if (!id) continue;
        const loc:LatLng={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
        const dist=haversineKm(s, loc);
        const sc=scorePlace(p, dist);
        const item:PlaceOut={ name:p.name, lat:loc.lat, lng:loc.lng, address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t };
        const pr=progressOf(loc);
        const cur=byId.get(id);
        if (!cur || sc>cur.score) byId.set(id, { item, score: sc, progress: pr });
      }
      await sleep(80);
    }
  }

  // 依「沿路前進進度」排序，避免一天來回南北
  return Array.from(byId.values())
    .sort((a,b)=> a.progress - b.progress || b.score - a.score)
    .map(x=>x.item);
}

/** 單點：多類型 Nearby */
async function placesSingleCenter(center:LatLng): Promise<PlaceOut[]> {
  const byId=new Map<string,{item:PlaceOut,score:number}>();
  for (const t of TYPES){
    const arr=await nearby(center, t, 3000);
    for (const p of arr){
      const id=p.place_id as string|undefined; if (!id) continue;
      const loc={ lat:p.geometry.location.lat, lng:p.geometry.location.lng };
      const sc=scorePlace(p);
      const item:PlaceOut={ name:p.name, lat:loc.lat, lng:loc.lng, address:p.vicinity||p.formatted_address, rating:p.rating, place_id:id, _type:t };
      const cur=byId.get(id); if (!cur || sc>cur.score) byId.set(id,{item,score:sc});
    }
    await sleep(80);
  }
  return Array.from(byId.values()).sort((a,b)=>b.score-a.score).map(x=>x.item);
}

/** 以「沿路前進順序」分天，再切早/午/晚 */
function buildAgencyStyleItinerary(pois:PlaceOut[], days:number): DaySlot[] {
  // 只拿景點作骨架；餐廳/住宿待會填補
  const attractions=pois.filter(p=>p._type==='tourist_attraction');
  const perDay=Math.max(2, Math.min(4, Math.ceil(attractions.length / days))); // 每天 2–4 個景點
  const itinerary:DaySlot[] = Array.from({length:days}, ()=>({ morning:[], afternoon:[] }));

  for (let d=0; d<days; d++){
    const seg=attractions.slice(d*perDay, (d+1)*perDay);
    const morning = seg.slice(0, Math.min(2, seg.length));
    const afternoon = seg.slice(morning.length, Math.min(morning.length+2, seg.length));
    itinerary[d].morning = morning;
    itinerary[d].afternoon = afternoon;
  }

  // 為每一天挑餐廳（靠近當日所有景點幾何中心）
  for (let d=0; d<days; d++){
    const slots=itinerary[d];
    const dayPts=[...slots.morning, ...slots.afternoon];
    if (dayPts.length===0) continue;
    const cx=dayPts.reduce((s,p)=>s+p.lat,0)/dayPts.length;
    const cy=dayPts.reduce((s,p)=>s+p.lng,0)/dayPts.length;
    // 從原本 POIs 中找距離中心最近且評分高的餐廳
    const candidates=pois.filter(p=>p._type==='restaurant');
    let best:PlaceOut|undefined, bs=-1;
    for (const r of candidates){
      const sc = (r.rating||0) / (1 + haversineKm({lat:cx,lng:cy}, {lat:r.lat,lng:r.lng})/5);
      if (sc>bs){ bs=sc; best=r; }
    }
    if (best) itinerary[d].lunch = best;
  }

  // 為每一天挑住宿（靠近下午最後一點；最後一天若沒有就靠近該天任意點）
  for (let d=0; d<days; d++){
    const slots=itinerary[d];
    const anchor = slots.afternoon[slots.afternoon.length-1] || slots.morning[slots.morning.length-1];
    if (!anchor) continue;
    const hotels=pois.filter(p=>p._type==='lodging');
    let best:PlaceOut|undefined, bs=-1;
    for (const h of hotels){
      const sc = (h.rating||0) / (1 + haversineKm({lat:anchor.lat,lng:anchor.lng}, {lat:h.lat,lng:h.lng})/5);
      if (sc>bs){ bs=sc; best=h; }
    }
    if (best) itinerary[d].lodging = best;
  }

  return itinerary;
}

/* ---------------- OSM/OSRM fallback（無 Google Key） ---------------- */
async function geocodeOSM(query: string) {
  const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const r=await fetch(url,{ headers:{'Accept-Language':LANG}, cache:'no-store'}); const j=await r.json();
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

      let pois: PlaceOut[] = [];
      if (isSingle) {
        pois = await placesSingleCenter(startLL);
      } else {
        const along = await placesAlongRoute(r.polyline);
        // 只保留前 60，避免過量
        pois = along.slice(0, 60);
      }

      // === 依「旅行社風格」產出 itinerary（避免同日拉鋸） ===
      const itinerary = buildAgencyStyleItinerary(pois, days);

      // === 只對「入選的點」補上 city 並把 city 前置到 address ===
      const chosen = new Set<string>();
      itinerary.forEach(d=>{
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{
          if (p?.place_id) chosen.add(p.place_id);
        });
      });

      for (const p of pois) {
        if (!p.place_id || !chosen.has(p.place_id)) continue;
        try {
          const city = await reverseCity(p.lat, p.lng);
          p.city = city;
          if (p.address) {
            p.address = city ? `${city} · ${p.address}` : p.address;
          } else if (city) {
            p.address = city;
          }
          await sleep(50);
        } catch {}
      }

      return NextResponse.json({
        provider: 'google',
        polyline: r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
        end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois,            // 舊欄位（扁平）
        itinerary,       // 新欄位（早/午/晚）
      }, { headers: { 'Cache-Control': 'private, max-age=60' }});

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
      }, { headers:{'Cache-Control':'no-store'}});
    }
  } catch (e:any) {
    const status = e?.name==='AbortError' ? 504 : 500;
    return NextResponse.json({ error:'server_error', detail:e?.message||'Unknown error' }, { status, headers:{'Cache-Control':'no-store'} });
  }
}
