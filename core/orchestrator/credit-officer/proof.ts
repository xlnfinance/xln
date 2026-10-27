import { sha256 } from '@noble/hashes/sha2.js';

/** Testnet underwriting stays outside RJEA. Work replaces external CAPTCHA;
 * committed reputation earns larger limits. Work costs resources, not identity.
 * Bind the whole request so changing asset, amount or term cannot reuse work. */
export type CreditRequest = {
  hubEntityId: string;
  borrowerEntityId: string;
  day: string;
  tokenId: number;
  amount: string;
  termId: '1h' | '1d' | '1m';
  nonce: string;
};

export const creditDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export function decodeCreditRequest(value: unknown): CreditRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  const r = value as Record<string, unknown>;
  for (const key of ['hubEntityId', 'borrowerEntityId']) {
    if (typeof r[key] !== 'string' || !/^0x[0-9a-f]{64}$/.test(r[key])) throw new Error('INVALID_ENTITY');
  }
  if (typeof r['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r['day'])) throw new Error('INVALID_DAY');
  if (!Number.isSafeInteger(r['tokenId']) || Number(r['tokenId']) < 1) throw new Error('INVALID_TOKEN');
  if (typeof r['amount'] !== 'string' || !/^[1-9]\d{0,77}$/.test(r['amount'])) throw new Error('INVALID_AMOUNT');
  if (typeof r['termId'] !== 'string' || !['1h', '1d', '1m'].includes(r['termId'])) throw new Error('INVALID_TERM');
  if (typeof r['nonce'] !== 'string' || !/^[0-9a-f]{1,64}$/.test(r['nonce'])) throw new Error('INVALID_NONCE');
  return r as CreditRequest;
}

export const proofDigest = (r: CreditRequest): Uint8Array =>
  sha256(
    new TextEncoder().encode(
      ['xln-credit-officer', r.hubEntityId, r.borrowerEntityId, r.day, r.tokenId, r.amount, r.termId, r.nonce].join(
        ':',
      ),
    ),
  );

export function validCreditProof(r: CreditRequest, hub: string, now: number, bits: number): boolean {
  if (r.hubEntityId !== hub || r.day !== creditDay(now) || !Number.isInteger(bits) || bits < 1 || bits > 32)
    return false;
  const hash = proofDigest(r);
  for (let i = 0; i < Math.ceil(bits / 8); i++) {
    const byte = hash[i];
    if (byte === undefined) return false;
    if (byte >>> (8 - Math.min(8, bits - i * 8)) !== 0) return false;
  }
  return true;
}
