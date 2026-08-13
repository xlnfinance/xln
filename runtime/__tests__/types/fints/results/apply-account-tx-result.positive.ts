import type {
  ApplyAccountTxApplied,
  ApplyAccountTxOk,
  ApplyAccountTxRejected,
  ApplyAccountTxResult,
} from '../../../../account/tx/apply-types';
import { ACCOUNT_TX_REJECTION_CODES } from '../../../../account/tx/apply-types';
import {
  toHashlock,
  toHtlcSecret,
  toLockId,
  toTokenAmount,
  toTokenId,
  type Hashlock,
  type HtlcSecret,
  type LockId,
  type TokenAmount,
  type TokenId,
} from '../../../../account/tx/units';
import {
  toJHeight,
  toUnixMs,
  type JHeight,
  type UnixMs,
} from '../../../../protocol/units';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type NotEqual<A, B> = Equal<A, B> extends true ? false : true;
type AppliedHasNoRejection = Expect<Equal<keyof ApplyAccountTxApplied & 'rejection', never>>;
type RejectedHasNoOutcome = Expect<Equal<keyof ApplyAccountTxRejected & 'outcome', never>>;
type OkHasNoSuccessAlias = Expect<Equal<keyof ApplyAccountTxOk & 'success', never>>;
type ResultHasNoErrorField = Expect<Equal<keyof ApplyAccountTxResult & 'error', never>>;
type HashlockIsNotLockId = Expect<NotEqual<Hashlock, LockId>>;
type UnixMsIsNotJHeight = Expect<NotEqual<UnixMs, JHeight>>;

const applied: ApplyAccountTxResult = {
  ok: true,
  outcome: 'applied',
  events: ['➕ Added token 1 to account'],
};

const rejected: ApplyAccountTxResult = {
  ok: false,
  events: ['ACCOUNT_DELTA_TOKEN_INVALID:1'],
  rejection: {
    kind: 'delta_token_invalid',
    code: ACCOUNT_TX_REJECTION_CODES.deltaTokenInvalid,
    message: 'ACCOUNT_DELTA_TOKEN_INVALID:1',
    tokenId: 1,
  },
};

export const fintsPositiveAccountTxResult = (): {
  applied: ApplyAccountTxApplied;
  rejected: ApplyAccountTxRejected;
  hashlock: Hashlock;
  secret: HtlcSecret;
  lockId: LockId;
  tokenId: TokenId;
  amount: TokenAmount;
  timestamp: UnixMs;
  jHeight: JHeight;
  covered: [AppliedHasNoRejection, RejectedHasNoOutcome, OkHasNoSuccessAlias, ResultHasNoErrorField, HashlockIsNotLockId, UnixMsIsNotJHeight];
} => {
  if (!applied.ok) throw new Error('FINTS_POSITIVE_APPLIED');
  if (rejected.ok) throw new Error('FINTS_POSITIVE_REJECTED');
  return {
    applied,
    rejected,
    hashlock: toHashlock(`0x${'11'.repeat(32)}`),
    secret: toHtlcSecret(`0x${'22'.repeat(32)}`),
    lockId: toLockId('lock-timeout-boundary'),
    tokenId: toTokenId(1),
    amount: toTokenAmount(7n),
    timestamp: toUnixMs(1_000),
    jHeight: toJHeight(0),
    covered: [true, true, true, true, true, true],
  };
};
