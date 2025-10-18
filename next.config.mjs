// next.config.mjs
const securityHeaders = [
  // 長效 HTTPS 強制
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  // 基本硬化
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // 僅允許本網站使用地理定位；其他敏感權限關閉
  { key: 'Permissions-Policy', value: "geolocation=(self), camera=(), microphone=()" },
  // 內容安全策略（依實際使用調整）
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 你的頁面腳本來源（Google Maps 需要）
      "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com",
      // 樣式（Tailwind inline 與 Google Fonts）
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      // 圖片（含 data:、blob:、Google Maps/Places Photo）
      "img-src 'self' data: blob: https://maps.gstatic.com https://maps.googleapis.com https://lh3.googleusercontent.com",
      // 字型
      "font-src 'self' https://fonts.gstatic.com",
      // XHR / fetch 目的地（你的 API 同源 + Google Maps API）
      "connect-src 'self' https://maps.googleapis.com",
      // Web Worker（如未用可移除）
      "worker-src 'self' blob:",
      // 嵌入/被嵌入限制
      "frame-ancestors 'none'",
      // 其他安全細節
      "base-uri 'self'",
      "form-action 'self'",
      // 將 http 子資源升級為 https，避免混合內容
      "upgrade-insecure-requests"
    ].join('; ')
  },
];

export default {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};
