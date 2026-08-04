import { deriveDelta } from '@xln/runtime/account/utils';
import type { Delta, DerivedDelta } from '@xln/runtime/types/account';

export type OpsDerivedDelta = Readonly<Record<Exclude<keyof DerivedDelta, 'ascii'>, string> & { ascii: string }>;
const integer = (value: string, field: keyof Delta): bigint => {
  const clean = value.trim();
  if (!/^-?\d+$/.test(clean)) throw new Error(`OPS_DELTA_INTEGER_INVALID:${field}`);
  return BigInt(clean);
};
export const parseOpsDelta = (input: Readonly<Record<keyof Delta, string>>): Delta => {
  const tokenId = Number(input.tokenId);
  if (!Number.isSafeInteger(tokenId) || tokenId < 1) throw new Error('OPS_DELTA_TOKEN_ID_INVALID');
  return Object.freeze({ tokenId, collateral: integer(input.collateral, 'collateral'), ondelta: integer(input.ondelta, 'ondelta'), offdelta: integer(input.offdelta, 'offdelta'), leftCreditLimit: integer(input.leftCreditLimit, 'leftCreditLimit'), rightCreditLimit: integer(input.rightCreditLimit, 'rightCreditLimit'), leftAllowance: integer(input.leftAllowance, 'leftAllowance'), rightAllowance: integer(input.rightAllowance, 'rightAllowance'), leftHold: integer(input.leftHold, 'leftHold'), rightHold: integer(input.rightHold, 'rightHold') });
};
export const deriveOpsDelta = (delta: Delta, isLeft: boolean): OpsDerivedDelta => {
  const derived = deriveDelta(delta, isLeft);
  return Object.freeze(Object.fromEntries(Object.entries(derived).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])) as OpsDerivedDelta);
};
