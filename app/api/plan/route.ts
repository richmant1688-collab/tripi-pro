// app/api/plan/route.ts
import { NextRequest, NextResponse } from 'next/server';
import polyline from 'polyline';

/** ---------------- Types ---------------- */
type LatLng = { lat: number; lng: number };

type PlaceType =
  | 'tourist_attraction'
  | 'park'
  | 'museum'
  | 'amusement_park'
  | 'zoo'
  | 'aquarium'
  | 'place_of_worship'
  | 'restaurant'
  | 'lodging';

type PlaceOut = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  user_ratings_total?: number;
  place_id?: string;
  _type: PlaceType;
  city?: string;      // ex. ?啣?撣?/ 獢?撣?/ ?啣?撣?..
  district?: string;  // ex. 靽∠儔? / 憭批??...
  progress?: number;  // ?冽擃楝蝺????脤脣漲??0..1)
};

type DaySlot = {
  morning: PlaceOut[];
  lunch?: PlaceOut;
  afternoon: PlaceOut[];
  lodging?: PlaceOut;
};

type DirectionsInfo = {
  polyPts: LatLng[];
  start: { lat: number; lng: number; address: string };
  end: { lat: number; lng: number; address: string };
  distanceText: string;
  durationText: string;
};

const LANG = 'zh-TW';
const COUNTRY_REGION = 'tw';
const NEAR_EQ_KM = 3;
const SAMPLE_MIN = 6;
const SAMPLE_MAX = 14;
const SAMPLE_SEGMENT_KM = 45;
const SAMPLE_DEDUP_KM = 5;
const NEARBY_CONCURRENCY = 6;
const REVERSE_GEOCODE_CONCURRENCY = 4;
const NEARBY_RETRY_LIMIT = 3;
const NEARBY_TIMEOUT_MS = 6000;
const ATTRACTION_KEYWORD_LIMIT = 1;
const MAX_RESPONSE_POIS = 40;
const MAX_RESPONSE_POLYLINE_POINTS = 120;
const LONG_HAUL_KM = 1200;
const LONG_HAUL_LOCAL_LAT_SPAN = 0.03;
const LONG_HAUL_LOCAL_LNG_SPAN = 0.02;
const MIN_ATTRACTION_RATING = 3.8;
const MIN_ATTRACTION_REVIEWS = 40;
const MIN_FOOD_RATING = 3.8;
const MIN_FOOD_REVIEWS = 30;
const MIN_HOTEL_RATING = 3.5;
const MIN_HOTEL_REVIEWS = 20;
const MIN_PARK_REVIEWS = 120;
const MIN_MUSEUM_REVIEWS = 80;
const MIN_ZOO_REVIEWS = 200;
const MAX_POI_DIST_FROM_SAMPLE_KM = 15;
const NEAR_DUP_KM = 0.35;
const HARD_NEAR_DUP_KM = 0.18;
const FOOD_NAME_BLOCKLIST = /(hotel|hostel|apartment|apartments|resort|inn|motel|wohnung|\u9152\u5e97|\u98ef\u5e97|\u65c5\u9928|\u65c5\u5e97|\u6c11\u5bbf)/i;
const HOTEL_BRAND_IN_FOOD_BLOCKLIST = /(radisson|marriott|hilton|hyatt|intercontinental|holiday\s*inn|guesthouse|trend\s*hotel|trendhotel|wombat)/i;
const ATTRACTION_NAME_BLOCKLIST = /(sandbox\s*vr|hundezone|dog\s*park|fitness|gym|gedenktafel|memorial\s*plaque|flagship|camping|hardware|outlet|supermarket|hornbach|zoo\s*scharf|michael\s*scharf)/i;
const PARK_NAME_BLOCKLIST = /(hundezone|dog\s*park|skate|parkplatz|parking)/i;
const ZOO_NAME_BLOCKLIST = /(pet\s*shop|tierhandlung|aquaristik|zoo\s*shop|handlung|store|zoo\s*scharf|\/)/i;
const ATTRACTION_TYPE_WHITELIST = new Set([
  'tourist_attraction',
  'museum',
  'park',
  'zoo',
  'aquarium',
  'place_of_worship',
  'art_gallery',
  'church',
  'hindu_temple',
  'mosque',
  'synagogue',
]);
const FOOD_TYPE_WHITELIST = new Set([
  'restaurant',
  'cafe',
  'meal_takeaway',
  'meal_delivery',
  'bakery',
  'food',
]);
const ATTRACTION_BAD_PRIMARY_TYPES = new Set([
  'lodging',
  'restaurant',
  'cafe',
  'bar',
  'night_club',
  'shopping_mall',
  'supermarket',
  'store',
]);
/** ?游??暺????方??笑撱郊???拚尹???璅?蝑? */
const ATTRACTION_TYPES: PlaceType[] = [
  'tourist_attraction',
  'park',
  'museum',
  'zoo',
  'aquarium',
  'place_of_worship',
];

