
export type InitParams = { origin?: string; destination?: string; days?: number };

export function readInitParams(): InitParams {
  const u = new URL(window.location.href);
  const p = Object.fromEntries(u.searchParams.entries());
  const days = p.days ? parseInt(p.days, 10) : undefined;
  return {
    origin: p.origin,
    destination: p.destination,
    days: Number.isFinite(days) ? days : undefined,
  };
}

export type IncomingMessage =
  | { type: 'init'; payload: InitParams }
  | { type: 'set'; payload: InitParams }
  | { type: 'focus' }
  | { type: 'ping' };

export type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'result'; payload: any }
  | { type: 'error'; message: string }
  | { type: 'log'; payload: any };

export function listen(handler: (msg: IncomingMessage) => void) {
  window.addEventListener('message', (ev) => {
    try {
      if (typeof ev.data !== 'object' || !ev.data) return;
      if (!('type' in ev.data)) return;
      handler(ev.data as IncomingMessage);
    } catch (e) {}
  });
}

export function send(msg: OutgoingMessage) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  } catch {}
}
