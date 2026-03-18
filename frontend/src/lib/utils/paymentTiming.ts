export type PaymentTimingInfo = {
  displayDescription: string;
  startedAtMs: number | null;
};

const TS_MARKER_RE = /(?:^|\s)tsms:(\d{10,})(?=$|\s)/i;

export function appendPaymentTimestamp(description: string, startedAtMs = Date.now()): string {
  const clean = stripPaymentTimestamp(description);
  const marker = `tsms:${Math.max(0, Math.trunc(startedAtMs))}`;
  return clean ? `${clean} ${marker}` : marker;
}

export function stripPaymentTimestamp(description: string): string {
  return String(description || '')
    .replace(TS_MARKER_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePaymentTiming(description: string): PaymentTimingInfo {
  const raw = String(description || '').trim();
  const match = raw.match(TS_MARKER_RE);
  const startedAtMs = match?.[1] ? Number(match[1]) : null;
  return {
    displayDescription: stripPaymentTimestamp(raw),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
  };
}