/** 擗輒??摰蹂???銵??潸??閬?*/
const FOOD_TYPES: PlaceType[] = ['restaurant'];
const HOTEL_TYPES: PlaceType[] = ['lodging'];

/** ???方?/甇仿?/?擗??勗??Ｙ揣閬??葉???萄?嚗earby ?臬? keyword嚗?*/
const ATTRACTION_CN_KEYWORDS = [
  'attraction',
  'museum',
  'historic',
  'landmark',
  'temple',
  'scenic',
];
const FOOD_KEYWORDS = [
  'local food',
  'traditional',
  'bistro',
  'viennese',
];

/** ---------------- Utils ---------------- */
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  if (!tasks.length) return [];
  const safeLimit = Math.max(1, Math.min(limit, tasks.length));
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) break;
      out[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function haversineKm(a: LatLng, b: LatLng) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2));
}

function cumulativeLengthKm(path: LatLng[]) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) acc.push(acc[i - 1] + haversineKm(path[i - 1], path[i]));
  return acc;
}

/** 靘楝蝺??璅??嚗蝔憭璅?蝔??喳???8-24 ??嚗????渲??? */
function sampleAlongPathDynamic(path: LatLng[]) {
  if (!path.length) return [];
  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const n = Math.max(SAMPLE_MIN, Math.min(SAMPLE_MAX, Math.ceil(total / SAMPLE_SEGMENT_KM) + SAMPLE_MIN));
  const positions: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    const target = (i / Math.max(1, n - 1)) * total;
    let j = 0;
    while (j < cum.length && cum[j] < target) j++;
    if (j === 0) positions.push(path[0]);
    else if (j >= cum.length) positions.push(path[path.length - 1]);
    else {
      const t0 = cum[j - 1], t1 = cum[j];
      const A = path[j - 1], B = path[j];
      const r = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      positions.push({ lat: A.lat + (B.lat - A.lat) * r, lng: A.lng + (B.lng - A.lng) * r });
    }
  }
  const dedup: LatLng[] = [];
  for (const p of positions) {
    if (!dedup.some(q => haversineKm(p, q) < SAMPLE_DEDUP_KM)) dedup.push(p);
  }
  return dedup;
}
function dynamicRadiusMeters(totalKm: number) {
  const base = Math.min(15000, Math.max(4000, Math.round(totalKm * 20)));
  return base;
}

/** 敺?Geocoding components ? city/district嚗?撠??蝛拙?嚗?*/
function extractCityDistrict(components: any[]): { city?: string; district?: string } {
  const hasType = (c: any, t: string) => Array.isArray(c.types) && c.types.includes(t);
  const get = (t: string) => components.find((c: any) => hasType(c, t))?.long_name as string | undefined;

  // ?啁撣貉?嚗腦撣 level_1嚗??/?啣?撣?獢?撣??唬葉撣??啣?撣?擃?撣??佗?
  // 甈⊿ locality嚗??撜??撣?質??
  let city = get('administrative_area_level_1') || get('locality') || get('postal_town') || get('administrative_area_level_2');

  // ?/?殷?level_3 ??sublocality_level_1嚗????neighborhood/locality
  let district =
    get('administrative_area_level_3') ||
    get('sublocality_level_1') ||
    get('neighborhood') ||
    (get('locality') && get('locality') !== city ? get('locality') : undefined);

  const norm = (s?: string) => s?.replace(/\s+/g, '')?.replace(/[繚?領Ｔ改?\.]/g, '') || undefined;
  city = norm(city);
  district = norm(district);

  // ?餅????????銴?憒??靽∠儔??? district 隞乓縑蝢拙??銝鳴?
  if (city && district && district.startsWith(city)) {
    district = district.slice(city.length);
    district = norm(district);
  }

  return { city, district };
}

/** 銋暹楊?唳??腦撣?/ 銵???蝵桀?啣?嚗??銴＊蝷?*/
function formatAddressWithCity(address?: string, city?: string, district?: string) {
  const SEP = ' · ';
  const parts: string[] = [];
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  if (city) parts.push(city);
  if (district) parts.push(district);

  let rest = address ? clean(address) : '';
  const head = parts.join(SEP);

  if (rest) {
      const rmRaw = [city, district].filter(Boolean).join('|');
      if (rmRaw) {
        const rm = rmRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rest = rest.replace(new RegExp(`^(${rm})(\\s*(?:·|繚)\\s*)?`, 'u'), '');
      }
  }

  return head ? (rest ? `${head}${SEP}${rest}` : head) : (rest || '');
}

