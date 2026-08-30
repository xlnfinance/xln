import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';
import type {
  AccountBoardHankoRefresh,
  AccountDisputeHanko,
  AccountAckFrame,
  AccountFrameProposal,
  AccountPeerInput,
  AccountStateDomain,
} from '../../types/account';
import { decodeAccountFrame } from './frame-validation';
import { canonicalAccountDisputeConfig } from '../config/dispute-config';

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const decodeAccountDomain = (value: unknown, code: string): AccountStateDomain => {
  const domain = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(domain, ['chainId', 'depositoryAddress'], [], `${code}_FIELDS`);
  return {
    chainId: requireBoundaryInteger(domain['chainId'], `${code}_CHAIN_ID`, 1),
    depositoryAddress: requireString(domain['depositoryAddress'], `${code}_DEPOSITORY_ADDRESS`),
  };
};

const decodeAccountDisputeConfig = (
  value: unknown,
  code: string,
): AccountPeerInput['disputeConfig'] => {
  const config = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    config,
    ['leftResponseSeconds', 'rightResponseSeconds'],
    [],
    `${code}_FIELDS`,
  );
  return canonicalAccountDisputeConfig({
    leftResponseSeconds: requireBoundaryInteger(
      config['leftResponseSeconds'],
      `${code}_LEFT_RESPONSE_SECONDS`,
      0,
    ),
    rightResponseSeconds: requireBoundaryInteger(
      config['rightResponseSeconds'],
      `${code}_RIGHT_RESPONSE_SECONDS`,
      0,
    ),
  });
};

const decodeDisputeHanko = (value: unknown, code: string): AccountDisputeHanko => {
  const disputeHanko = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    disputeHanko,
    ['hash', 'proofBodyHash', 'proofNonce', 'proposerIsLeft'],
    ['hanko'],
    `${code}_FIELDS`,
  );
  const hanko = disputeHanko['hanko'];
  if (hanko !== undefined && typeof hanko !== 'string') throw new Error(`${code}_HANKO`);
  return {
    ...(hanko === undefined ? {} : { hanko }),
    hash: requireString(disputeHanko['hash'], `${code}_HASH`),
    proofBodyHash: requireString(disputeHanko['proofBodyHash'], `${code}_PROOF_BODY_HASH`),
    proofNonce: requireBoundaryInteger(disputeHanko['proofNonce'], `${code}_PROOF_NONCE`),
    proposerIsLeft: requireBoolean(disputeHanko['proposerIsLeft'], `${code}_PROPOSER_IS_LEFT`),
  };
};

const decodeAckFrame = (value: unknown, code: string): AccountAckFrame => {
  const ack = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    ack,
    ['height', 'frameHash'],
    ['frameHanko', 'disputeHanko'],
    `${code}_FIELDS`,
  );
  const frameHanko = ack['frameHanko'];
  if (frameHanko !== undefined && typeof frameHanko !== 'string') throw new Error(`${code}_FRAME_HANKO`);
  return {
    height: requireBoundaryInteger(ack['height'], `${code}_HEIGHT`),
    frameHash: requireString(ack['frameHash'], `${code}_FRAME_HASH`),
    ...(frameHanko === undefined ? {} : { frameHanko }),
    ...(ack['disputeHanko'] === undefined
      ? {}
      : { disputeHanko: decodeDisputeHanko(ack['disputeHanko'], `${code}_DISPUTE_HANKO`) }),
  };
};

const decodeFrameProposal = (value: unknown, code: string): AccountFrameProposal => {
  const proposal = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    proposal,
    ['frame'],
    ['frameHanko', 'disputeHanko'],
    `${code}_FIELDS`,
  );
  const frameHanko = proposal['frameHanko'];
  if (frameHanko !== undefined && typeof frameHanko !== 'string') {
    throw new Error(`${code}_FRAME_HANKO`);
  }
  return {
    frame: decodeAccountFrame(proposal['frame'], `${code}_FRAME`),
    ...(frameHanko === undefined ? {} : { frameHanko }),
    ...(proposal['disputeHanko'] === undefined
      ? {}
      : { disputeHanko: decodeDisputeHanko(proposal['disputeHanko'], `${code}_DISPUTE_HANKO`) }),
  };
};

