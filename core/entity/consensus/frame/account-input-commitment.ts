/**
 * Entity-layer digest of an AccountInput.
 *
 * Nested `accountTxs` / `deltas` are already committed by the Account frame
 * merkle. Re-encoding them here makes Entity hashing proportional to the full
 * Account body for no additional authority.
 *
 * Binding only the claimed `stateHash` is safe because:
 *   1. The proposer wrote `stateHash = createFrameHash(frame)` before signing.
 *   2. `verifySenderFrameHash` recomputes it on inbound apply and peer-rejects
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
 *   - envelope Account Hankos on the target Entity frame
 *   - inbound peer settlement Hankos on the Entity frame (Account merkle
 *     strips quorum-subset bytes; the receiving Entity must commit the exact
 *     peer witness that arrived in this frame)
 *   - local `kind: 'txs'` bodies (no Account frame exists yet)
 */

import type { AccountTx } from '../../../types/account';

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

const canonicalAccountFrameCommitment = (
  value: unknown,
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
  const witnesses = inboundSettlementWitnesses(frame['accountTxs']);
  if (witnesses.length > 0) commitment['inboundSettlementWitnesses'] = witnesses;
  return commitment;
};

const projectAck = (value: unknown): Record<string, unknown> => {
  const ack = toRecord(value);
  return {
    ...ack,
    height: toInt(ack['height']),
    frameHash: requireBytes32(ack['frameHash'], 'ACCOUNT_ACK_COMMITMENT_FRAME_HASH'),
  };
};

const projectProposal = (value: unknown): Record<string, unknown> => {
  const proposal = toRecord(value);
  return {
    ...proposal,
    frame: canonicalAccountFrameCommitment(proposal['frame']),
  };
};

export const canonicalAccountInputCommitment = (value: unknown): Record<string, unknown> => {
  const data = toRecord(value);
  const projected: Record<string, unknown> = { ...data };
  if (data['proposal'] !== undefined) projected['proposal'] = projectProposal(data['proposal']);
  if (data['ack'] !== undefined) projected['ack'] = projectAck(data['ack']);
  if (data['reseal'] !== undefined) projected['reseal'] = projectAck(data['reseal']);
  return projected;
};
