// middleware.ts
import { NextRequest, NextResponse } from 'next/server';

export const config = {
  matcher: ['/api/:path*'], // 只保護 API
};

// ---- 安全 fallback：沒設 Upstash 也不會壞 ----
const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
let ratelimitReady = Boolean(REST_URL && REST_TOKEN);

let Ratelimit: any;
let Redis: any;
let ratelimit: any;

async function ensureRatelimit() {
  if (!ratelimitReady || ratelimit) return;
  // 動態載入，避免本機沒裝套件或邊緣情境報錯
  const [{ Ratelimit: RL }, { Redis: RD }] = await Promise.all([
    import('@upstash/ratelimit'),
    import('@upstash/redis'),
  ]);
  Ratelimit = RL;
  Redis = RD;
  const redis = Redis.fromEnv();
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, '1 m'), // 每分鐘 60 次
    analytics: true,
    prefix: 'rl:tripi',
  });
}

export default async function middleware(req: NextRequest) {
  try {
    // 沒設 Upstash 就放行（建議盡快補上環境變數）
    if (!ratelimitReady) return NextResponse.next();

    await ensureRatelimit();

  const ip =
    req.ip ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';

  const { success, limit, reset, remaining } = await ratelimit.limit(ip);
  if (!success) {
    return new NextResponse(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
          'Cache-Control': 'no-store',
      },
    });
  }

    return NextResponse.next();
  } catch {
    // Upstash 異常時，不要把站點鎖死，選擇放行
  return NextResponse.next();
  }
}
