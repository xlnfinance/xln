import { decodeAccountPeerInput } from '../account/input-validation';
import { sameAccountStateDomain } from '../account/state-root';
import { FINANCIAL, LIMITS } from '../config/constants';
import type { AccountFrame, AccountState } from '../types/account';
import {
  boundedArray,
  bytes,
  flag,
  hex,
  integer,
  shape,
  text,
  token,
  uint,
  validateFrame,
} from './account-doc-validation-primitives';
import { requireBoundaryRecord } from './schema-primitives';

export const validateStoredPendingForwards = (
  account: Record<string, unknown>,
  fromEntity: string,
  toEntity: string,
  code: string,
): void => {
  if (account['pendingForwards'] === undefined) return;
  for (const [index, raw] of boundedArray(account['pendingForwards'], LIMITS.ACCOUNT_MEMPOOL_SIZE, code).entries()) {
    const itemCode = `${code}_${index}`;
    const forward = shape(raw, ['tokenId', 'amount', 'route'], ['description', 'deliveryMode', 'trustedGatewayEntityId'], itemCode);
    token(forward['tokenId'], `${itemCode}_TOKEN`);
    integer(forward['amount'], FINANCIAL.MIN_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT, `${itemCode}_AMOUNT`);
    const route = boundedArray(forward['route'], FINANCIAL.MAX_ROUTE_HOPS, `${itemCode}_ROUTE`)
      .map((entityId, routeIndex) => bytes(entityId, 32, `${itemCode}_ROUTE_${routeIndex}`));
    if (route.length < 2 || route[0] !== fromEntity || route[1] === toEntity) throw new Error(`${itemCode}_ROUTE_CONTINUATION`);
    if (forward['description'] !== undefined) text(forward['description'], `${itemCode}_DESCRIPTION`);
    if (forward['deliveryMode'] !== undefined && forward['deliveryMode'] !== 'trusted') throw new Error(`${itemCode}_DELIVERY_MODE`);
    const gateway = forward['trustedGatewayEntityId'];
    if ((forward['deliveryMode'] === 'trusted') !== (gateway !== undefined)) throw new Error(`${itemCode}_GATEWAY_PAIR`);
    if (gateway !== undefined && (bytes(gateway, 32, `${itemCode}_GATEWAY`) !== route.at(-2) || route.length < 2)) throw new Error(`${itemCode}_GATEWAY_ROUTE`);
  }
};

export const validateStoredActiveDispute = (
  account: Record<string, unknown>,
  stateJNonce: number,
  code: string,
): void => {
  if (account['activeDispute'] === undefined) return;
  const dispute = shape(account['activeDispute'], [
    'startedByLeft', 'initialProofbodyHash', 'initialNonce', 'disputeTimeout',
    'jNonce', 'starterInitialArguments', 'starterIncrementedArguments',
  ], ['observedOnChain', 'observedBlockNumber', 'batchNonce', 'finalizeQueued'], code);
  flag(dispute['startedByLeft'], `${code}_STARTER`);
  bytes(dispute['initialProofbodyHash'], 32, `${code}_PROOF_HASH`);
  uint(dispute['initialNonce'], `${code}_INITIAL_NONCE`);
  const timeout = uint(dispute['disputeTimeout'], `${code}_TIMEOUT`);
  const jNonce = uint(dispute['jNonce'], `${code}_J_NONCE`);
  if (jNonce > stateJNonce) throw new Error(`${code}_J_NONCE_FUTURE`);
  hex(dispute['starterInitialArguments'], `${code}_INITIAL_ARGS`);
  hex(dispute['starterIncrementedArguments'], `${code}_INCREMENTED_ARGS`);
  if (dispute['observedOnChain'] !== undefined) flag(dispute['observedOnChain'], `${code}_OBSERVED`);
  if (dispute['finalizeQueued'] !== undefined) flag(dispute['finalizeQueued'], `${code}_FINALIZE_QUEUED`);
  const observed = dispute['observedOnChain'] === true;
  const observedBlock = dispute['observedBlockNumber'];
  if (observed !== (observedBlock !== undefined)) throw new Error(`${code}_OBSERVED_BLOCK_PAIR`);
  if (observedBlock !== undefined && timeout <= uint(observedBlock, `${code}_OBSERVED_BLOCK`)) throw new Error(`${code}_TIMEOUT_ORDER`);
  if (dispute['batchNonce'] !== undefined) {
    uint(dispute['batchNonce'], `${code}_BATCH_NONCE`);
    if (!observed) throw new Error(`${code}_BATCH_WITHOUT_FINALITY`);
  }
  if (!observed && (timeout !== 0 || dispute['finalizeQueued'] === true)) throw new Error(`${code}_LOCAL_LIFECYCLE`);
  if (account['status'] !== 'disputed') throw new Error(`${code}_STATUS_BINDING`);
};

export const validateStoredPendingAccountInput = (
  account: Record<string, unknown>,
  code: string,
): void => {
  const pendingFrame = account['pendingFrame'];
  const pendingInput = account['pendingAccountInput'];
  if ((pendingFrame === undefined) !== (pendingInput === undefined)) throw new Error(`${code}_PAIR`);
  if (pendingInput === undefined) return;
  const input = requireBoundaryRecord(pendingInput, code);
  if (input['kind'] !== 'frame' && input['kind'] !== 'frame_ack') throw new Error(`${code}_KIND`);
  const proposal = requireBoundaryRecord(input['proposal'], `${code}_PROPOSAL`);
  validateFrame(proposal['frame'], `${code}_PROPOSAL_FRAME`);
  decodeAccountPeerInput(input, code);
};

export const validateStoredLastOutboundFrameAck = (
  account: Record<string, unknown>,
  proofHeader: { fromEntity: string; toEntity: string },
  currentFrame: AccountFrame,
  code: string,
): void => {
  if (account['lastOutboundFrameAck'] === undefined) return;
  const cached = shape(
    account['lastOutboundFrameAck'],
    ['height', 'counterpartyEntityId', 'response'],
    [],
    code,
  );
  const height = uint(cached['height'], `${code}_HEIGHT`);
  const response = decodeAccountPeerInput(cached['response'], `${code}_RESPONSE`);
  if (response.kind !== 'ack') throw new Error(`${code}_KIND`);
  if (
    height !== currentFrame.height
    || response.ack.height !== height
    || response.ack.frameHash !== currentFrame.stateHash
  ) throw new Error(`${code}_FRAME_BINDING`);
  if (
    cached['counterpartyEntityId'] !== proofHeader.toEntity
    || response.fromEntityId !== proofHeader.fromEntity
    || response.toEntityId !== proofHeader.toEntity
  ) throw new Error(`${code}_ENDPOINT_BINDING`);
  const state = requireBoundaryRecord(account['state'], `${code}_STATE`);
  if (
    !sameAccountStateDomain(
      response.domain,
      state['domain'] as AccountState['domain'],
    )
    || response.watchSeed !== state['watchSeed']
  ) throw new Error(`${code}_ACCOUNT_BINDING`);
};