/** ---------------- Google APIs ---------------- */
async function geocodeGoogle(query: string) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const base = 'https://maps.googleapis.com/maps/api/geocode/json';
  const tryUrls = [
    `${base}?address=${encodeURIComponent(query)}&language=${LANG}&region=${COUNTRY_REGION}&key=${key}`,
    `${base}?address=${encodeURIComponent(query)}&language=${LANG}&key=${key}`,
  ];
  for (const url of tryUrls) {
    const j = await fetchJson<any>(url);
    if (j.results?.[0]) {
      const g = j.results[0];
      return {
        lat: g.geometry.location.lat,
        lng: g.geometry.location.lng,
        formatted_address: g.formatted_address,
        components: g.address_components || [],
      };
    }
  }
  throw new Error('geocode_failed');
}

async function reverseGeocodeGoogle(lat: number, lng: number) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=${LANG}&key=${key}`;
  const j = await fetchJson<any>(url);
  const top = j.results?.[0];
  const components = top?.address_components || [];
  const { city, district } = extractCityDistrict(components);

  const formatted = formatAddressWithCity(top?.formatted_address, city, district);
  return { city, district, formatted };
}

async function directionsGoogle(origin: string, destination: string): Promise<DirectionsInfo> {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&language=${LANG}&region=${COUNTRY_REGION}&mode=driving&key=${key}`;
  const j = await fetchJson<any>(url);
  if (j.status !== 'OK' || !j.routes?.[0]) {
    const err = new Error(j.error_message || j.status || 'directions_failed') as Error & { code?: string };
    err.code = j.status;
    throw err;
  }
  const route = j.routes[0];
  const leg = route.legs[0];
  const pts = polyline.decode(route.overview_polyline.points).map(([lat, lng]: [number, number]) => ({ lat, lng }));
  return {
    polyPts: pts,
    start: { lat: leg.start_location.lat, lng: leg.start_location.lng, address: leg.start_address },
    end:   { lat: leg.end_location.lat,   lng: leg.end_location.lng,   address: leg.end_address },
    distanceText: leg.distance.text,
    durationText: leg.duration.text,
  };
}

function scorePlace(p: any, distKm?: number) {
  const rating = p.rating || 0;
  const urt = p.user_ratings_total || 1;
  const pop = Math.log10(urt + 1) + 1;
  const proximity = typeof distKm === 'number' ? 1 / (1 + distKm / 6) : 1;
  return rating * pop * proximity;
}

function hasAnyGoogleType(p: any, allow: Set<string>) {
  if (!Array.isArray(p?.types)) return false;
  return p.types.some((t: string) => allow.has(t));
}

function isQualifiedPlace(p: any, type: PlaceType, distKm: number) {
  if (!p || !p.geometry?.location) return false;
  if (p.business_status && p.business_status !== 'OPERATIONAL') return false;
  if (distKm > MAX_POI_DIST_FROM_SAMPLE_KM) return false;

  const name = String(p.name || '');
  const types: string[] = Array.isArray(p.types) ? p.types : [];
  const primaryType = types[0];
  if (ATTRACTION_TYPES.includes(type) && ATTRACTION_NAME_BLOCKLIST.test(name)) return false;
  if (/(gmbh|flagship|camping|hornbach|monteurzimmer)/i.test(name)) return false;
  if (FOOD_TYPES.includes(type) && FOOD_NAME_BLOCKLIST.test(name)) return false;
  if (FOOD_TYPES.includes(type) && HOTEL_BRAND_IN_FOOD_BLOCKLIST.test(name)) return false;
  if (type === 'place_of_worship' && !/(church|cathedral|temple|mosque|shrine|basilica|synagogue|kirche|dom)/i.test(name)) return false;

  const rating = Number(p.rating || 0);
  const reviews = Number(p.user_ratings_total || 0);

  if (ATTRACTION_TYPES.includes(type)) {
    if (!hasAnyGoogleType(p, ATTRACTION_TYPE_WHITELIST)) return false;
    if (primaryType && ATTRACTION_BAD_PRIMARY_TYPES.has(primaryType)) return false;
    if (type === 'park' && PARK_NAME_BLOCKLIST.test(name)) return false;
    if (type === 'park' && reviews < MIN_PARK_REVIEWS) return false;
    if (type === 'museum' && reviews < MIN_MUSEUM_REVIEWS) return false;
    if (type === 'zoo' && ZOO_NAME_BLOCKLIST.test(name)) return false;
    if (type === 'zoo' && reviews < MIN_ZOO_REVIEWS) return false;
    return rating >= MIN_ATTRACTION_RATING && reviews >= MIN_ATTRACTION_REVIEWS;
  }
  if (FOOD_TYPES.includes(type)) {
    if (!hasAnyGoogleType(p, FOOD_TYPE_WHITELIST)) return false;
    if (types.includes('lodging')) return false;
    return rating >= MIN_FOOD_RATING && reviews >= MIN_FOOD_REVIEWS;
  }
  if (HOTEL_TYPES.includes(type)) {
    if (!types.includes('lodging')) return false;
    return rating >= MIN_HOTEL_RATING && reviews >= MIN_HOTEL_REVIEWS;
  }
  return true;
}