const decodeBoardHankoRefresh = (value: unknown, code: string): AccountBoardHankoRefresh => {
  const boardHankoRefresh = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    boardHankoRefresh,
    ['height', 'frameHash', 'boardActivationJHeight', 'boardActivationLogIndex'],
    ['frameHanko', 'disputeHanko'],
    `${code}_FIELDS`,
  );
  const ack = decodeAckFrame(
    {
      height: boardHankoRefresh['height'],
      frameHash: boardHankoRefresh['frameHash'],
      ...(boardHankoRefresh['frameHanko'] === undefined ? {} : { frameHanko: boardHankoRefresh['frameHanko'] }),
      ...(boardHankoRefresh['disputeHanko'] === undefined ? {} : { disputeHanko: boardHankoRefresh['disputeHanko'] }),
    },
    `${code}_ACK`,
  );
  return {
    ...ack,
    boardActivationJHeight: requireBoundaryInteger(
      boardHankoRefresh['boardActivationJHeight'],
      `${code}_J_HEIGHT`,
    ),
    boardActivationLogIndex: requireBoundaryInteger(
      boardHankoRefresh['boardActivationLogIndex'],
      `${code}_LOG_INDEX`,
    ),
  };
};

/**
 * Decode an Account peer message before it can enter Entity replay.
 *
 * A signed Account frame is still untrusted bytes at a storage or transport
 * boundary. Exact decoding here prevents a valid outer EntityTx tag from
 * smuggling malformed ACK, proposal, dispute, or board-hanko-refresh data into the
 * bilateral reducer.
 */
export const decodeAccountPeerInput = (value: unknown, code: string): AccountPeerInput => {
  const input = requireBoundaryRecord(value, code);
  const kind = requireString(input['kind'], `${code}_KIND`);
  const baseKeys = ['kind', 'fromEntityId', 'toEntityId', 'domain', 'disputeConfig'] as const;
  const optionalBaseKeys = ['watchSeed'] as const;
  const fromEntityId = requireString(input['fromEntityId'], `${code}_FROM_ENTITY_ID`);
  const toEntityId = requireString(input['toEntityId'], `${code}_TO_ENTITY_ID`);
  const domain = decodeAccountDomain(input['domain'], `${code}_DOMAIN`);
  const disputeConfig = decodeAccountDisputeConfig(input['disputeConfig'], `${code}_DISPUTE_CONFIG`);
  const watchSeed = input['watchSeed'];
  if (watchSeed !== undefined && typeof watchSeed !== 'string') throw new Error(`${code}_WATCH_SEED`);
  const base = {
    fromEntityId,
    toEntityId,
    domain,
    disputeConfig,
    ...(watchSeed === undefined ? {} : { watchSeed }),
  };

  switch (kind) {
    case 'frame':
      requireExactBoundaryKeys(input, [...baseKeys, 'proposal'], optionalBaseKeys, `${code}_FIELDS`);
      return { ...base, kind, proposal: decodeFrameProposal(input['proposal'], `${code}_PROPOSAL`) };
    case 'ack':
      requireExactBoundaryKeys(input, [...baseKeys, 'ack'], optionalBaseKeys, `${code}_FIELDS`);
      return { ...base, kind, ack: decodeAckFrame(input['ack'], `${code}_ACK`) };
    case 'ack_frame':
      requireExactBoundaryKeys(
        input,
        [...baseKeys, 'ack', 'proposal'],
        optionalBaseKeys,
        `${code}_FIELDS`,
      );
      return {
        ...base,
        kind,
        ack: decodeAckFrame(input['ack'], `${code}_ACK`),
        proposal: decodeFrameProposal(input['proposal'], `${code}_PROPOSAL`),
      };
    case 'dispute':
      requireExactBoundaryKeys(
        input,
        [...baseKeys, 'disputeHanko'],
        optionalBaseKeys,
        `${code}_FIELDS`,
      );
      return {
        ...base,
        kind,
        disputeHanko: decodeDisputeHanko(input['disputeHanko'], `${code}_DISPUTE_HANKO`),
      };
    case 'board_hanko_refresh':
      requireExactBoundaryKeys(input, [...baseKeys, 'boardHankoRefresh'], optionalBaseKeys, `${code}_FIELDS`);
      return { ...base, kind, boardHankoRefresh: decodeBoardHankoRefresh(input['boardHankoRefresh'], `${code}_BOARD_HANKO_REFRESH`) };
    case 'txs':
      throw new Error(`${code}_LOCAL_INPUT_FORBIDDEN`);
    default:
      throw new Error(`${code}_KIND_INVALID:${kind}`);
  }
};
