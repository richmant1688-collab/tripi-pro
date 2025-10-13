// app/widget/WidgetClient.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
// ⛔️ 不要在頂層 import 'leaflet' / 'leaflet.css'（避免 SSR 觸發）；改用動態載入
import { readInitParams, listen, send } from '../../lib/apps-bridge';

type POI = { name: string; lat: number; lng: number; address?: string; rating?: number };
type DayPlan = { day: number; city: string; pois: POI[] };

type PlanResponse = {
  provider: 'google' | 'osrm';
  polyline: [number, number][];
  start: { lat: number; lng: number; address: string };
  end: { lat: number; lng: number; address: string };
  distanceText: string;
  durationText: string;
  pois: POI[];
};

const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-full lg:w-96 bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-gray-100 p-4 lg:p-5 space-y-3">
      <div className="text-xl font-semibold">{title}</div>
      {children}
    </div>
  );
}

export default function WidgetClient() {
  const mapRef = useRef<HTMLDivElement>(null); // ✅ 加這行

  useEffect(() => {
    if (!mapRef.current) return;
    // 你的 Google Maps 初始化程式碼
    const map = new google.maps.Map(mapRef.current, {
      center: { lat: 23.6978, lng: 120.9605 },
      zoom: 7,
    });
  }, []);

  return (
    <div
      id="map"
      ref={mapRef}
      style={{
        width: '100%',
        height: '60vh',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
      }}
    />
  );
}

  // ---- Google / Leaflet 狀態 ----
  const [usingGoogle, setUsingGoogle] = useState(false);
  const googleMapRef = useRef<any>(null);
  const googleOverlaysRef = useRef<{ poly?: any; markers: any[] }>({ markers: [] });

  const LRef = useRef<any>(null);
  const leafletMapRef = useRef<any>(null);
  const leafletRouteRef = useRef<any>(null);
  const leafletMarkersRef = useRef<any>(null);

  // ---- UI 狀態 ----
  const [origin, setOrigin] = useState('台北');
  const [destination, setDestination] = useState('墾丁');
  const [days, setDays] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string; start: string; end: string } | null>(null);
  const [plan, setPlan] = useState<DayPlan[]>([]);

  // -----------------------------
  // 初始化：先嘗試載入 Google，失敗再用 Leaflet
  // -----------------------------
  useEffect(() => {
    let cancelled = false;

    async function initGoogle(): Promise<boolean> {
      if (!GOOGLE_KEY) return false;
      if ((window as any).google?.maps) return true;

      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&libraries=places`;
        s.async = true;
        s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('gmaps_script_error'));
        document.head.appendChild(s);
      });

      return !!(window as any).google?.maps;
    }

    async function boot() {
      if (cancelled || !mapRef.current) return;

      // 優先 Google
      try {
        const ok = await initGoogle();
        if (!ok) throw new Error('gmaps_unavailable');

        const g = (window as any).google;
        const map = new g.maps.Map(mapRef.current, {
          center: { lat: 23.6978, lng: 120.9605 },
          zoom: 7,
          mapTypeControl: false,
          fullscreenControl: false,
          streetViewControl: false,
        });
        googleMapRef.current = map;
        setUsingGoogle(true);
        return;
      } catch {
        // ignore → fallback to Leaflet
      }

      // Leaflet fallback
      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      LRef.current = L;
      const map = L.map(mapRef.current!, { zoomControl: true }).setView([23.6978, 120.9605], 7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      leafletMarkersRef.current = L.layerGroup().addTo(map);
      leafletMapRef.current = map;
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  // -----------------------------
  // Apps SDK 參數 / 事件
  // -----------------------------
  useEffect(() => {
    const params = readInitParams();
    if (params.origin) setOrigin(params.origin);
    if (params.destination) setDestination(params.destination);
    if (params.days) setDays(params.days);
    if (params.origin && params.destination) setTimeout(() => planTrip(), 10);

    listen((msg) => {
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
  }, []);

  // -----------------------------
  // 範例測試
  // -----------------------------
  const testCases = useMemo(
    () => [
      { label: '台北 → 墾丁 · 5 天', origin: '台北', destination: '墾丁', days: 5 },
      { label: '台中 → 花蓮 · 3 天', origin: '台中', destination: '花蓮', days: 3 },
      { label: '高雄 → 台南 · 2 天', origin: '高雄', destination: '台南', days: 2 },
    ],
    []
  );

  function applyCase(c: any) {
    setOrigin(c.origin);
    setDestination(c.destination);
    setDays(c.days);
  }

  // -----------------------------
  // 核心：規劃並畫在地圖
  // -----------------------------
  async function planTrip() {
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

      if (usingGoogle && googleMapRef.current) {
        const g = (window as any).google;
        const map = googleMapRef.current;

        // 清除舊疊加物
        googleOverlaysRef.current.poly?.setMap(null);
        googleOverlaysRef.current.markers.forEach((m) => m.setMap(null));
        googleOverlaysRef.current.markers = [];

        // 路線
        const path = data.polyline.map(([lat, lng]) => ({ lat, lng }));
        const poly = new g.maps.Polyline({ path, strokeWeight: 5 });
        poly.setMap(map);
        googleOverlaysRef.current.poly = poly;

        // 起終點
        googleOverlaysRef.current.markers.push(
          new g.maps.Marker({ position: { lat: data.start.lat, lng: data.start.lng }, label: 'S', map }),
          new g.maps.Marker({ position: { lat: data.end.lat, lng: data.end.lng }, label: 'E', map })
        );

        // 框選
        const bounds = new g.maps.LatLngBounds();
        path.forEach((p: any) => bounds.extend(p));
        map.fitBounds(bounds, 40);

        // POI
        data.pois.slice(0, 25).forEach((p) => {
          googleOverlaysRef.current.markers.push(
            new g.maps.Marker({ position: { lat: p.lat, lng: p.lng }, title: p.name, map })
          );
        });
      } else {
        // Leaflet
        const L = LRef.current || (await import('leaflet')).default;
        const map = leafletMapRef.current;
        if (!map) throw new Error('leaflet_not_ready');

        if (leafletRouteRef.current) leafletRouteRef.current.remove();
        if (leafletMarkersRef.current) leafletMarkersRef.current.clearLayers();

        leafletRouteRef.current = L.polyline(data.polyline, { weight: 5 }).addTo(map);
        L.marker([data.start.lat, data.start.lng]).addTo(leafletMarkersRef.current).bindPopup('起點');
        L.marker([data.end.lat, data.end.lng]).addTo(leafletMarkersRef.current).bindPopup('終點');
        map.fitBounds(leafletRouteRef.current.getBounds(), { padding: [20, 20] });

        data.pois.slice(0, 25).forEach((p: POI) => {
          L.marker([p.lat, p.lng], { title: p.name }).addTo(leafletMarkersRef.current);
        });
      }

      // UI 資訊
      setRouteInfo({
        distance: data.distanceText,
        duration: data.durationText,
        start: data.start.address,
        end: data.end.address,
      });

      const perDay = Math.max(2, Math.min(3, Math.ceil((data.pois.length || 2) / days)));
      const daysPlan: DayPlan[] = [];
      for (let d = 0; d < days; d++) {
        const slice = data.pois.slice(d * perDay, (d + 1) * perDay);
        daysPlan.push({ day: d + 1, city: destination, pois: slice });
      }
      setPlan(daysPlan);

      send({ type: 'result', payload: { origin, destination, days } });
    } catch (e: any) {
      setError('規劃失敗，請檢查伺服器或稍後再試。' + (e?.message ? '\n' + e.message : ''));
      send({ type: 'error', message: e?.message || 'plan_failed' });
    } finally {
      setLoading(false);
    }
  }

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="min-h-screen w-full bg-white p-3 lg:p-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6 items-start">
        <div className="relative w-full aspect-[16/10] rounded-xl shadow overflow-hidden border border-slate-200">
          <div ref={mapRef} className="absolute inset-0" />
        </div>

        <div className="space-y-6">
          <Panel title="旅行條件">
            <div className="grid grid-cols-1 gap-3">
              <div className="flex flex-wrap gap-2">
                {testCases.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => applyCase(c)}
                    className="text-xs rounded-lg border px-2 py-1 hover:bg-slate-50"
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <label className="text-sm font-medium">起點（Origin）</label>
              <input
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="台北"
                className="border rounded-xl px-3 py-2"
              />

              <label className="text-sm font-medium">終點（Destination）</label>
              <input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="墾丁"
                className="border rounded-xl px-3 py-2"
              />

              <label className="text-sm font-medium">天數（Days）</label>
              <input
                type="number"
                min={1}
                max={14}
                value={days}
                onChange={(e) => setDays(parseInt(e.target.value || '1', 10))}
                className="border rounded-xl px-3 py-2 w-28"
              />

              <button
                onClick={planTrip}
                className="mt-1 inline-flex items-center justify-center rounded-xl px-4 py-2 font-semibold shadow-sm bg-slate-900 text-white hover:bg-slate-800"
              >
                {loading ? '規劃中…' : '規劃行程'}
              </button>

              {error && <div className="text-red-600 text-sm whitespace-pre-wrap">{error}</div>}
              <div className="text-xs text-slate-500">
                {usingGoogle ? 'Google Maps 模式（已讀到金鑰）。' : 'OpenStreetMap/Leaflet 模式（未提供或載入 Google 失敗時的預設）。'}
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

          <Panel title="每日行程">
            {plan.length === 0 ? (
              <div className="text-sm text-slate-500">尚無行程。</div>
            ) : (
              <div className="space-y-4">
                {plan.map((day) => (
                  <div key={day.day} className="border rounded-xl p-3">
                    <div className="font-semibold">
                      第 {day.day} 天 · {destination}
                    </div>
                    <ol className="list-decimal ml-5 mt-1 space-y-1">
                      {day.pois.map((p, i) => (
                        <li key={i}>
                          <div className="font-medium">{p.name}</div>
                          {p.address && <div className="text-xs text-slate-600">{p.address}</div>}
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