async function nearbyRaw(center: LatLng, radiusM: number, params: Record<string, string>) {
  const key = process.env.GOOGLE_MAPS_API_KEY!;
  const usp = new URLSearchParams({
    location: `${center.lat},${center.lng}`,
    radius: `${radiusM}`,
    language: LANG,
    key,
  });
  for (const [k, v] of Object.entries(params)) usp.set(k, v);
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${usp.toString()}`;

  for (let attempt = 0; attempt < NEARBY_RETRY_LIMIT; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), NEARBY_TIMEOUT_MS);
      const j = await fetchJson<any>(url, { signal: ac.signal });
      clearTimeout(timer);

      if (j.status === 'OK' || j.status === 'ZERO_RESULTS') {
        return Array.isArray(j.results) ? j.results : [];
      }

      const retryable = j.status === 'OVER_QUERY_LIMIT' || j.status === 'UNKNOWN_ERROR';
      if (retryable && attempt < NEARBY_RETRY_LIMIT - 1) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return [];
    } catch {
      if (attempt < NEARBY_RETRY_LIMIT - 1) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return [];
    }
  }
  return [];
}
async function nearby(center: LatLng, type?: PlaceType, radiusM?: number, keyword?: string) {
  const params: Record<string, string> = {};
  if (type) params['type'] = type;
  if (keyword) params['keyword'] = keyword;
  return nearbyRaw(center, radiusM || 3000, params);
}

/** ??result 頧? PlaceOut */
function asPlaceOut(result: any, type: PlaceType, progress?: number): PlaceOut | undefined {
  if (!result || !result.geometry?.location) return;
  const loc = result.geometry.location;
  const o: PlaceOut = {
    name: result.name,
    lat: loc.lat,
    lng: loc.lng,
    address: result.vicinity || result.formatted_address,
    rating: result.rating,
    user_ratings_total: result.user_ratings_total,
    place_id: result.place_id,
    _type: type,
    progress,
  };
  return o;
}

/** ???頝舐??脣漲????憭見?? POI ??嚗 attractions/food/hotel嚗?*/
async function harvestPOIsAlongPath(path: LatLng[]) {
  const samples = sampleAlongPathDynamic(path);
  const totalKm = haversineKm(path[0], path[path.length - 1]);
  const radius = dynamicRadiusMeters(totalKm);

  const cum = cumulativeLengthKm(path);
  const total = cum[cum.length - 1];
  const stride = Math.max(1, Math.floor(path.length / 220));
  const lookupIdx: number[] = [];
  for (let i = 0; i < path.length; i += stride) lookupIdx.push(i);
  if (lookupIdx[lookupIdx.length - 1] !== path.length - 1) lookupIdx.push(path.length - 1);

  const progressOf = (pt: LatLng) => {
    let best = Infinity;
    let bestIdx = 0;
    for (const idx of lookupIdx) {
      const d = haversineKm(pt, path[idx]);
      if (d < best) {
        best = d;
        bestIdx = idx;
      }
    }
    const prog = cum[bestIdx] / (total || 1);
    return Math.max(0, Math.min(1, prog));
  };

  const byId = new Map<string, { item: PlaceOut; score: number }>();

  const ingest = (arr: any[], type: PlaceType, sample: LatLng, boost = 1) => {
    for (const p of arr) {
      const id = p.place_id as string | undefined;
      if (!id || !p.geometry?.location) continue;
      const point = { lat: p.geometry.location.lat, lng: p.geometry.location.lng };
      const distKm = haversineKm(sample, point);
      if (!isQualifiedPlace(p, type, distKm)) continue;
      const sc = scorePlace(p, distKm) * boost;
      const item = asPlaceOut(p, type, progressOf(point));
      if (!item) continue;
      const cur = byId.get(id);
      if (!cur || sc > cur.score) byId.set(id, { item, score: sc });
    }
  };

  const tasks: Array<() => Promise<void>> = [];

  for (let si = 0; si < samples.length; si++) {
    const s = samples[si];
    for (const t of ATTRACTION_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, radius);
        ingest(arr, t, s);
      });

      if (si % 2 === 0) {
        for (const kw of ATTRACTION_CN_KEYWORDS.slice(0, ATTRACTION_KEYWORD_LIMIT)) {
          tasks.push(async () => {
            const arr2 = await nearby(s, t, Math.round(radius * 0.8), kw);
            ingest(arr2, t, s, 1.05);
          });
        }
      }
    }
  }

  for (const s of samples) {
    for (const t of FOOD_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, Math.max(3500, Math.round(radius * 0.6)));
        ingest(arr, t, s);
      });
      for (const kw of FOOD_KEYWORDS) {
        tasks.push(async () => {
          const arr2 = await nearby(s, t, Math.max(3000, Math.round(radius * 0.5)), kw);
          ingest(arr2, t, s, 1.03);
        });
      }
    }
  }

  for (const s of samples) {
    for (const t of HOTEL_TYPES) {
      tasks.push(async () => {
        const arr = await nearby(s, t, Math.max(5000, Math.round(radius * 0.6)));
        ingest(arr, t, s);
      });
    }
  }

  await runWithConcurrency(tasks, NEARBY_CONCURRENCY);

  const pois = Array.from(byId.values())
    .sort((a, b) => {
      const pa = a.item.progress ?? 0;
      const pb = b.item.progress ?? 0;
      return pa - pb || b.score - a.score;
    })
    .map(x => x.item);

  const seen = new Set<string>();
  const clean: PlaceOut[] = [];
  for (const p of pois) {
    const k = `${(p.name || '').trim()}@${(p.address || '').slice(0, 24)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push(p);
  }
  return clean;
}
function buildAgencyStyleItinerary(pois: PlaceOut[], days: number): DaySlot[] {
  const itinerary: DaySlot[] = Array.from({ length: days }, () => ({ morning: [], afternoon: [] }));
  const idOf = (p: PlaceOut) => p.place_id || `${p.name}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const normName = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const attractionGroupKey = (p: PlaceOut) => {
    const n = normName(p.name)
      .replace(/博物館|美術館|花園|公園|教堂|廣場|城堡|景點|雕像/g, '')
      .replace(/museum|gallery|park|garden|cathedral|church|palace|schloss|platz|vienna|wien/g, '');
    return n.slice(0, 12) || normName(p.name).slice(0, 12);
  };
  const similarAttraction = (a: PlaceOut, b: PlaceOut) => {
    const na = normName(a.name), nb = normName(b.name);
    const nameClose = !!na && !!nb && (na.includes(nb) || nb.includes(na));
    const km = haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    if (km <= HARD_NEAR_DUP_KM) return true;
    if (km <= 0.8 && attractionGroupKey(a) === attractionGroupKey(b)) return true;
    return km <= NEAR_DUP_KM && nameClose;
  };

  const attractions = pois
    .filter(p => ATTRACTION_TYPES.includes(p._type as any))
    .sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));
  const restaurantKey = (p: PlaceOut) => {
    const core = normName(p.name)
      .replace(/restaurant|cafe|bar|brau|br\u00E4u|wien|vienna|\u9910\u5ef3|\u5496\u5561/g, '')
      .slice(0, 16) || normName(p.name).slice(0, 16);
    return `${core}@${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
  };
  const restaurantsRaw = pois
    .filter(p => FOOD_TYPES.includes(p._type as any))
    .filter(p => !FOOD_NAME_BLOCKLIST.test(p.name || ''));
  const restaurants = (() => {
    const sorted = [...restaurantsRaw].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const m = new Map<string, PlaceOut>();
    for (const r of sorted) {
      const k = restaurantKey(r);
      if (!m.has(k)) m.set(k, r);
    }
    return Array.from(m.values());
  })();
  const hotels = pois.filter(p => HOTEL_TYPES.includes(p._type as any));
  const allowCrossDayRepeat = attractions.length < days * 2;

  const usedAttractions = new Set<string>();
  const usedAttractionSpots: PlaceOut[] = [];
  const usedRestaurants = new Set<string>();
  const usedRestaurantKeys = new Set<string>();
  const usedHotels = new Set<string>();

  const pickAttractions = (candidates: PlaceOut[], need: number, dayPicked: Set<string>, dayItems: PlaceOut[]) => {
    const out: PlaceOut[] = [];

    for (const p of candidates) {
      if (out.length >= need) break;
      const id = idOf(p);
      if (dayPicked.has(id) || usedAttractions.has(id)) continue;
      if (!allowCrossDayRepeat && usedAttractionSpots.some(x => similarAttraction(x, p))) continue;
      if ([...dayItems, ...out].some(x => similarAttraction(x, p))) continue;
      out.push(p);
      dayPicked.add(id);
      usedAttractions.add(id);
      usedAttractionSpots.push(p);
    }

    for (const p of candidates) {
      if (out.length >= need) break;
      const id = idOf(p);
      if (dayPicked.has(id)) continue;
      if (!allowCrossDayRepeat && usedAttractions.has(id)) continue;
      if (!allowCrossDayRepeat && usedAttractionSpots.some(x => similarAttraction(x, p))) continue;
      if ([...dayItems, ...out].some(x => similarAttraction(x, p))) continue;
      out.push(p);
      dayPicked.add(id);
      usedAttractionSpots.push(p);
    }
    return out;
  };

  for (let d = 0; d < days; d++) {
    const start = d / days;
    const end = (d + 1) / days;
    const bucket = attractions.filter(p => {
      const pr = p.progress ?? 0;
      return pr >= start - 0.08 && pr <= end + 0.08;
    });
    const pool = bucket.length ? bucket : attractions;

    const dayPicked = new Set<string>();
    itinerary[d].morning = pickAttractions(pool, 2, dayPicked, []);
    if (itinerary[d].morning.length < 2) {
      itinerary[d].morning = itinerary[d].morning.concat(
        pickAttractions(attractions, 2 - itinerary[d].morning.length, dayPicked, itinerary[d].morning)
      );
    }

    itinerary[d].afternoon = pickAttractions(pool, 2, dayPicked, itinerary[d].morning);
    if (itinerary[d].afternoon.length < 2) {
      const dayItems = [...itinerary[d].morning, ...itinerary[d].afternoon];
      itinerary[d].afternoon = itinerary[d].afternoon.concat(
        pickAttractions(attractions, 2 - itinerary[d].afternoon.length, dayPicked, dayItems)
      );
    }

    const pts = [...itinerary[d].morning, ...itinerary[d].afternoon];
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
      let bestR: PlaceOut | undefined;
      let bestScore = -1;

      for (const r of restaurants) {
        const id = idOf(r);
        const key = restaurantKey(r);
        if (usedRestaurants.has(id)) continue;
        if (usedRestaurantKeys.has(key)) continue;
        const distKm = haversineKm({ lat: cx, lng: cy }, { lat: r.lat, lng: r.lng });
        if (distKm > 6) continue;
        const sc = (r.rating || 0) / (1 + distKm / 6);
        if (sc > bestScore) {
          bestScore = sc;
          bestR = r;
        }
      }
      if (!bestR) {
        for (const r of restaurants) {
          const id = idOf(r);
          const key = restaurantKey(r);
          if (usedRestaurants.has(id)) continue;
          if (usedRestaurantKeys.has(key)) continue;
          const sc = (r.rating || 0) / (1 + haversineKm({ lat: cx, lng: cy }, { lat: r.lat, lng: r.lng }) / 6);
          if (sc > bestScore) {
            bestScore = sc;
            bestR = r;
          }
        }
      }
      if (bestR) {
        itinerary[d].lunch = bestR;
        usedRestaurants.add(idOf(bestR));
        usedRestaurantKeys.add(restaurantKey(bestR));
      }
    }

    const anchor = itinerary[d].afternoon[itinerary[d].afternoon.length - 1] || itinerary[d].morning[itinerary[d].morning.length - 1];
    if (anchor) {
      let bestH: PlaceOut | undefined;
      let bestScore = -1;
      for (const h of hotels) {
        const id = idOf(h);
        if (usedHotels.has(id)) continue;
        const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 6);
        if (sc > bestScore) {
          bestScore = sc;
          bestH = h;
        }
      }
      if (!bestH) {
        for (const h of hotels) {
          const id = idOf(h);
          if (usedHotels.has(id)) continue;
          const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 6);
          if (sc > bestScore) {
            bestScore = sc;
            bestH = h;
          }
        }
      }
      if (!bestH) {
        for (const h of hotels) {
          const sc = (h.rating || 0) / (1 + haversineKm({ lat: anchor.lat, lng: anchor.lng }, { lat: h.lat, lng: h.lng }) / 6);
          if (sc > bestScore) {
            bestScore = sc;
            bestH = h;
          }
        }
      }
      if (bestH) {
        itinerary[d].lodging = bestH;
        usedHotels.add(idOf(bestH));
      }
    }
  }

  return itinerary;
}

