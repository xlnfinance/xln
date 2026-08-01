import { ethers } from 'ethers';

import { validateSwapHistoryMap } from '../account/swap-history-validation';
import { LIMITS } from '../config/constants';
import type { AccountFrame } from '../types/account';
import { validateStoredCrossJurisdictionRoute } from './account-doc-cross-j-validation';
import { validateStoredDisputeEvidence } from './account-doc-evidence-validation';
import {
  boundedArray,
  bytes,
  flag,
  hex,
  shape,
  text,
  uint,
} from './account-doc-validation-primitives';
import {
  validateStoredActiveDispute,
  validateStoredLastOutboundFrameAck,
  validateStoredPendingAccountInput,
  validateStoredPendingForwards,
} from './account-doc-replica-validation';

/**
 * Optional-field audit ledger:
 * - Structured consumers are exact-decoded below or delegated to the canonical
 *   Account input, swap-history, cross-j, ABI, and contract-limit validators.
 * - Hanko strings are opaque signatures; hash and nonce scalars are format-only.
 *   No storage-only lifecycle coupling is imposed on partially built drafts.
 */

const BOARD_RESEAL_REASONS = new Set([
  'pending',
  'account-identity-invalid',
  'bilateral-frame-uncertified',
  'certified-frame-invalid',
  'bilateral-dispute-uncertified',
  'certified-dispute-invalid',
  'output-route-unavailable',
]);

const stringValue = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const validateAbiProofBody = (account: Record<string, unknown>, code: string): void => {
  if (account['abiProofBody'] === undefined) return;
  const proof = shape(
    account['abiProofBody'],
    ['encodedProofBody', 'proofBodyHash', 'lastUpdatedHeight'],
    [],
    code,
  );
  const encoded = hex(proof['encodedProofBody'], `${code}_ENCODED`);
  const claimed = bytes(proof['proofBodyHash'], 32, `${code}_HASH`);
  if (ethers.keccak256(encoded) !== claimed) throw new Error(`${code}_HASH_MISMATCH`);
  uint(proof['lastUpdatedHeight'], `${code}_HEIGHT`);
};

const validateBoardReseals = (account: Record<string, unknown>, code: string): void => {
  if (account['boardResealMigration'] !== undefined) {
    const marker = shape(
      account['boardResealMigration'],
      ['activationJHeight', 'activationLogIndex', 'reason'],
      [],
      `${code}_MIGRATION`,
    );
    uint(marker['activationJHeight'], `${code}_MIGRATION_HEIGHT`);
    uint(marker['activationLogIndex'], `${code}_MIGRATION_INDEX`);
    if (!BOARD_RESEAL_REASONS.has(String(marker['reason']))) throw new Error(`${code}_MIGRATION_REASON`);
  }
  if (account['counterpartyBoardReseal'] !== undefined) {
    const marker = shape(
      account['counterpartyBoardReseal'],
      ['activationJHeight', 'activationLogIndex', 'frameHeight', 'frameHash'],
      [],
      `${code}_COUNTERPARTY`,
    );
    uint(marker['activationJHeight'], `${code}_COUNTERPARTY_HEIGHT`);
    uint(marker['activationLogIndex'], `${code}_COUNTERPARTY_INDEX`);
    uint(marker['frameHeight'], `${code}_COUNTERPARTY_FRAME_HEIGHT`);
    bytes(marker['frameHash'], 32, `${code}_COUNTERPARTY_FRAME_HASH`);
  }
};

const validateDisputeScalars = (account: Record<string, unknown>, code: string): void => {
  for (const field of [
    'hankoSignature',
    'currentFrameHanko',
    'counterpartyFrameHanko',
    'currentDisputeProofHanko',
    'counterpartyDisputeProofHanko',
    'counterpartySettlementHanko',
  ]) {
    if (account[field] !== undefined) text(account[field], `${code}_${field}`);
  }
  if (account['lastRollbackFrameHash'] !== undefined) {
    bytes(account['lastRollbackFrameHash'], 32, `${code}_ROLLBACK_HASH`);
  }
  for (const field of ['currentDisputeProofNonce', 'counterpartyDisputeProofNonce']) {
    if (account[field] !== undefined) uint(account[field], `${code}_${field}`);
  }
  for (const field of [
    'currentDisputeProofBodyHash',
    'currentDisputeHash',
    'counterpartyDisputeProofBodyHash',
    'counterpartyDisputeHash',
  ]) {
    if (account[field] !== undefined) bytes(account[field], 32, `${code}_${field}`);
  }
};

