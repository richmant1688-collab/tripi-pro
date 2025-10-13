
# 旅行柴柴 Tripi Pro — AI Travel Navigator (Next.js)

完整可部署專案：
- `/app/page.tsx`：前台（Leaflet 地圖 + 表單）
- `/app/widget/page.tsx`：ChatGPT Apps 用 Widget（可內嵌；完整互動）
- `/app/api/plan/route.ts`：後端 API（有 GOOGLE_MAPS_API_KEY 則用 Google，否則 OSM/OSRM）
- `/lib/apps-bridge.ts`：簡易橋接（可替換為 Apps SDK 正式 API）
- `/public/app-manifest.json`、`/public/privacy.html`、`/public/terms.html`：上架需要
- `/public/icons/*`：icon 與 banner 佔位

## 本機開發
```bash
npm i
cp .env.example .env.local     # 可選，填入 GOOGLE_MAPS_API_KEY
npm run dev                    # http://localhost:3000
```

- Widget 測試：`http://localhost:3000/widget?origin=台北&destination=墾丁&days=5`

## 部署（Vercel）
1. Push 到 GitHub → Vercel Import Project → Framework: Next.js
2. （可選）環境變數 `GOOGLE_MAPS_API_KEY`
3. Deploy 後 Widget URL 例：`https://your-domain/widget`

## ChatGPT Apps 上架（摘要）
- 名稱：旅行柴柴 Tripi Pro — AI Travel Navigator
- Widget URL：`https://your-domain/widget`
- Privacy / Terms：`/privacy`、`/terms`
- 類別：Travel；權限：免登入
- 測試案例：台北→墾丁五日、台中→花蓮三日、高雄→台南兩日
