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
  city?: string; // 反地理/地址抽出
};

type DaySlot = {
  morning: PlaceOut[];    // 景點 1–2
  lunch?: PlaceOut;       // 餐廳 1
  afternoon: PlaceOut[];  // 景點 1–2
  lodging?: PlaceOut;     // 住宿 1
};

const LANG = 'zh-TW';
const TYPES: PlaceType[] = ['tourist_attraction', 'restaurant', 'lodging'];
const NEAR_EQ_KM = 3; // 起訖 <= 3km 視為單點玩法

/* ======================= 通用工具 ======================= */
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

/** 沿線採樣（更密） */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum=cumulativeLengthKm(path), total=cum[cum.length-1];
  if (total===0) return [path[0]];
  const step=Math.max(12, Math.min(35, total/22));            // 更密
  const n=Math.min(48, Math.max(4, Math.round(total/step)+1)); // 最多 48 點
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
  // 去重（<6km 視為同個點）
  const dedup:LatLng[]=[];
  for (const p of out) if(!dedup.some(q=>haversineKm(p,q)<6)) dedup.push(p);
  return dedup;
}

/** 半徑更大（10–35km）避免只撈到北段 */
function dynamicRadiusMeters(totalKm:number){
  return Math.min(35000, Math.max(10000, Math.round(totalKm*35)));
}