async function enrichChosenPOIsWithCity(itinerary: DaySlot[], all: PlaceOut[]) {

  const chosenIds = new Set<string>();
  itinerary.forEach(day => {
    [...day.morning, day.lunch, ...day.afternoon, day.lodging].forEach((p: any) => {
      if (p?.place_id) chosenIds.add(p.place_id);
    });
  });

  const idToPoi = new Map<string, PlaceOut>();
  for (const p of all) if (p.place_id) idToPoi.set(p.place_id, p);

  const geoCache = new Map<string, Promise<{ city?: string; district?: string; formatted: string }>>();
  const reverseCached = (lat: number, lng: number) => {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = geoCache.get(key);
    if (hit) return hit;
    const req = reverseGeocodeGoogle(lat, lng);
    geoCache.set(key, req);
    return req;
  };

  const tasks = Array.from(chosenIds).map(id => async () => {
    const p = idToPoi.get(id);
    if (!p) return;
    try {
      const rev = await reverseCached(p.lat, p.lng);
      p.city = rev.city;
      p.district = rev.district;
      p.address = formatAddressWithCity(p.address, rev.city, rev.district);
    } catch {
      if (p.address) p.address = p.address.trim();
    }
  });

  await runWithConcurrency(tasks, REVERSE_GEOCODE_CONCURRENCY);
}
function toPolylineArray(path: LatLng[], maxPoints = MAX_RESPONSE_POLYLINE_POINTS): [number, number][] {
  if (!path.length) return [];
  if (path.length <= maxPoints) return path.map(({ lat, lng }) => [lat, lng] as [number, number]);

  const out: [number, number][] = [];
  const step = (path.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(path.length - 1, Math.round(i * step));
    const p = path[idx];
    out.push([p.lat, p.lng]);
  }
  return out;
}

