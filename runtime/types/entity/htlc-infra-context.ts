import type { OpaqueHtlcCiphertext } from '../../protocol/htlc/multi-recipient';
import type { AccountStateDomain } from '../account';

export type PreparedHtlcInboundBinding = Readonly<{
  fromEntityId: string;
  toEntityId: string;
  domain: AccountStateDomain;
  accountFrameHash: string;
  accountHeight: number;
  lockId: string;
  envelopeHash: string;
  hashlock: string;
  tokenId: number;
  amount: bigint;
  timelock: bigint;
  revealBeforeHeight: number;
}>;

type PreparedHtlcOutcome =
  | Readonly<{
      kind: 'forward';
      nextHopEntityId: string;
      forwardAmount: bigint;
      innerEnvelope: OpaqueHtlcCiphertext;
    }>
  | Readonly<{
      kind: 'final';
      secret: string;
      description?: string;
      startedAtMs?: number;
    }>
  | Readonly<{
      kind: 'reject';
      reason:
        | 'ciphertext_invalid'
        | 'decrypt_failed'
        | 'next_hop_account_missing'
        | 'next_hop_offline'
        | 'insufficient_capacity'
        | 'fee_below_policy'
        | 'deadline_unsafe';
    }>;

export type PreparedHtlcEntry = Readonly<{
  binding: PreparedHtlcInboundBinding;
  outcome: PreparedHtlcOutcome;
}>;

export type PreparedOriginatedHtlcPayment = Readonly<{
  /** Canonical hash of the exact raw htlcPayment EntityTx selected in this frame. */
  txHash: string;
  targetEntityId: string;
  tokenId: number;
  recipientAmount: bigint;
  route: readonly string[];
  description: string;
  deliveryMode: 'instant' | 'async';
  startedAtMs: number;
  hashlock: string;
  senderLockAmount: bigint;
  maxSenderDebit: bigint;
  totalFee: bigint;
  lockId: string;
  timelock: bigint;
  revealBeforeHeight: number;
  nextHopEntityId: string;
  envelope: OpaqueHtlcCiphertext;
}>;

export type HtlcPreparedInfraContext = Readonly<{
  version: 1;
  entries: readonly PreparedHtlcEntry[];
  originated: readonly PreparedOriginatedHtlcPayment[];
}>;

export const preparedHtlcBindingKey = (binding: PreparedHtlcInboundBinding): string =>
  `${binding.accountFrameHash}:${binding.lockId}`;