/** 從中文地址抽出「縣/市 + 區」 */
function extractCityFromAddress(addr?: string): string|undefined {
  if (!addr) return;
  // 常見：台北市 信義區 / 新北市 新店區 / 桃園市 中壢區 / xx縣 xx鄉/鎮/市/區
  const m = addr.match(/((?:台北|臺北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉義)[市]|[^\s·,，。]{1,6}[縣])\s*([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  if (m) return `${m[1]} ${m[2]}`;
  const m2 = addr.match(/([^\s·,，。]{1,6}[市縣])\s*([^\s·,，。]{1,6}(?:區|鄉|鎮|市))/);
  if (m2) return `${m2[1]} ${m2[2]}`;
}

/** 把 city 前置到 address（若未前置） */
function ensureCityPrefixed(p: PlaceOut) {
  const city = p.city || extractCityFromAddress(p.address);
  if (!city) return;
  p.city = city;
  if (!p.address) { p.address = city; return; }
  if (!p.address.startsWith(city)) p.address = `${city} · ${p.address}`;
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

async function reverseCity(lat:number,lng:number): Promise<string|undefined> {
  try{
    const key=process.env.GOOGLE_MAPS_API_KEY!;
    const url=`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
    const j=await fetchJson<any>(url);
  const ac: any[] = j.results?.[0]?.address_components || [];
  const find = (t:string)=>ac.find(c=>c.types?.includes(t))?.long_name;
    const lvl2=find('administrative_area_level_2') || find('locality');
    const sub =find('sublocality_level_1') || find('political');
    const parts=[lvl2, sub].filter(Boolean);
  return parts.length ? parts.join(' ') : (lvl2 || undefined);
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

function progressIndex(path:LatLng[], pt:LatLng): number {
  let best=Infinity, bi=0;
  for (let i=0;i<path.length;i++){
    const d=haversineKm(pt, path[i]);
    if (d<best){ best=d; bi=i; }
  }
  return bi;
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
          __prog: progressIndex(path, loc),
        };
        const cur=byId.get(id);
        if (!cur || sc>cur.score) byId.set(id,{item,score:sc});
      }
      await sleep(60); // 降 QPS
    }
  }

  return Array.from(byId.values())
    .map(x=>x.item)
    .sort((a,b)=> a.__prog - b.__prog || (b.rating??0)-(a.rating??0));
}

/* ============ 旅行社式分配（平均切片＋補洞，確保天天有點） ============ */
function buildAgencyStyleItinerary(sorted: Array<PlaceOut & {__prog:number}>, days:number): DaySlot[] {
  const itinerary:DaySlot[] = Array.from({length:days}, ()=>({ morning:[], afternoon:[] }));
  if (sorted.length===0) return itinerary;

  const attractions = sorted.filter(p=>p._type==='tourist_attraction');
  const restaurants = sorted.filter(p=>p._type==='restaurant');
  const lodgings   = sorted.filter(p=>p._type==='lodging');

  // 1) 依進度排序後平均切片
  const perDay = Math.max(2, Math.ceil(attractions.length / days));
  let idx = 0;
  for (let d=0; d<days; d++){
    const seg = attractions.slice(idx, idx + perDay);
    idx += perDay;
    const morning = seg.slice(0, Math.min(2, seg.length));
    const afternoon = seg.slice(morning.length, Math.min(morning.length+2, seg.length));
    itinerary[d].morning   = morning;
    itinerary[d].afternoon = afternoon;
  }

  // 2) 後段補洞：把未使用的景點依進度往後補到「至少 2 個」
  const used = new Set(itinerary.flatMap(s=>[...s.morning,...s.afternoon]).map(p=>p.place_id));
  const rest = attractions.filter(p=>!used.has(p.place_id||'__NA__'));
  for (let d=0; d<days && rest.length>0; d++){
    const s = itinerary[d];
    while (s.morning.length + s.afternoon.length < 2 && rest.length>0) {
      s.afternoon.push(rest.shift()!);
    }
  }

  // 3) 午餐：靠近當日幾何中心的高分餐廳
  for (let d=0; d<days; d++){
    const pts=[...itinerary[d].morning, ...itinerary[d].afternoon];
    if (!pts.length || !restaurants.length) continue;
    const cx=pts.reduce((s,p)=>s+p.lat,0)/pts.length;
    const cy=pts.reduce((s,p)=>s+p.lng,0)/pts.length;
    let best:PlaceOut|undefined, bs=-1;
    for (const r of restaurants){
      const sc = (r.rating||0) / (1 + haversineKm({lat:cx,lng:cy}, {lat:r.lat,lng:r.lng})/5);
      if (sc>bs){ bs=sc; best=r; }
    }
    if (best) itinerary[d].lunch = best;
  }

  // 4) 住宿：靠近下午最後一景點的高分住宿
  for (let d=0; d<days; d++){
    const anchor = itinerary[d].afternoon[itinerary[d].afternoon.length-1]
                || itinerary[d].morning[itinerary[d].morning.length-1];
    if (!anchor || !lodgings.length) continue;
    let best:PlaceOut|undefined, bs=-1;
    for (const h of lodgings){
      const sc = (h.rating||0) / (1 + haversineKm({lat:anchor.lat,lng:anchor.lng}, {lat:h.lat,lng:h.lng})/5);
      if (sc>bs){ bs=sc; best=h; }
    }
    if (best) itinerary[d].lodging = best;
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

/* ======================= Route Handler ======================= */
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

      // 2) 取得候選點
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

      // 3) 限量保留 + 旅行社分配
      const poisCapped = candidates.slice(0, 120);
      const safeDays = Math.max(1, Math.min(14, Number.isFinite(days) ? days : 5));
      const itinerary = buildAgencyStyleItinerary(poisCapped, safeDays);

      // 4) 僅對「入選點」嘗試反地理；全部點做 city/address 正常化（保證顯示縣市）
      const chosenIds = new Set<string>();
      itinerary.forEach(d=>{
        [...d.morning, d.lunch, ...d.afternoon, d.lodging].forEach((p:any)=>{ if(p?.place_id) chosenIds.add(p.place_id); });
      });

      for (const p of poisCapped) {
        if (p.place_id && chosenIds.has(p.place_id)) {
        try {
          p.city = (await reverseCity(p.lat, p.lng)) || extractCityFromAddress(p.address);
        } catch {
            p.city = extractCityFromAddress(p.address);
          }
        } else {
          p.city = extractCityFromAddress(p.address);
        }
          ensureCityPrefixed(p);
        await sleep(10);
          }

      // 對 itinerary 內實體再保險一次（已引用同一物件，但防止日後改寫）
      const normalize = (q?: PlaceOut)=>{ if(q) ensureCityPrefixed(q); };
      for (const d of itinerary) {
        d.morning.forEach(ensureCityPrefixed);
        normalize(d.lunch);
        d.afternoon.forEach(ensureCityPrefixed);
        normalize(d.lodging);
      }

      // 5) 回傳
      return NextResponse.json({
          provider: 'google',
        polyline: r.polyline.map(({lat,lng})=>[lat,lng]) as [number,number][],
        start: { lat:r.start.lat, lng:r.start.lng, address:r.start.address },
        end:   { lat:r.end.lat,   lng:r.end.lng,   address:r.end.address },
          distanceText: r.distanceText,
          durationText: r.durationText,
        pois: poisCapped.map(({__prog, ...rest})=>rest), // for markers/list
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
