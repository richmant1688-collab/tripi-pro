// lib/apps-bridge.ts
export type BridgeInit = { origin?: string; destination?: string; days?: number };

type InMsg =
  | { type: 'init'; payload: BridgeInit }
  | { type: 'set'; payload: Partial<BridgeInit> }
  | { type: 'ping' };

type OutMsg =
  | { type: 'ready' }
  | { type: 'result'; payload: BridgeInit }
  | { type: 'error'; message: string };

export function readInitParams(): BridgeInit {
  if (typeof window === 'undefined') return {};
  const u = new URL(window.location.href);
  const daysStr = u.searchParams.get('days') ?? undefined;
  return {
    origin: u.searchParams.get('origin') ?? undefined,
    destination: u.searchParams.get('destination') ?? undefined,
    days: daysStr ? Number(daysStr) : undefined,
  };
}

export function listen(handler: (msg: InMsg) => void) {
  if (typeof window === 'undefined') return;
  const fn = (e: MessageEvent) => {
    const msg = e.data as InMsg;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    handler(msg);
  };
  window.addEventListener('message', fn);
  // 回傳解除註冊
  return () => window.removeEventListener('message', fn);
}

export function send(msg: OutMsg) {
  if (typeof window === 'undefined') return;
  // 發給父層（被 iframe 時）以及自己（自測）
  try { window.parent.postMessage(msg, '*'); } catch {}
  try { window.postMessage(msg, '*'); } catch {}
}
