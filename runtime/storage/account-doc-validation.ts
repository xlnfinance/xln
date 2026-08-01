import { validateRebalanceFeePolicies } from '../account/rebalance-validation';
import { assertCanonicalSettlementWorkspace } from '../account/tx/handlers/settle-transition';
import { FINANCIAL, LIMITS, UINT16_MAX } from '../config/constants';
import { assertExactMultiRecipientCiphertextSchema } from '../protocol/htlc/multi-recipient-schema';
import { compileOps } from '../protocol/settlement/operations';
import { safeStringify } from '../protocol/serialization';
import type { AccountState, SettlementDiff, SettlementOp } from '../types/account';
import { requireBoundaryRecord } from './schema-primitives';
import {
  assertStoredCrossJurisdictionOfferBinding,
  validateStoredCrossJurisdictionPullBinding,
  validateStoredCrossJurisdictionRoute,
} from './account-doc-cross-j-validation';
import { validateStoredAccountReplicaOptionals } from './account-doc-optional-validation';
import {
  UINT256_MAX,
  boundedArray,
  boundedMap,
  bytes,
  flag,
  int256,
  integer,
  shape,
  text,
  token,
  uint,
  uint256,
  validateDelta,
  validateFrame,
} from './account-doc-validation-primitives';

const validateCoreState = (state: Record<string, unknown>, code: string): void => {
  bytes(state['leftEntity'], 32, `${code}_LEFT`);
  bytes(state['rightEntity'], 32, `${code}_RIGHT`);
  const domain = shape(state['domain'], ['chainId', 'depositoryAddress'], [], `${code}_DOMAIN`);
  uint(domain['chainId'], `${code}_CHAIN`, Number.MAX_SAFE_INTEGER);
  if (domain['chainId'] === 0) throw new Error(`${code}_CHAIN_ZERO`);
  bytes(domain['depositoryAddress'], 20, `${code}_DEPOSITORY`);
  bytes(state['watchSeed'], 32, `${code}_WATCH_SEED`);
  const deltas = boundedMap(state['deltas'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_DELTAS`);
  for (const [key, raw] of deltas) {
    const tokenId = token(key, `${code}_DELTA_KEY`);
    if (validateDelta(raw, `${code}_DELTA_${tokenId}`).tokenId !== tokenId) throw new Error(`${code}_DELTA_KEY_MISMATCH`);
  }
  const credit = shape(state['globalCreditLimits'], ['ownLimit', 'peerLimit'], [], `${code}_CREDIT`);
  uint256(credit['ownLimit'], `${code}_OWN_LIMIT`);
  uint256(credit['peerLimit'], `${code}_PEER_LIMIT`);
  const dispute = shape(state['disputeConfig'], ['leftDisputeDelay', 'rightDisputeDelay'], [], `${code}_DISPUTE`);
  uint(dispute['leftDisputeDelay'], `${code}_LEFT_DELAY`, UINT16_MAX);
  uint(dispute['rightDisputeDelay'], `${code}_RIGHT_DELAY`, UINT16_MAX);
  uint(state['lastFinalizedJHeight'], `${code}_FINALIZED_J`);
  uint(state['jNonce'], `${code}_J_NONCE`);
  for (const side of ['leftPendingJClaims', 'rightPendingJClaims']) {
    const accumulator = shape(state[side], ['version', 'root', 'count'], [], `${code}_${side}`);
    if (accumulator['version'] !== 1) throw new Error(`${code}_${side}_VERSION`);
    bytes(accumulator['root'], 32, `${code}_${side}_ROOT`);
    integer(accumulator['count'], 0n, (1n << 64n) - 1n, `${code}_${side}_COUNT`);
  }
  for (const [key, amount] of boundedMap(state['requestedRebalance'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_REBALANCE`)) {
    token(key, `${code}_REBALANCE_KEY`);
    uint256(amount, `${code}_REBALANCE_AMOUNT`);
  }
  for (const [key, raw] of boundedMap(state['requestedRebalanceFeeState'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_FEES`)) {
    token(key, `${code}_FEE_KEY`);
    const fee = shape(raw, ['requestId', 'feeTokenId', 'feePaidUpfront', 'requestedAmount', 'policyVersion', 'requestedAt', 'requestedByLeft'], ['refund'], `${code}_FEE`);
    text(fee['requestId'], `${code}_REQUEST_ID`);
    token(fee['feeTokenId'], `${code}_FEE_TOKEN`);
    uint256(fee['feePaidUpfront'], `${code}_FEE_PAID`);
    uint256(fee['requestedAmount'], `${code}_REQUESTED_AMOUNT`);
    uint(fee['policyVersion'], `${code}_POLICY_VERSION`);
    uint(fee['requestedAt'], `${code}_REQUESTED_AT`);
    flag(fee['requestedByLeft'], `${code}_REQUESTED_SIDE`);
    if (fee['refund'] !== undefined) {
      const refund = shape(fee['refund'], ['reason', 'refundedAmount'], [], `${code}_REFUND`);
      if (!['policy_mismatch', 'timeout', 'fee_too_low', 'manual'].includes(String(refund['reason']))) throw new Error(`${code}_REFUND_REASON`);
      uint256(refund['refundedAmount'], `${code}_REFUND_AMOUNT`);
    }
  }
  if (state['rebalanceFeePolicies'] !== undefined) {
    boundedMap(state['rebalanceFeePolicies'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_POLICIES`);
    validateRebalanceFeePolicies(state['rebalanceFeePolicies'], `${code}_POLICIES`);
  }
};

const validateStateMaps = (state: Record<string, unknown>, code: string): void => {
  for (const [key, raw] of boundedMap(state['locks'], LIMITS.MAX_ACCOUNT_HTLC_LOCKS, `${code}_LOCKS`)) {
    const lock = shape(raw, ['lockId', 'hashlock', 'timelock', 'revealBeforeHeight', 'amount', 'tokenId', 'senderIsLeft', 'createdHeight', 'createdTimestamp'], ['envelopeHash', 'secretOffer'], `${code}_LOCK`);
    if (text(lock['lockId'], `${code}_LOCK_ID`) !== key) throw new Error(`${code}_LOCK_KEY`);
    text(lock['hashlock'], `${code}_HASHLOCK`);
    uint256(lock['timelock'], `${code}_TIMELOCK`);
    uint(lock['revealBeforeHeight'], `${code}_REVEAL_HEIGHT`);
    integer(lock['amount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_LOCK_AMOUNT`);
    token(lock['tokenId'], `${code}_LOCK_TOKEN`);
    flag(lock['senderIsLeft'], `${code}_LOCK_SIDE`);
    uint(lock['createdHeight'], `${code}_LOCK_HEIGHT`);
    uint(lock['createdTimestamp'], `${code}_LOCK_TIME`);
    if (lock['envelopeHash'] !== undefined) bytes(lock['envelopeHash'], 32, `${code}_ENVELOPE`);
    if (lock['secretOffer'] !== undefined) assertExactMultiRecipientCiphertextSchema(lock['secretOffer']);
  }
  const pulls = boundedMap(state['pulls'] ?? new Map(), LIMITS.MAX_ACCOUNT_SWAP_OFFERS, `${code}_PULLS`);
  for (const [key, raw] of pulls) {
    const pull = shape(raw, ['pullId', 'tokenId', 'amount', 'revealedUntilTimestamp', 'fullHash', 'partialRoot', 'createdHeight', 'createdTimestamp'], ['claimedRatio', 'claimedAmount', 'crossJurisdiction'], `${code}_PULL`);
    if (text(pull['pullId'], `${code}_PULL_ID`) !== key || String(key).includes(':')) throw new Error(`${code}_PULL_KEY`);
    token(pull['tokenId'], `${code}_PULL_TOKEN`);
    if (integer(pull['amount'], -FINANCIAL.MAX_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_PULL_AMOUNT`) === 0n) throw new Error(`${code}_PULL_ZERO`);
    uint(pull['revealedUntilTimestamp'], `${code}_PULL_DEADLINE`);
    bytes(pull['fullHash'], 32, `${code}_PULL_FULL_HASH`);
    bytes(pull['partialRoot'], 32, `${code}_PULL_ROOT`);
    uint(pull['createdHeight'], `${code}_PULL_HEIGHT`);
    uint(pull['createdTimestamp'], `${code}_PULL_TIME`);
    if (pull['claimedRatio'] !== undefined) uint(pull['claimedRatio'], `${code}_PULL_RATIO`, UINT16_MAX);
    if (pull['claimedAmount'] !== undefined) uint256(pull['claimedAmount'], `${code}_PULL_CLAIMED`);
    if (pull['crossJurisdiction'] !== undefined) validateStoredCrossJurisdictionPullBinding(pull['crossJurisdiction'], `${code}_PULL_CROSS_J`);
  }
  for (const [key, raw] of boundedMap(state['swapOffers'], LIMITS.MAX_ACCOUNT_SWAP_OFFERS, `${code}_OFFERS`)) {
    const offer = shape(raw, ['offerId', 'giveTokenId', 'giveAmount', 'wantTokenId', 'wantAmount', 'makerIsLeft', 'createdHeight'], ['priceTicks', 'timeInForce', 'quantizedGive', 'quantizedWant', 'crossJurisdiction'], `${code}_OFFER`);
    if (text(offer['offerId'], `${code}_OFFER_ID`) !== key || String(key).includes(':')) throw new Error(`${code}_OFFER_KEY`);
    token(offer['giveTokenId'], `${code}_GIVE_TOKEN`); token(offer['wantTokenId'], `${code}_WANT_TOKEN`);
    integer(offer['giveAmount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_GIVE`);
    integer(offer['wantAmount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_WANT`);
    flag(offer['makerIsLeft'], `${code}_MAKER`); uint(offer['createdHeight'], `${code}_OFFER_HEIGHT`);
    if (offer['priceTicks'] !== undefined) integer(offer['priceTicks'], 1n, UINT256_MAX, `${code}_PRICE`);
    if (offer['timeInForce'] !== undefined) uint(offer['timeInForce'], `${code}_TIF`, 2);
    if ((offer['quantizedGive'] === undefined) !== (offer['quantizedWant'] === undefined)) throw new Error(`${code}_QUANT_PAIR`);
    if (offer['quantizedGive'] !== undefined && integer(offer['quantizedGive'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_QUANT_GIVE`) !== offer['giveAmount']) throw new Error(`${code}_QUANT_GIVE_MISMATCH`);
    if (offer['quantizedWant'] !== undefined && integer(offer['quantizedWant'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_QUANT_WANT`) !== offer['wantAmount']) throw new Error(`${code}_QUANT_WANT_MISMATCH`);
    if (offer['crossJurisdiction'] !== undefined) {
      const route = validateStoredCrossJurisdictionRoute(offer['crossJurisdiction'], `${code}_OFFER_CROSS_J`);
      assertStoredCrossJurisdictionOfferBinding(
        route, offer, pulls, String(state['leftEntity']), String(state['rightEntity']),
        `${code}_OFFER_CROSS_J`,
      );
    }
  }
  const deltaCount = (state['deltas'] as Map<unknown, unknown>).size;
  for (const [key, raw] of boundedMap(state['subcontracts'] ?? new Map(), 32, `${code}_SUBCONTRACTS`)) {
    text(key, `${code}_SUBCONTRACT_KEY`);
    const subcontract = shape(raw, ['transformerAddress', 'encodedBatch', 'allowances'], ['leftArgumentsHash', 'rightArgumentsHash'], `${code}_SUBCONTRACT`);
    bytes(subcontract['transformerAddress'], 20, `${code}_TRANSFORMER`);
    if (typeof subcontract['encodedBatch'] !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(subcontract['encodedBatch'])) throw new Error(`${code}_BATCH`);
    let previous = -1;
    for (const allowanceRaw of boundedArray(subcontract['allowances'], deltaCount, `${code}_ALLOWANCES`)) {
      const allowance = shape(allowanceRaw, ['deltaIndex', 'rightAllowance', 'leftAllowance'], [], `${code}_ALLOWANCE`);
      const index = uint(allowance['deltaIndex'], `${code}_DELTA_INDEX`);
      if (index >= deltaCount || index <= previous) throw new Error(`${code}_ALLOWANCE_ORDER`);
      previous = index; uint256(allowance['rightAllowance'], `${code}_RIGHT_ALLOWANCE`); uint256(allowance['leftAllowance'], `${code}_LEFT_ALLOWANCE`);
    }
    if (subcontract['leftArgumentsHash'] !== undefined) bytes(subcontract['leftArgumentsHash'], 32, `${code}_LEFT_ARGS`);
    if (subcontract['rightArgumentsHash'] !== undefined) bytes(subcontract['rightArgumentsHash'], 32, `${code}_RIGHT_ARGS`);
  }
};

const validateSettlement = (state: Record<string, unknown>, code: string): void => {
  if (state['settlementWorkspace'] === undefined) return;
  const workspace = shape(state['settlementWorkspace'], ['workspaceHash', 'ops', 'lastModifiedByLeft', 'status', 'revision', 'createdAt', 'lastUpdatedAt', 'executorIsLeft'], ['compiledDiffs', 'compiledForgiveTokenIds', 'leftHanko', 'rightHanko', 'settlementHash', 'memo', 'nonceAtSign', 'postSettlementDisputeProof'], `${code}_WORKSPACE`);
  bytes(workspace['workspaceHash'], 32, `${code}_WORKSPACE_HASH`);
  const ops = boundedArray(workspace['ops'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_OPS`).map((raw, index) => {
    const source = requireBoundaryRecord(raw, `${code}_OP_${index}`);
    const type = source['type'];
    const required = type === 'forgive' ? ['type', 'tokenId'] : type === 'rawDiff'
      ? ['type', 'tokenId', 'leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff']
      : ['type', 'tokenId', 'amount'];
    const op = shape<SettlementOp & Record<string, unknown>>(source, required, [], `${code}_OP_${index}`);
    token(op['tokenId'], `${code}_OP_TOKEN`);
    if (['r2c', 'c2r', 'r2r'].includes(String(type))) integer(op['amount'], 1n, UINT256_MAX, `${code}_OP_AMOUNT`);
    else if (type === 'rawDiff') for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff']) int256(op[field], `${code}_OP_${field}`);
    else if (type !== 'forgive') throw new Error(`${code}_OP_TYPE`);
    return op;
  });
  if (ops.length === 0) throw new Error(`${code}_OPS_EMPTY`);
  flag(workspace['lastModifiedByLeft'], `${code}_MODIFIER`); flag(workspace['executorIsLeft'], `${code}_EXECUTOR`);
  if (!['draft', 'awaiting_counterparty', 'ready_to_submit', 'submitted'].includes(String(workspace['status']))) throw new Error(`${code}_STATUS`);
  if (uint(workspace['revision'], `${code}_REVISION`) === 0) throw new Error(`${code}_REVISION_ZERO`);
  uint(workspace['createdAt'], `${code}_CREATED`); uint(workspace['lastUpdatedAt'], `${code}_UPDATED`);
  const compiled = compileOps(ops, workspace['lastModifiedByLeft'] as boolean);
  if (workspace['compiledDiffs'] !== undefined) {
    const diffs = boundedArray(workspace['compiledDiffs'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_DIFFS`).map((raw, index) => {
      const diff = shape<SettlementDiff & Record<string, unknown>>(raw, ['tokenId', 'leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff'], [], `${code}_DIFF_${index}`);
      token(diff['tokenId'], `${code}_DIFF_TOKEN`); for (const field of ['leftDiff', 'rightDiff', 'collateralDiff', 'ondeltaDiff']) int256(diff[field], `${code}_DIFF_${field}`);
      return diff;
    });
    if (safeStringify(diffs) !== safeStringify(compiled.diffs)) throw new Error(`${code}_DIFF_MISMATCH`);
  }
  if (workspace['compiledForgiveTokenIds'] !== undefined) {
    const ids = boundedArray(workspace['compiledForgiveTokenIds'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_FORGIVE`).map(id => token(id, `${code}_FORGIVE_TOKEN`));
    if (safeStringify(ids) !== safeStringify(compiled.forgiveTokenIds)) throw new Error(`${code}_FORGIVE_MISMATCH`);
  }
  assertCanonicalSettlementWorkspace({
    leftEntity: bytes(state['leftEntity'], 32, `${code}_LEFT`),
    rightEntity: bytes(state['rightEntity'], 32, `${code}_RIGHT`),
  }, { ...workspace, ops } as NonNullable<AccountState['settlementWorkspace']>);
};

const validateReplicaEnvelope = (account: Record<string, unknown>, code: string): void => {
  const header = shape(account['proofHeader'], ['fromEntity', 'toEntity', 'nextProofNonce'], [], `${code}_PROOF_HEADER`);
  const from = bytes(header['fromEntity'], 32, `${code}_PROOF_FROM`);
  const to = bytes(header['toEntity'], 32, `${code}_PROOF_TO`);
  if (from === to) throw new Error(`${code}_PROOF_SELF`);
  uint(header['nextProofNonce'], `${code}_PROOF_NONCE`);
  const body = shape(account['proofBody'], ['tokenIds', 'deltas'], ['htlcLocks'], `${code}_PROOF_BODY`);
  const ids = boundedArray(body['tokenIds'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_PROOF_TOKENS`).map((id, index) => token(id, `${code}_PROOF_TOKEN_${index}`));
  const deltas = boundedArray(body['deltas'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_PROOF_DELTAS`);
  if (ids.length !== deltas.length) throw new Error(`${code}_PROOF_LENGTH`);
  ids.forEach((id, index) => { if (index > 0 && id <= ids[index - 1]!) throw new Error(`${code}_PROOF_ORDER`); int256(deltas[index], `${code}_PROOF_DELTA`); });
  for (const raw of boundedArray(body['htlcLocks'] ?? [], LIMITS.MAX_ACCOUNT_HTLC_LOCKS, `${code}_PROOF_LOCKS`)) {
    const lock = shape(raw, ['deltaIndex', 'amount', 'revealedUntilTimestamp', 'hash'], [], `${code}_PROOF_LOCK`);
    if (uint(lock['deltaIndex'], `${code}_PROOF_LOCK_INDEX`) >= ids.length) throw new Error(`${code}_PROOF_LOCK_RANGE`);
    uint256(lock['amount'], `${code}_PROOF_LOCK_AMOUNT`);
    uint(lock['revealedUntilTimestamp'], `${code}_PROOF_LOCK_TIME`);
    bytes(lock['hash'], 32, `${code}_PROOF_LOCK_HASH`);
  }
  for (const [key, raw] of boundedMap(account['pendingWithdrawals'], LIMITS.ACCOUNT_MEMPOOL_SIZE, `${code}_WITHDRAWALS`)) {
    const withdrawal = shape(raw, ['requestId', 'tokenId', 'amount', 'requestedAt', 'direction', 'status'], ['signature'], `${code}_WITHDRAWAL`);
    if (text(withdrawal['requestId'], `${code}_WITHDRAWAL_ID`) !== key) throw new Error(`${code}_WITHDRAWAL_KEY`);
    token(withdrawal['tokenId'], `${code}_WITHDRAWAL_TOKEN`); integer(withdrawal['amount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_WITHDRAWAL_AMOUNT`); uint(withdrawal['requestedAt'], `${code}_WITHDRAWAL_TIME`);
    if (!['outgoing', 'incoming'].includes(String(withdrawal['direction']))) throw new Error(`${code}_WITHDRAWAL_DIRECTION`);
    if (!['pending', 'approved', 'rejected', 'timed_out'].includes(String(withdrawal['status']))) throw new Error(`${code}_WITHDRAWAL_STATUS`);
    if (withdrawal['signature'] !== undefined) text(withdrawal['signature'], `${code}_WITHDRAWAL_SIGNATURE`, 1_000_000);
  }
  boundedArray(account['pendingSignatures'], LIMITS.ACCOUNT_MEMPOOL_SIZE, `${code}_SIGNATURES`)
    .forEach(signature => text(signature, `${code}_SIGNATURE`, 1_000_000));
  const shadow = shape(account['shadow'], ['rebalance'], ['rejectedFrameEvidence'], `${code}_SHADOW`);
  const rebalance = shape(shadow['rebalance'], ['policy', 'submittedAtByToken'], ['activeQuote', 'pendingRequest'], `${code}_SHADOW_REBALANCE`);
  for (const [key, raw] of boundedMap(rebalance['policy'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_SHADOW_POLICY`)) {
    token(key, `${code}_SHADOW_POLICY_KEY`);
    const policy = shape(raw, ['r2cRequestSoftLimit', 'hardLimit', 'maxAcceptableFee'], ['setByLeft'], `${code}_SHADOW_POLICY_ROW`);
    const softLimit = uint256(policy['r2cRequestSoftLimit'], `${code}_SHADOW_SOFT`);
    const hardLimit = uint256(policy['hardLimit'], `${code}_SHADOW_HARD`);
    if (hardLimit < softLimit) throw new Error(`${code}_SHADOW_LIMIT_ORDER`);
    uint256(policy['maxAcceptableFee'], `${code}_SHADOW_MAX_FEE`);
    if (policy['setByLeft'] !== undefined) flag(policy['setByLeft'], `${code}_SHADOW_POLICY_SIDE`);
  }
  for (const [key, timestamp] of boundedMap(rebalance['submittedAtByToken'], LIMITS.MAX_ACCOUNT_TOKEN_ROWS, `${code}_SHADOW_SUBMITTED`)) {
    token(key, `${code}_SHADOW_SUBMITTED_KEY`); uint(timestamp, `${code}_SHADOW_SUBMITTED_TIME`);
  }
  if (rebalance['activeQuote'] !== undefined) {
    const quote = shape(rebalance['activeQuote'], ['quoteId', 'tokenId', 'amount', 'feeTokenId', 'feeAmount', 'accepted'], [], `${code}_SHADOW_QUOTE`);
    uint(quote['quoteId'], `${code}_QUOTE_ID`); token(quote['tokenId'], `${code}_QUOTE_TOKEN`); uint256(quote['amount'], `${code}_QUOTE_AMOUNT`);
    token(quote['feeTokenId'], `${code}_QUOTE_FEE_TOKEN`); uint256(quote['feeAmount'], `${code}_QUOTE_FEE`); flag(quote['accepted'], `${code}_QUOTE_ACCEPTED`);
  }
  if (rebalance['pendingRequest'] !== undefined) {
    const request = shape(rebalance['pendingRequest'], ['tokenId', 'targetAmount'], [], `${code}_SHADOW_REQUEST`);
    token(request['tokenId'], `${code}_SHADOW_REQUEST_TOKEN`); uint256(request['targetAmount'], `${code}_SHADOW_REQUEST_AMOUNT`);
  }
  const currentHeight = uint(account['currentHeight'], `${code}_CURRENT_HEIGHT`);
  uint(account['rollbackCount'], `${code}_ROLLBACKS`);
  const current = validateFrame(account['currentFrame'], `${code}_CURRENT_FRAME`);
  if (current.height !== currentHeight) throw new Error(`${code}_CURRENT_FRAME_HEIGHT`);
  validateStoredAccountReplicaOptionals(
    account,
    { fromEntity: from, toEntity: to },
    current,
    uint(requireBoundaryRecord(account['state'], `${code}_STATE`)['jNonce'], `${code}_STATE_J_NONCE`),
    `${code}_OPTIONAL`,
  );
  if (account['pendingFrame'] !== undefined) {
    const pending = validateFrame(account['pendingFrame'], `${code}_PENDING_FRAME`);
    if (pending.height !== currentHeight + 1) throw new Error(`${code}_PENDING_HEIGHT`);
    const previous = currentHeight === 0 ? 'genesis' : current.stateHash;
    if (pending.prevFrameHash !== previous) throw new Error(`${code}_PENDING_LINK`);
  }
};

/** Strict, non-mutating persisted semantics that must run before legacy decoders. */
export const assertStorageAccountDocSemantics = (account: Record<string, unknown>, code: string): void => {
  const state = requireBoundaryRecord(account['state'], `${code}_STATE`);
  validateCoreState(state, `${code}_STATE`);
  validateStateMaps(state, `${code}_STATE`);
  validateSettlement(state, `${code}_STATE`);
  validateReplicaEnvelope(account, code);
};