function compactPlaceForResponse(p: PlaceOut): PlaceOut {
  return {
    name: p.name,
    lat: Number(p.lat.toFixed(6)),
    lng: Number(p.lng.toFixed(6)),
    address: p.address?.slice(0, 80),
    rating: p.rating,
    user_ratings_total: p.user_ratings_total,
    place_id: p.place_id,
    _type: p._type,
    city: p.city,
    district: p.district,
    progress: typeof p.progress === 'number' ? Number(p.progress.toFixed(4)) : undefined,
  };
}

function compactDaySlot(day: DaySlot): DaySlot {
  return {
    morning: day.morning.map(compactPlaceForResponse),
    lunch: day.lunch ? compactPlaceForResponse(day.lunch) : undefined,
    afternoon: day.afternoon.map(compactPlaceForResponse),
    lodging: day.lodging ? compactPlaceForResponse(day.lodging) : undefined,
  };
}

function slimPoisForResponse(pois: PlaceOut[], itinerary: DaySlot[], limit = MAX_RESPONSE_POIS): PlaceOut[] {
  const keyOf = (p: PlaceOut) => p.place_id || `${p.name}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const picked = new Map<string, PlaceOut>();

  for (const day of itinerary) {
    for (const p of [...day.morning, day.lunch, ...day.afternoon, day.lodging]) {
      if (!p) continue;
      const k = keyOf(p);
      if (!picked.has(k)) picked.set(k, p);
    }
  }

  const out: PlaceOut[] = [];
  for (const p of picked.values()) {
    out.push(compactPlaceForResponse(p));
    if (out.length >= limit) return out;
  }

  for (const p of pois) {
    const k = keyOf(p);
    if (picked.has(k)) continue;
    out.push(compactPlaceForResponse(p));
    if (out.length >= limit) break;
  }
  return out;
}

function buildDestinationLocalPath(center: LatLng): LatLng[] {
  const ring = [
    { lat: center.lat + LONG_HAUL_LOCAL_LAT_SPAN, lng: center.lng },
    { lat: center.lat + LONG_HAUL_LOCAL_LAT_SPAN * 0.7, lng: center.lng + LONG_HAUL_LOCAL_LNG_SPAN },
    { lat: center.lat, lng: center.lng + LONG_HAUL_LOCAL_LNG_SPAN * 1.2 },
    { lat: center.lat - LONG_HAUL_LOCAL_LAT_SPAN * 0.8, lng: center.lng + LONG_HAUL_LOCAL_LNG_SPAN * 0.7 },
    { lat: center.lat - LONG_HAUL_LOCAL_LAT_SPAN, lng: center.lng - LONG_HAUL_LOCAL_LNG_SPAN * 0.2 },
    { lat: center.lat - LONG_HAUL_LOCAL_LAT_SPAN * 0.4, lng: center.lng - LONG_HAUL_LOCAL_LNG_SPAN },
  ].map(p => ({
    lat: Math.max(-85, Math.min(85, p.lat)),
    lng: p.lng,
  }));
  return [center, ...ring];
}

function formatLongHaulDurationText(distanceKm: number) {
  const hours = distanceKm / 800 + 1.5;
  const h = Math.max(1, Math.floor(hours));
  const m = Math.round((hours - h) * 60);
  return `約 ${h} 小時 ${m} 分（含轉乘與市區接駁）`;
}
/** ---------------- OSM/OSRM fallback ---------------- */
async function geocodeOSM(query: string) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1`;
  const r = await fetch(url, { headers: { 'Accept-Language': LANG }, cache: 'no-store' });
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]) throw new Error('geocode_failed');
  return {
    lat: parseFloat(j[0].lat),
    lng: parseFloat(j[0].lon),
    formatted: j[0].display_name,
    address: j[0].address || {},
  };
}