const validateDisputePrepare = (account: Record<string, unknown>, code: string): void => {
  if (account['disputePrepare'] === undefined) return;
  const prepare = shape(
    account['disputePrepare'],
    ['startedAt', 'readyAfter', 'reason'],
    ['pendingOrderbookRemovalIds', 'startIntent'],
    code,
  );
  uint(prepare['startedAt'], `${code}_STARTED`);
  uint(prepare['readyAfter'], `${code}_READY`);
  text(prepare['reason'], `${code}_REASON`);
  if (prepare['pendingOrderbookRemovalIds'] !== undefined) {
    boundedArray(
      prepare['pendingOrderbookRemovalIds'],
      LIMITS.MAX_FRAME_SIZE_BYTES,
      `${code}_REMOVALS`,
    ).forEach((id, index) => text(id, `${code}_REMOVAL_${index}`));
  }
  if (prepare['startIntent'] !== undefined) {
    const intent = shape(
      prepare['startIntent'],
      [],
      [
        'crossJurisdictionRouteId',
        'starterInitialArguments',
        'description',
        'allowUnsafeCrossJTargetDispute',
        'acceptedCrossJTargetLossAmount',
      ],
      `${code}_INTENT`,
    );
    for (const field of ['crossJurisdictionRouteId', 'starterInitialArguments', 'description']) {
      if (intent[field] !== undefined) stringValue(intent[field], `${code}_INTENT_${field}`);
    }
    if (intent['allowUnsafeCrossJTargetDispute'] !== undefined) {
      flag(intent['allowUnsafeCrossJTargetDispute'], `${code}_INTENT_UNSAFE`);
    }
    if (
      intent['acceptedCrossJTargetLossAmount'] !== undefined
      && typeof intent['acceptedCrossJTargetLossAmount'] !== 'bigint'
    ) throw new Error(`${code}_INTENT_LOSS`);
  }
};

const validateSwapHistories = (account: Record<string, unknown>, code: string): void => {
  const entries = [
    ['swapOrderHistory', LIMITS.MAX_ACCOUNT_SWAP_OFFERS + LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY, 'ACCOUNT_SWAP_HISTORY_LIMIT_EXCEEDED'],
    ['swapClosedOrders', LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY, 'ACCOUNT_TERMINAL_SWAP_HISTORY_LIMIT_EXCEEDED'],
  ] as const;
  for (const [field, maximum, limitCode] of entries) {
    if (account[field] === undefined) continue;
    const history = validateSwapHistoryMap(account[field], `${code}_${field}`, maximum, limitCode);
    for (const [offerId, entry] of history) {
      if (entry.crossJurisdiction !== undefined) {
        validateStoredCrossJurisdictionRoute(entry.crossJurisdiction, `${code}_${field}_${offerId}_CROSS_J`);
      }
    }
  }
};

/** Exhaustive validation owner for all 27 persisted AccountReplica optional fields. */
export const validateStoredAccountReplicaOptionals = (
  account: Record<string, unknown>,
  proofHeader: { fromEntity: string; toEntity: string },
  currentFrame: AccountFrame,
  stateJNonce: number,
  code: string,
): void => {
  validateStoredPendingAccountInput(account, `${code}_PENDING_INPUT`);
  validateStoredLastOutboundFrameAck(account, proofHeader, currentFrame, `${code}_LAST_OUTBOUND_ACK`);
  validateStoredPendingForwards(account, proofHeader.fromEntity, proofHeader.toEntity, `${code}_FORWARDS`);
  validateStoredActiveDispute(account, stateJNonce, `${code}_ACTIVE_DISPUTE`);
  validateAbiProofBody(account, `${code}_ABI_PROOF`);
  validateBoardReseals(account, `${code}_BOARD_RESEAL`);
  validateDisputeScalars(account, `${code}_SCALAR`);
  validateStoredDisputeEvidence(account, `${code}_EVIDENCE`);
  validateDisputePrepare(account, `${code}_DISPUTE_PREPARE`);
  validateSwapHistories(account, `${code}_SWAP_HISTORY`);
};
