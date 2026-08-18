/**
 * Entity-layer digest of an AccountInput.
 *
 * Nested `accountTxs` / `deltas` are already the Account frame merkle. Re-encoding
 * them here doubled the hub's 100-input R-frame cost (certified semantic hash
 * ~60 times per swap, then the enclosing Entity frame hash).
 *
 * Binding only the claimed `stateHash` is safe because:
 *   1. The proposer wrote `stateHash = createFrameHash(frame)` before signing.
 *   2. `verifyCertifiedEntityOutput` recomputes that merkle before consuming
 *      the certified sequence. Stolen-body substitution used to pass the
 *      output Hanko and then open a dispute; it must fail closed here.
 *   3. `verifySenderFrameHash` recomputes again on inbound apply and peer-rejects
 *      (does not dispute). Mutated bodies never become `currentFrame`.
 *
 * Tempting alternative — omit this projector and keep encoding bodies — fails
 * the 100-input / 100ms SLO: one offer-bearing `frame_ack` is tens of KB of
 * canonical JSON hashed on every envelope, not once.
 * A mutated body with a stolen `stateHash` is transport tampering, not a
 * signed preimage. Treating it as bilateral fraud was the griefing path.
 *
 * What this layer still binds directly:
 *   - routing / kind / disputeConfig (not in the Account merkle)
 *   - envelope Hankos on the Entity frame (certified output omits them: the
 *     same quorum would otherwise sign its own witnesses)
 *   - inbound peer settlement Hankos on the Entity frame (Account merkle
 *     strips quorum-subset bytes; the receiving Entity must commit the exact
 *     peer witness that arrived in this frame)
 *   - local `kind: 'txs'` bodies (no Account frame exists yet)
 */

import type { AccountTx } from '../../../types/account';
import type { EntityTx } from '../../../types/entity-tx';

export type AccountInputCommitmentMode = {
  includeEnvelopeHankos: boolean;
  includeInboundSettlementWitnesses: boolean;
};

export const ENTITY_FRAME_ACCOUNT_INPUT_MODE: AccountInputCommitmentMode = {
  includeEnvelopeHankos: true,
  includeInboundSettlementWitnesses: true,
};

export const CERTIFIED_OUTPUT_ACCOUNT_INPUT_MODE: AccountInputCommitmentMode = {
  includeEnvelopeHankos: false,
  includeInboundSettlementWitnesses: false,
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const requireBytes32 = (value: unknown, code: string): string => {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`${code}:${hash || 'missing'}`);
  return hash;
};

const inboundSettlementWitnesses = (txs: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(txs)) return [];
  const witnesses: Array<Record<string, unknown>> = [];
  for (const raw of txs) {
    const tx = raw as AccountTx;
    if (tx?.type !== 'settle_transition' || tx.data.kind !== 'seal') continue;
    if (!tx.data.settlementHanko && !tx.data.postProof.hanko) continue;
    witnesses.push({
      settlementHash: requireBytes32(tx.data.settlementHash, 'ACCOUNT_FRAME_COMMITMENT_SETTLEMENT_HASH'),
      ...(tx.data.settlementHanko ? { settlementHanko: tx.data.settlementHanko } : {}),
      ...(tx.data.postProof.hanko ? { postProofHanko: tx.data.postProof.hanko } : {}),
    });
  }
  return witnesses;
};

export const canonicalAccountFrameCommitment = (
  value: unknown,
  includeInboundSettlementWitnesses: boolean,
): Record<string, unknown> => {
  const frame = toRecord(value);
  const commitment: Record<string, unknown> = {
    domain: 'xln:account-frame-commitment:v1',
    height: toInt(frame['height']),
    timestamp: toInt(frame['timestamp']),
    jHeight: toInt(frame['jHeight']),
    prevFrameHash: String(frame['prevFrameHash'] ?? '').toLowerCase(),
    byLeft: frame['byLeft'] === true,
    accountStateRoot: requireBytes32(frame['accountStateRoot'], 'ACCOUNT_FRAME_COMMITMENT_STATE_ROOT'),
    stateHash: requireBytes32(frame['stateHash'], 'ACCOUNT_FRAME_COMMITMENT_STATE_HASH'),
  };
  if (includeInboundSettlementWitnesses) {
    const witnesses = inboundSettlementWitnesses(frame['accountTxs']);
    if (witnesses.length > 0) commitment['inboundSettlementWitnesses'] = witnesses;
  }
  return commitment;
};

const projectDisputeSeal = (
  value: unknown,
  includeEnvelopeHankos: boolean,
): Record<string, unknown> => {
  const seal = toRecord(value);
  if (includeEnvelopeHankos) return { ...seal };
  const unsigned = { ...seal };
  delete unsigned['hanko'];
  return unsigned;
};

const projectAck = (
  value: unknown,
  includeEnvelopeHankos: boolean,
): Record<string, unknown> => {
  const ack = toRecord(value);
  const projected: Record<string, unknown> = {
    ...ack,
    height: toInt(ack['height']),
    frameHash: requireBytes32(ack['frameHash'], 'ACCOUNT_ACK_COMMITMENT_FRAME_HASH'),
  };
  if (!includeEnvelopeHankos) delete projected['frameHanko'];
  if (ack['disputeSeal'] !== undefined) {
    projected['disputeSeal'] = projectDisputeSeal(ack['disputeSeal'], includeEnvelopeHankos);
  }
  return projected;
};

const projectProposal = (
  value: unknown,
  mode: AccountInputCommitmentMode,
): Record<string, unknown> => {
  const proposal = toRecord(value);
  const projected: Record<string, unknown> = {
    ...proposal,
    frame: canonicalAccountFrameCommitment(proposal['frame'], mode.includeInboundSettlementWitnesses),
  };
  if (!mode.includeEnvelopeHankos) delete projected['frameHanko'];
  if (proposal['disputeSeal'] !== undefined) {
    projected['disputeSeal'] = projectDisputeSeal(proposal['disputeSeal'], mode.includeEnvelopeHankos);
  }
  return projected;
};

export const canonicalAccountInputCommitment = (
  value: unknown,
  mode: AccountInputCommitmentMode,
): Record<string, unknown> => {
  const data = toRecord(value);
  const projected: Record<string, unknown> = { ...data };
  if (data['proposal'] !== undefined) projected['proposal'] = projectProposal(data['proposal'], mode);
  if (data['ack'] !== undefined) projected['ack'] = projectAck(data['ack'], mode.includeEnvelopeHankos);
  if (data['reseal'] !== undefined) projected['reseal'] = projectAck(data['reseal'], mode.includeEnvelopeHankos);
  if (data['disputeSeal'] !== undefined) {
    projected['disputeSeal'] = projectDisputeSeal(data['disputeSeal'], mode.includeEnvelopeHankos);
  }
  return projected;
};

/** Hub Entity frames carry `consensusOutput` wrappers; project nested Account bodies the same way. */
export const canonicalConsensusOutputForEntityFrameHash = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const entityTxs = Array.isArray(data['entityTxs']) ? data['entityTxs'] : [];
  return {
    ...data,
    entityTxs: entityTxs.map((tx: EntityTx) =>
      tx?.type === 'accountInput'
        ? { type: tx.type, data: canonicalAccountInputCommitment(tx.data, ENTITY_FRAME_ACCOUNT_INPUT_MODE) }
        : tx,
    ),
  };
};