async function routeOSRM(origin: LatLng, dest: LatLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  const j = await fetchJson<any>(url);
  if (!j.routes?.[0]) throw new Error('route_failed');
  const route = j.routes[0];
  const coords = route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  return {
    polyPts: coords as LatLng[],
    distanceText: (route.distance / 1000).toFixed(1) + ' km',
    durationText: Math.round(route.duration / 60) + ' 分',
  };
}

/** ---------------- Handler ---------------- */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { origin, destination, days = 5 } = body || {};
    if (!origin || !destination) {
      return NextResponse.json(
        { error: 'bad_request', detail: 'origin/destination required' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const hasGoogle = !!process.env.GOOGLE_MAPS_API_KEY;

    if (hasGoogle) {
      let r: DirectionsInfo;
      let longHaulFallback = false;
      try {
        r = await directionsGoogle(origin, destination);
      } catch (e: any) {
        const code = e?.code || e?.message;
        if (code === 'ZERO_RESULTS' || code === 'NOT_FOUND') {
          const o = await geocodeGoogle(origin);
          const d = await geocodeGoogle(destination);
          const startLL = { lat: o.lat, lng: o.lng };
          const endLL = { lat: d.lat, lng: d.lng };
          const distanceKm = haversineKm(startLL, endLL);
          const localPath = buildDestinationLocalPath(endLL);
          r = {
            // Keep route visualization local to destination for cross-country planning.
            polyPts: localPath,
            start: { lat: startLL.lat, lng: startLL.lng, address: o.formatted_address || origin },
            end: { lat: endLL.lat, lng: endLL.lng, address: d.formatted_address || destination },
            distanceText: `${distanceKm.toFixed(0)} km`,
            durationText: formatLongHaulDurationText(distanceKm),
          };
          longHaulFallback = true;
        } else {
          throw e;
        }
      }

      const startLL = { lat: r.start.lat, lng: r.start.lng };
      const endLL = { lat: r.end.lat, lng: r.end.lng };
      const crowKm = haversineKm(startLL, endLL);
      const isSingle = crowKm <= NEAR_EQ_KM;
      const isLongHaul = longHaulFallback || crowKm >= LONG_HAUL_KM;

      let pois: PlaceOut[] = [];
      if (isSingle) {
        const fakePath = [startLL, { lat: startLL.lat - 0.5, lng: startLL.lng + 0.2 }];
        pois = await harvestPOIsAlongPath(fakePath);
      } else if (isLongHaul) {
        // For cross-country routes, plan activities around destination city.
        pois = await harvestPOIsAlongPath(buildDestinationLocalPath(endLL));
      } else {
        pois = await harvestPOIsAlongPath(r.polyPts);
      }

      const itinerary = buildAgencyStyleItinerary(pois, days);
      await enrichChosenPOIsWithCity(itinerary, pois);

      return NextResponse.json({
        provider: 'google',
        polyline: toPolylineArray(r.polyPts),
        start: { lat: r.start.lat, lng: r.start.lng, address: r.start.address },
        end: { lat: r.end.lat, lng: r.end.lng, address: r.end.address },
        distanceText: r.distanceText,
        durationText: r.durationText,
        pois: slimPoisForResponse(pois, itinerary),
        itinerary: itinerary.map(compactDaySlot),
        routeMode: longHaulFallback ? 'long_haul_fallback' : 'driving',
      }, { headers: { 'Cache-Control': 'private, max-age=60' } });
    } else {
      const o = await geocodeOSM(origin), d = await geocodeOSM(destination);
      const ro = await routeOSRM({ lat: o.lat, lng: o.lng }, { lat: d.lat, lng: d.lng });
      return NextResponse.json({
        provider: 'osrm',
        polyline: toPolylineArray(ro.polyPts),
        start: { lat: o.lat, lng: o.lng, address: o.formatted },
        end: { lat: d.lat, lng: d.lng, address: d.formatted },
        distanceText: ro.distanceText,
        durationText: ro.durationText,
        pois: [],
        itinerary: [],
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch (e: any) {
    const status = e?.name === 'AbortError' ? 504 : 500;
    return NextResponse.json(
      { error: 'server_error', detail: e?.message || 'Unknown error' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
