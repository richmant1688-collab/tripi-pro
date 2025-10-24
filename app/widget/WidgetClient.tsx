/// <reference types="@types/google.maps" />

'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { readInitParams, listen, send } from '../../lib/apps-bridge';

/* ======================= Types ======================= */

type POI = {
  name: string;
  lat: number;
  lng: number;
  address?: string;
  rating?: number;
  _type?: 'tourist_attraction' | 'restaurant' | 'lodging' | string;
  place_id?: string;
};

type DaySlot = {
  morning: POI[];
  lunch?: POI;
  afternoon: POI[];
  lodging?: POI;
};

type PlanResponse = {
  provider: 'google' | 'osrm';
  polyline: [number, number][];
  start: { lat: number; lng: number; address: string };
  end: { lat: number; lng: number; address: string };
  distanceText: string;
  durationText: string;
  pois: POI[];          // 候選點池（保留）
  itinerary: DaySlot[]; // ✅ 實際行程
};

/* ======================= UI ======================= */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-full lg:w-96 bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-gray-100 p-4 lg:p-5 space-y-3">
      <div className="text-xl font-semibold">{title}</div>
      {children}
    </div>
  );
}

/* ======================= Google Maps Loader ======================= */

function useGoogleMaps(apiKey?: string) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (typeof window === 'undefined') return;
      if ((window as any).google?.maps) {
        setReady(true);
        return;
      }
      if (!apiKey) return;

      const src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
      if (document.querySelector(`script[src^="https://maps.googleapis.com/maps/api/js"]`)) {
        const trySet = () => {
          if ((window as any).google?.maps) setReady(true);
          else setTimeout(trySet, 200);
        };
        trySet();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('gmaps_load_error'));
        document.head.appendChild(s);
      });

      if (!cancelled) {
        if ((window as any).google?.maps) setReady(true);
      }
    }

    load().catch(() => setReady(false));
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  return ready;
}

/* ======================= Helpers ======================= */

// 藍色大頭針（像預設紅色，但換成藍色）
function userBluePinIcon(): google.maps.Icon {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">' +
    '<path d="M12 2c-4.97 0-9 3.88-9 8.67 0 6.5 9 13.66 9 13.66s9-7.16 9-13.66C21 5.88 16.97 2 12 2z" fill="#2563EB" stroke="#1E3A8A" stroke-width="1.2"/>' +
    '<circle cx="12" cy="10" r="3.2" fill="#ffffff"/>' +
    '</svg>';
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 34),
  };
}

// 依類型回傳彩色圖示
function iconByType(t?: string): google.maps.Icon {
  // 顏色：景點=綠(#10B981/#065F46)，餐廳=橘(#F59E0B/#92400E)，住宿=紫(#8B5CF6/#5B21B6)，其他=紅(#EF4444/#991B1B)
  const color =
    t === 'tourist_attraction' ? { fill: '#10B981', stroke: '#065F46' } :
    t === 'restaurant'         ? { fill: '#F59E0B', stroke: '#92400E' } :
    t === 'lodging'            ? { fill: '#8B5CF6', stroke: '#5B21B6' } :
                                 { fill: '#EF4444', stroke: '#991B1B' };

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">` +
    `<path d="M12 2c-4.97 0-9 3.88-9 8.67 0 6.5 9 13.66 9 13.66s9-7.16 9-13.66C21 5.88 16.97 2 12 2z" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.2"/>` +
    `<circle cx="12" cy="10" r="3.2" fill="#ffffff"/>` +
    `</svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36, 36),
    anchor: new google.maps.Point(18, 34),
  };
}

// 嘗試解析 "lat,lng"
function parseLatLng(text: string): google.maps.LatLngLiteral | null {
  const m = text.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// 直線距離（哈弗辛公式）+ 顯示格式
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng));
  return R * c;
}
function fmtDistance(km: number) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// 小徽章：型別 → 標籤 & 樣式
function typeLabel(t?: string) {
  if (t === 'restaurant') return '餐廳';
  if (t === 'lodging') return '住宿';
  if (t === 'tourist_attraction') return '景點';
  return null;
}
function typeBadgeClass(t?: string) {
  if (t === 'restaurant') return 'bg-rose-50 text-rose-700 border-rose-200';
  if (t === 'lodging') return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  if (t === 'tourist_attraction') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return 'bg-slate-50 text-slate-700 border-slate-200';
}

// 把 DaySlot 攤平成「依造訪順序排列」的陣列（早 → 午餐 → 下午 → 住宿）
function flattenDaySequence(day: DaySlot): POI[] {
  const seq: POI[] = [];
  (day.morning || []).forEach(p => seq.push(p));
  if (day.lunch) seq.push(day.lunch);
  (day.afternoon || []).forEach(p => seq.push(p));
  if (day.lodging) seq.push(day.lodging);
  return seq;
}

/* ======================= Component ======================= */

export default function WidgetClient() {
  // Map refs
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInst = useRef<google.maps.Map | null>(null);
  const routePolylineRef = useRef<google.maps.Polyline | null>(null); // 路線折線
  const routeMarkersRef = useRef<google.maps.Marker[]>([]); // S/E 兩點
  const poiMarkersRef = useRef<google.maps.Marker[]>([]); // ✅ 行程（itinerary）用到的點
  const nearbyMarkersRef = useRef<google.maps.Marker[]>([]); // 附近探索（紅色）標記
  const userMarkerRef = useRef<google.maps.Marker | null>(null); // 目前位置（藍色針）
  const customCenterMarkerRef = useRef<google.maps.Marker | null>(null); // 自訂搜尋中心
  const searchCircleRef = useRef<google.maps.Circle | null>(null); // 搜尋範圍圓（藍系）
  const mapIdleListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const mapClickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const sharedInfoWindowRef = useRef<google.maps.InfoWindow | null>(null); // 共用 InfoWindow
  const routeStartRef = useRef<{ lat: number; lng: number } | null>(null); // 記住整體起點

  // 自訂搜尋中心
  const [centerInput, setCenterInput] = useState(''); // 可輸入座標或景點/地址
  const centerInputRef = useRef<HTMLInputElement | null>(null);
  const [pickOnMap, setPickOnMap] = useState(false);

  // Trip inputs
  const [origin, setOrigin] = useState('台北');
  const [destination, setDestination] = useState('墾丁');
  const [days, setDays] = useState(5);

  // States
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [routeInfo, setRouteInfo] = useState<{
    distance: string;
    duration: string;
    start: string;
    end: string;
  } | null>(null);

  // ✅ 以 DaySlot[] 取代舊的 DayPlan[]
  const [plan, setPlan] = useState<DaySlot[]>([]);

  // Nearby controls
  const [types, setTypes] = useState<string[]>(['tourist_attraction', 'restaurant']);
  const [radius, setRadius] = useState(1500);             // 實際半徑（number）
  const [radiusInput, setRadiusInput] = useState('1500'); // 顯示用字串（允許清空）
  const [keyword, setKeyword] = useState('');
  const [showCircle, setShowCircle] = useState(true);
  const [autoUpdateOnDrag, setAutoUpdateOnDrag] = useState(true);
  const [followMe, setFollowMe] = useState(false);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  // 行程標記篩選：-1=全部；其它=第 N 天(0-based index)
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(-1);
  const [autoZoomByFilter, setAutoZoomByFilter] = useState<boolean>(true);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const gmapsReady = useGoogleMaps(apiKey);

  /* ---------------- 初始化地圖 ---------------- */
  useEffect(() => {
    if (!gmapsReady || !mapRef.current || mapInst.current) return;
    mapInst.current = new google.maps.Map(mapRef.current, {
      center: { lat: 23.6978, lng: 120.9605 },
      zoom: 7,
      mapTypeControl: false,
      fullscreenControl: false,
      streetViewControl: false,
    });

    // 嘗試抓目前位置
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          mapInst.current!.setCenter(userPos);
          mapInst.current!.setZoom(13);
          if (userMarkerRef.current) userMarkerRef.current.setMap(null);
          userMarkerRef.current = new google.maps.Marker({
            position: userPos,
            map: mapInst.current!,
            icon: userBluePinIcon(),
            title: '目前位置',
            zIndex: 9999,
          });
          if (showCircle) drawSearchCircle(mapInst.current!.getCenter()!);
        },
        () => {
          if (showCircle) drawSearchCircle(mapInst.current!.getCenter()!);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    } else {
      if (showCircle) drawSearchCircle(mapInst.current.getCenter()!);
    }

    attachIdleListener();
  }, [gmapsReady]);

  /* ---------------- Places Autocomplete ---------------- */
  useEffect(() => {
    if (!gmapsReady || !centerInputRef.current) return;
    const ac = new google.maps.places.Autocomplete(centerInputRef.current, {
      fields: ['geometry', 'name', 'formatted_address'],
      types: ['geocode', 'establishment'],
    });
    const listener = ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      const loc = place?.geometry?.location;
      if (loc) {
        const p = { lat: loc.lat(), lng: loc.lng() };
        setCenterInput(place.formatted_address || place.name || (p.lat + ',' + p.lng));
        setCustomCenter(p);
      }
    });
    return () => listener.remove();
  }, [gmapsReady]);

  /* ---------------- Apps bridge init/listeners ---------------- */
  useEffect(() => {
    const params = readInitParams();
    if (params.origin) setOrigin(params.origin);
    if (params.destination) setDestination(params.destination);
    if (params.days) setDays(params.days);
    if (params.origin && params.destination) {
      setTimeout(() => planTrip(), 10);
    }

    const off = listen((msg: any) => {
      if (msg.type === 'init' || msg.type === 'set') {
        if (msg.payload.origin) setOrigin(msg.payload.origin);
        if (msg.payload.destination) setDestination(msg.payload.destination);
        if (typeof msg.payload.days === 'number') setDays(msg.payload.days);
        if (msg.type === 'init') setTimeout(() => planTrip(), 10);
      } else if (msg.type === 'ping') {
        send({ type: 'ready' });
      }
    });

    send({ type: 'ready' });
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  const testCases = useMemo(
    () => [
      { label: '台北 → 墾丁 · 5 天', origin: '台北', destination: '墾丁', days: 5 },
      { label: '台中 → 花蓮 · 3 天', origin: '台中', destination: '花蓮', days: 3 },
      { label: '高雄 → 台南 · 2 天', origin: '高雄', destination: '台南', days: 2 },
    ],
    []
  );

  function applyCase(c: { label: string; origin: string; destination: string; days: number }) {
    setOrigin(c.origin);
    setDestination(c.destination);
    setDays(c.days);
  }

  /* ======================= Trip planning ======================= */

  async function planTrip() {
    if (!gmapsReady || !mapInst.current) return;
    setLoading(true);
    setError('');
    setPlan([]);
    setRouteInfo(null);

    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, days }),
      });
      if (!res.ok) throw new Error('API error');
      const data: PlanResponse = await res.json();

      const g = google.maps;

      // 清除舊路線（保留圓、?、自訂中心與 Nearby 標記）
      if (routePolylineRef.current) {
        routePolylineRef.current.setMap(null);
        routePolylineRef.current = null;
      }
      routeMarkersRef.current.forEach((m) => m.setMap(null));
      routeMarkersRef.current = [];

      // 畫路線
      const polyPath = data.polyline.map(([lat, lng]) => ({ lat, lng }));
      routePolylineRef.current = new g.Polyline({
        path: polyPath,
        strokeWeight: 5,
        map: mapInst.current!,
      });

      // S/E
      routeMarkersRef.current.push(
        new g.Marker({ position: { lat: data.start.lat, lng: data.start.lng }, map: mapInst.current!, label: 'S', title: data.start.address })
      );
      routeMarkersRef.current.push(
        new g.Marker({ position: { lat: data.end.lat, lng: data.end.lng }, map: mapInst.current!, label: 'E', title: data.end.address })
      );

      // fit bounds 全路線一次
      const bounds = new g.LatLngBounds();
      polyPath.forEach((p) => bounds.extend(p));
      mapInst.current!.fitBounds(bounds);

      // 記住整體起點座標（供距離計算）
      routeStartRef.current = { lat: data.start.lat, lng: data.start.lng };

      // ✅ 使用後端的 itinerary
      setPlan(data.itinerary || []);
      // 預設顯示全部天
      setSelectedDayIdx(-1);

      // 依目前篩選（全部）重新繪製行程標記
      renderItineraryMarkers(data.itinerary || [], -1, /*fit*/ true);

      setRouteInfo({ distance: data.distanceText, duration: data.durationText, start: data.start.address, end: data.end.address });

      send({ type: 'result', payload: { origin, destination, days } });
    } catch (e: any) {
      setError('規劃失敗，請稍後再試。' + (e?.message ? '\n' + e.message : ''));
      send({ type: 'error', message: e?.message || 'plan_failed' });
    } finally {
      setLoading(false);
    }
  }

  // 收集（全部或某一天）行程點
  function collectItineraryPoints(itins: DaySlot[], dayIdx: number): POI[] {
    const used = new Set<string>();
    const pickKey = (p: POI) => (p._type || 'poi') + '@' + p.name + '@' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
    const points: POI[] = [];
    const daysToUse = dayIdx >= 0 ? itins.slice(dayIdx, dayIdx + 1) : itins;

    daysToUse.forEach((day) => {
      const blocks: (POI | undefined)[] = [
        ...(day.morning || []),
        day.lunch,
        ...(day.afternoon || []),
        day.lodging,
      ];
      blocks.forEach((p) => {
        if (!p) return;
        const k = pickKey(p);
        if (used.has(k)) return;
        used.add(k);
        points.push(p);
      });
    });

    return points;
  }

  // 依 itinerary 重新繪製標記（支援只顯示某一天）
  function renderItineraryMarkers(itins: DaySlot[], dayIdx: number, fitBounds = false) {
    if (!mapInst.current) return;

    // 清除既有 markers
    poiMarkersRef.current.forEach((m) => m.setMap(null));
    poiMarkersRef.current = [];

    const points = collectItineraryPoints(itins, dayIdx);

    // 建立新 markers（類型彩色 icon）
    poiMarkersRef.current = points.map((p) => {
      const mk = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        title: `${p.name}${p._type ? ` (${p._type})` : ''}`,
        map: mapInst.current!,
        icon: iconByType(p._type),
      });
      // 點擊顯示詳情（若有 place_id，打 details API）
      mk.addListener('click', () => openPlaceInfo(mk, p));
      return mk;
    });

    // 依點自動縮放（可關閉）
    if (fitBounds && points.length > 0 && autoZoomByFilter) {
      const b = new google.maps.LatLngBounds();
      points.forEach((p) => b.extend(new google.maps.LatLng(p.lat, p.lng)));
      mapInst.current.fitBounds(b);
    }
  }

  // 當切換「顯示第 N 天」或 plan 變動時，重畫標記
  useEffect(() => {
    if (!mapInst.current) return;
    if (plan.length === 0) {
      poiMarkersRef.current.forEach((m) => m.setMap(null));
      poiMarkersRef.current = [];
      return;
    }
    renderItineraryMarkers(plan, selectedDayIdx, /*fit*/ true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDayIdx, plan]);

  /* ======================= Nearby & Circle helpers ======================= */

  function drawSearchCircle(center: google.maps.LatLng) {
    if (!mapInst.current) return;
    if (searchCircleRef.current) {
      searchCircleRef.current.setCenter(center);
      searchCircleRef.current.setRadius(radius);
      searchCircleRef.current.setVisible(showCircle);
      searchCircleRef.current.setMap(showCircle ? mapInst.current : null);
      return;
    }
    searchCircleRef.current = new google.maps.Circle({
      center,
      radius,
      map: mapInst.current!,
      fillOpacity: 0.1,
      fillColor: '#93C5FD', // blue-300
      strokeOpacity: 0.7,
      strokeColor: '#2563EB', // blue-600
      strokeWeight: 2,
    });
    searchCircleRef.current.setVisible(showCircle);
  }

  function attachIdleListener() {
    mapIdleListenerRef.current?.remove();
    if (!mapInst.current || !autoUpdateOnDrag) return;
    mapIdleListenerRef.current = mapInst.current.addListener('idle', () => {
      if (!showCircle) return;
      const fixed = customCenterMarkerRef.current?.getPosition();
      drawSearchCircle(fixed ?? mapInst.current!.getCenter()!);
    });
  }

  // 半徑 / 顯示圓 更新
  useEffect(() => {
    if (mapInst.current && searchCircleRef.current) {
      searchCircleRef.current.setRadius(radius);
      searchCircleRef.current.setVisible(showCircle);
      searchCircleRef.current.setMap(showCircle ? mapInst.current : null);
    }
  }, [radius, showCircle]);

  // watchPosition（追蹤位置）
  useEffect(() => {
    if (!navigator.geolocation) return;

    if (followMe) {
      if (watchIdRef.current === null) {
        watchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            const userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            if (!userMarkerRef.current) {
              userMarkerRef.current = new google.maps.Marker({
                position: userPos,
                map: mapInst.current!,
                icon: userBluePinIcon(),
                title: '目前位置',
                zIndex: 9999,
              });
            } else {
              userMarkerRef.current.setPosition(userPos);
            }
            if (mapInst.current) {
              mapInst.current.setCenter(userPos);
              if (showCircle) drawSearchCircle(mapInst.current.getCenter()!);
            }
          },
          () => {},
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
        );
      }
    } else if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [followMe, showCircle]);

  // 判斷自訂中心是否啟用（marker 存在且在地圖上）
  function isCustomCenterActive() {
    const mk = customCenterMarkerRef.current;
    return !!(mk && mk.getMap());
  }

  function recenterToMe() {
    if (!mapInst.current || !userMarkerRef.current) return;
    const pos = userMarkerRef.current.getPosition();
    if (!pos) return;
    mapInst.current.setCenter(pos);
    mapInst.current.setZoom(15);
    if (showCircle) drawSearchCircle(pos);
    // 讓後續搜尋用目前地圖中心（關閉自訂中心）
    clearCustomCenter();
  }

  // 共用 InfoWindow 取用
  function getSharedInfoWindow() {
    if (!sharedInfoWindowRef.current) sharedInfoWindowRef.current = new google.maps.InfoWindow();
    return sharedInfoWindowRef.current;
  }

  // 產生 InfoWindow HTML
  function renderPlaceHtml(
    base: { name: string; vicinity?: string; rating?: number; user_ratings_total?: number },
    details?: any
  ) {
    const parts: string[] = [];
    parts.push('<div style="max-width:260px">');
    parts.push('<div style="font-weight:600;margin-bottom:4px">' + escapeHtml(base.name) + '</div>');
    if (base.vicinity) parts.push('<div style="font-size:12px;color:#475569">' + escapeHtml(base.vicinity) + '</div>');
    if (typeof base.rating === 'number') {
      parts.push('<div style="font-size:12px;margin-top:2px">評分：' + base.rating + '（' + (base.user_ratings_total || 0) + '）</div>');
    }
    if (details) {
      if (details.formatted_address) parts.push('<div style="font-size:12px;margin-top:6px">地址：' + escapeHtml(details.formatted_address) + '</div>');
      if (details.formatted_phone_number) parts.push('<div style="font-size:12px">電話：' + escapeHtml(details.formatted_phone_number) + '</div>');
      if (details.website) parts.push('<div style="font-size:12px"><a href="' + details.website + '" target="_blank" rel="noopener noreferrer">官方網站</a></div>');
      if (details.opening_hours?.weekday_text) {
        const ohAll = (details.opening_hours.weekday_text as string[]).join('<br/>');
        parts.push('<div style="font-size:12px;margin-top:6px">營業時間：</div>');
        parts.push(
          '<div style="font-size:12px;line-height:1.35;max-height:60px;overflow:auto;' +
            'margin-top:2px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px;background:#f8fafc;">' +
            ohAll +
          '</div>'
        );
      }
    }
    parts.push('</div>');
    return parts.join('');
  }

  function escapeHtml(s: string) {
    return s.replace(/[&<>\"']/g, (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      } as Record<string, string>)[c]!
    );
  }

  async function openPlaceInfo(marker: google.maps.Marker, base: any) {
    const iw = getSharedInfoWindow();
    iw.setContent('<div style="padding:4px 2px">載入中…</div>');
    iw.open({ anchor: marker, map: mapInst.current! });

    try {
      if (!base.place_id) {
        iw.setContent(renderPlaceHtml(base));
        return;
      }
      const r = await fetch('/api/places/details?place_id=' + encodeURIComponent(base.place_id));
      const data = await r.json();
      if (data.error) {
        iw.setContent(renderPlaceHtml(base));
        return;
      }
      iw.setContent(renderPlaceHtml(base, data));
    } catch {
      iw.setContent(renderPlaceHtml(base));
    }
  }

  /* ---------- Custom Search Center (coords/address/POI + pick on map) ---------- */

  async function geocodeAddress(query: string): Promise<google.maps.LatLngLiteral | null> {
    if (!query) return null;
    const geocoder = new google.maps.Geocoder();

    // 用目前地圖中心做偏好範圍（非限制，僅排序偏好）
    let bounds: google.maps.LatLngBounds | undefined;
    if (mapInst.current) {
      const c = mapInst.current.getCenter()!;
      const d = 0.3; // 約 30~40km 的方框
      bounds = new google.maps.LatLngBounds(
        new google.maps.LatLng(c.lat() - d, c.lng() - d),
        new google.maps.LatLng(c.lat() + d, c.lng() + d)
      );
    }

    const res = await geocoder.geocode({ address: query, bounds /*, region: 'tw'*/ });
    const r = res.results?.[0];
    if (!r) return null;
    const loc = r.geometry.location;
    return { lat: loc.lat(), lng: loc.lng() };
  }

  function setCustomCenter(pos: google.maps.LatLngLiteral) {
    if (!mapInst.current) return;
    if (!customCenterMarkerRef.current) {
      customCenterMarkerRef.current = new google.maps.Marker({
        position: pos,
        map: mapInst.current!,
        title: '自訂搜尋中心',
        icon: {
          url: 'https://maps.gstatic.com/mapfiles/ms2/micons/blue-dot.png',
          scaledSize: new google.maps.Size(32, 32),
          anchor: new google.maps.Point(16, 16),
        },
        zIndex: 9998,
      });
    } else {
      customCenterMarkerRef.current.setPosition(pos);
      customCenterMarkerRef.current.setMap(mapInst.current!);
    }
    mapInst.current.setCenter(pos);
    mapInst.current.setZoom(Math.max(mapInst.current.getZoom() || 13, 13));
    drawSearchCircle(new google.maps.LatLng(pos));
  }

  function clearCustomCenter() {
    if (customCenterMarkerRef.current) {
      customCenterMarkerRef.current.setMap(null);
    }
  }

  function enablePickOnMap(enable: boolean) {
    setPickOnMap(enable);
    mapClickListenerRef.current?.remove();
    mapClickListenerRef.current = null;
    if (enable && mapInst.current) {
      mapClickListenerRef.current = mapInst.current.addListener('click', (e: google.maps.MapMouseEvent) => {
        const ll = e.latLng!;
        setCenterInput(ll.lat().toFixed(6) + ',' + ll.lng().toFixed(6));
        setCustomCenter({ lat: ll.lat(), lng: ll.lng() });
      });
    }
  }

  /* ======================= Nearby search ======================= */

  async function searchNearby() {
    if (!mapInst.current) return;
    setNearbyLoading(true);
    try {
      // 只有自訂中心啟用時才使用，否則用地圖中心
      const center = isCustomCenterActive()
        ? customCenterMarkerRef.current!.getPosition()!
        : mapInst.current!.getCenter()!;
      if (showCircle) drawSearchCircle(center);
      const params = new URLSearchParams({ location: center.lat() + ',' + center.lng(), radius: String(radius) });
      types.forEach((t) => params.append('type', t));
      if (keyword) params.set('keyword', keyword);
      const r = await fetch('/api/places/nearby?' + params.toString());
      const data = await r.json();
      if (data.error) throw new Error(data.error);

      // 清除舊的「附近探索」標記（保留 S/E、行程POI、?、自訂中心與圓）
      nearbyMarkersRef.current.forEach((m) => m.setMap(null));
      nearbyMarkersRef.current = (data.items as any[])
        .map((it) => {
          if (!it.location) return null;
          const mk = new google.maps.Marker({
            position: it.location,
            map: mapInst.current!,
            title: it.name + (it._type ? ` (${it._type})` : ''),
          });
          mk.addListener('click', () => openPlaceInfo(mk, it));
          return mk;
        })
        .filter(Boolean) as google.maps.Marker[];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(e);
    } finally {
      setNearbyLoading(false);
    }
  }

  function clearNearbyResults() {
    nearbyMarkersRef.current.forEach((m) => m.setMap(null));
    nearbyMarkersRef.current = [];
    try { sharedInfoWindowRef.current?.close(); } catch {}
  }

  /* ======================= UI ======================= */

  return (
    <div className="min-h-screen w-full bg-white p-3 lg:p-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 items-start">
        <div className="relative w-full aspect-[16/10] rounded-xl shadow overflow-hidden border border-slate-200">
          <div ref={mapRef} id="map" style={{ width: '100%', height: '60vh', minHeight: 400 }} />
        </div>
        <div className="space-y-6">
          <Panel title="旅行條件">
            <div className="grid grid-cols-1 gap-3">
              <div className="flex flex-wrap gap-2">
                {testCases.map((c, i) => (
                  <button key={i} onClick={() => applyCase(c)} className="text-xs rounded-lg border px-2 py-1 hover:bg-slate-50">
                    {c.label}
                  </button>
                ))}
              </div>

              <label className="text-sm font-medium">起點（Origin）</label>
              <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="台北" className="border rounded-xl px-3 py-2" />

              <label className="text-sm font-medium">終點（Destination）</label>
              <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="墾丁" className="border rounded-xl px-3 py-2" />

              <label className="text-sm font-medium">天數（Days）</label>
              <input
                type="number"
                min={1}
                max={14}
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value || '1', 10))}
                className="border rounded-xl px-3 py-2 w-28"
              />

              {/* 顯示第 N 天標記（-1=全部） */}
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium">地圖標記顯示</label>
                <select
                  className="border rounded-xl px-3 py-2"
                  value={selectedDayIdx}
                  onChange={(e) => setSelectedDayIdx(parseInt(e.target.value, 10))}
                >
                  <option value={-1}>全部天數</option>
                  {plan.map((_, i) => (
                    <option key={i} value={i}>只顯示第 {i + 1} 天</option>
                  ))}
                </select>

                <label className="inline-flex items-center gap-2 ml-1 text-sm">
                  <input
                    type="checkbox"
                    checked={autoZoomByFilter}
                    onChange={(e) => setAutoZoomByFilter(e.target.checked)}
                  />
                  依篩選自動縮放
                </label>
              </div>

              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={planTrip}
                  className="mt-1 inline-flex items-center justify-center rounded-xl px-4 py-2 font-semibold shadow-sm bg-slate-900 text-white hover:bg-slate-800"
                >
                  {loading ? '規劃中…' : '規劃行程'}
                </button>
                <button onClick={recenterToMe} className="inline-flex items-center justify-center rounded-xl px-3 py-2 border" title="定位到目前位置">
                  定位到我
                </button>
              </div>

              {error && <div className="text-red-600 text-sm whitespace-pre-wrap">{error}</div>}
              <div className="text-xs text-slate-500">
                {gmapsReady ? 'Google Maps 模式（已讀到金鑰）。' : '尚未讀到 Google Maps，請確認 NEXT_PUBLIC_GOOGLE_MAPS_API_KEY。'}
              </div>
            </div>
          </Panel>

          <Panel title="路線摘要">
            {routeInfo ? (
              <div className="text-sm leading-6">
                <div>起點：{routeInfo.start}</div>
                <div>終點：{routeInfo.end}</div>
                <div>
                  總距離：{routeInfo.distance} ・ 估計時間：{routeInfo.duration}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">請先輸入條件並按「規劃行程」。</div>
            )}
          </Panel>

          <Panel title="附近探索（POI）">
            <div className="grid gap-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {[
                  { k: 'tourist_attraction', t: '景點' },
                  { k: 'lodging', t: '住宿' },
                  { k: 'restaurant', t: '餐廳' },
                  { k: 'cafe', t: '咖啡' },
                  { k: 'gas_station', t: '加油站' },
                ].map((opt) => (
                  <label key={opt.k} className="inline-flex items-center gap-2 border rounded-full px-3 py-1">
                    <input
                      type="checkbox"
                      checked={types.includes(opt.k)}
                      onChange={(e) => setTypes((prev) => (e.target.checked ? [...prev, opt.k] : prev.filter((x) => x !== opt.k)))}
                    />
                    {opt.t}
                  </label>
                ))}
              </div>

              <div>
                <label className="text-xs text-slate-600">半徑（公尺）</label>
                <input
                  type="number"
                  min={200}
                  max={5000}
                  value={radiusInput}
                  onChange={(e) => {
                    setRadiusInput(e.target.value); // 允許清空
                  }}
                  onBlur={() => {
                    const n = parseInt(radiusInput, 10);
                    if (isNaN(n)) {
                      setRadiusInput(String(radius)); // 還原
                      return;
                    }
                    const clamped = Math.max(200, Math.min(5000, n));
                    setRadius(clamped);
                    setRadiusInput(String(clamped));
                  }}
                  className="border rounded-xl px-3 py-2 w-32 ml-2"
                />
              </div>

              {/* 自訂搜尋中心 */}
              <div className="space-y-2">
                <label className="text-xs text-slate-600">自訂搜尋中心（輸入座標「lat,lng」或景點/地址）</label>
                <div className="flex gap-2">
                  <input
                    ref={centerInputRef}
                    value={centerInput}
                    onChange={(e) => setCenterInput(e.target.value)}
                    placeholder="例：25.033964,121.564468 或 台北101 / 台北車站"
                    className="border rounded-xl px-3 py-2 flex-1"
                  />
                  <button
                    type="button"
                    className="border rounded-xl px-3 py-2"
                    onClick={async () => {
                      if (!mapInst.current) return;
                      const ll = parseLatLng(centerInput) || await geocodeAddress(centerInput);
                      if (!ll) {
                        alert('無法解析位置，請輸入「lat,lng」或有效的景點/地址');
                        return;
                      }
                      setCustomCenter(ll);
                    }}
                  >
                    設為中心
                  </button>
                  <button
                    type="button"
                    className={`rounded-xl px-3 py-2 ${pickOnMap ? 'bg-slate-900 text-white' : 'border'}`}
                    onClick={() => enablePickOnMap(!pickOnMap)}
                    title="在地圖上點一下設定搜尋中心"
                  >
                    {pickOnMap ? '點選中…' : '用地圖選點'}
                  </button>
                  <button type="button" className="border rounded-xl px-3 py-2" onClick={() => { clearCustomCenter(); }}>
                    清除中心
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  目前中心：{
                    customCenterMarkerRef.current?.getPosition()
                      ? `${customCenterMarkerRef.current.getPosition()!.lat().toFixed(6)}, ${customCenterMarkerRef.current.getPosition()!.lng().toFixed(6)}`
                      : '使用地圖中心'
                  }
                </div>
              </div>

              <div className="flex items-center gap-4">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={showCircle} onChange={(e) => setShowCircle(e.target.checked)} />
                  顯示搜尋範圍圓
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={autoUpdateOnDrag} onChange={(e) => setAutoUpdateOnDrag(e.target.checked)} />
                  拖曳地圖時更新圓
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={followMe} onChange={(e) => setFollowMe(e.target.checked)} />
                  追蹤我的位置
                </label>
              </div>

              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="ramen / coffee / museum ..." className="border rounded-xl px-3 py-2" />

              <div className="flex gap-2">
                <button
                  onClick={searchNearby}
                  className="inline-flex items-center justify-center rounded-xl px-4 py-2 font-semibold shadow-sm bg-slate-900 text-white hover:bg-slate-800"
                >
                  {nearbyLoading ? '搜尋中…' : '搜尋附近'}
                </button>
                <button
                  onClick={clearNearbyResults}
                  className="inline-flex items-center justify-center rounded-xl px-4 py-2 border hover:bg-slate-50"
                  title="清除附近探索的紅色標記"
                >
                  清除搜尋結果
                </button>
              </div>
            </div>
          </Panel>

          <Panel title="每日行程">
            {plan.length === 0 ? (
              <div className="text-sm text-slate-500">尚無行程。</div>
            ) : (
              <div className="space-y-4">
                {plan.map((day, dayIdx) => {
                  // 將今天的順序展開：上午(1–2) → 午餐(1) → 下午(1–2) → 住宿(1)
                  const seq = flattenDaySequence(day);

                  // 計算本日距離
                  let dailyTotalKm = 0;
                  for (let i = 0; i < seq.length; i++) {
                    const prev =
                      i === 0
                        ? (dayIdx === 0 ? routeStartRef.current : (plan[dayIdx - 1]?.lodging || plan[dayIdx - 1]?.afternoon?.slice(-1)[0] || plan[dayIdx - 1]?.morning?.slice(-1)[0])) as any
                        : seq[i - 1];
                    if (prev) dailyTotalKm += haversineKm({ lat: prev.lat, lng: prev.lng }, { lat: seq[i].lat, lng: seq[i].lng });
                  }

                  // 區塊渲染小工具
                  const renderPOI = (p: POI | undefined, anchor?: { lat: number; lng: number }) => {
                    if (!p) return null;
                    const leg = anchor ? haversineKm(anchor, { lat: p.lat, lng: p.lng }) : 0;
                    return (
                      <li className="ml-4">
                              <div className="font-medium flex items-center gap-2">
                                <span>{p.name}</span>
                                {p._type && (
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${typeBadgeClass(p._type)}`}>
                              {typeLabel(p._type) || p._type}
                                  </span>
                                )}
                              </div>
                        {p.address && <div className="text-xs text-slate-600">{p.address}</div>}
                        {anchor && (
                          <div className="text-xs text-slate-500">距上個點：{fmtDistance(leg)}</div>
                              )}
                        </li>
                          );
                  };

                  // 依段落顯示
                  const m0 = day.morning?.[0];
                  const m1 = day.morning?.[1];
                  const anchorMorning0 =
                    dayIdx === 0
                      ? routeStartRef.current || undefined
                      : (plan[dayIdx - 1]?.lodging || plan[dayIdx - 1]?.afternoon?.slice(-1)[0] || plan[dayIdx - 1]?.morning?.slice(-1)[0]) as any;
                  const anchorMorning1 = m0;
                  const anchorLunch = day.morning?.slice(-1)[0];
                  const anchorAfternoon0 = day.lunch || day.morning?.slice(-1)[0];
                  const anchorAfternoon1 = day.afternoon?.[0];
                  const anchorLodging = day.afternoon?.slice(-1)[0] || day.morning?.slice(-1)[0];

                  return (
                    <div key={dayIdx} className="border rounded-xl p-3">
                      <div className="font-semibold">第 {dayIdx + 1} 天</div>

                      <div className="mt-2">
                        <div className="text-sm font-medium">上午</div>
                        <ol className="list-decimal ml-5 space-y-1">
                          {renderPOI(m0, anchorMorning0 || undefined)}
                          {renderPOI(m1, anchorMorning1 || undefined)}
                        </ol>
                        </div>

                      <div className="mt-2">
                        <div className="text-sm font-medium">中午（餐廳）</div>
                        <ol className="list-decimal ml-5 space-y-1">
                          {renderPOI(day.lunch, anchorLunch || undefined)}
                        </ol>
                        </div>

                      <div className="mt-2">
                        <div className="text-sm font-medium">下午</div>
                        <ol className="list-decimal ml-5 space-y-1">
                          {renderPOI(day.afternoon?.[0], anchorAfternoon0 || undefined)}
                          {renderPOI(day.afternoon?.[1], anchorAfternoon1 || undefined)}
                        </ol>
                        </div>

                      <div className="mt-2">
                        <div className="text-sm font-medium">晚上（住宿）</div>
                        <ol className="list-decimal ml-5 space-y-1">
                          {renderPOI(day.lodging, anchorLodging || undefined)}
                        </ol>
                      </div>

                      {seq.length > 0 && (
                        <div className="text-xs text-slate-500 mt-2">
                          本日景點間直線距離合計：約 {fmtDistance(dailyTotalKm)}
                        </div>
                      )}
                  </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
