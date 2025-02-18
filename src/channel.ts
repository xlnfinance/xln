import { Buffer } from 'buffer';
import { encode, decode } from 'rlp';
import { createHash } from 'crypto';
import { EntityRoot, EntityBlock, EntityStorage } from './entity.js';
import { StorageType } from './storage/merkle.js';
import { Subchannel, ProposedEventData } from './types/Subchannel.js';
import { StoredSubcontract } from './types/Subcontract.js';
import * as Transition from './app/Transition.js';

export type ChannelInput = 
  | { type: 'AddChannelTx', tx: Buffer }
  | { type: 'Consensus',
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      counterpartySig?: Buffer
    }

export type ChannelRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: Buffer
  consensusBlock?: Buffer
  mempool: Map<string, Buffer>  // txHash -> channelTx
}

export function encodeChannelRoot(root: ChannelRoot): Buffer {
  return Buffer.from(encode([
    root.status,
    root.finalBlock || Buffer.from([]),
    root.consensusBlock || Buffer.from([]),
    Array.from(root.mempool.entries())
  ]));
}

export function decodeChannelRoot(data: Buffer): ChannelRoot {
  const [status, finalBlock, consensusBlock, mempoolRlp] = decode(data) as unknown as [Buffer, Buffer, Buffer, Buffer[][]];
  
  return {
    status: Buffer.from(status).toString() as 'idle' | 'precommit' | 'commit',
    finalBlock: finalBlock.length > 0 ? finalBlock : undefined,
    consensusBlock: consensusBlock.length > 0 ? consensusBlock : undefined,
    mempool: new Map(mempoolRlp as [string, Buffer][])
  };
}

// Core types
export type ChannelState = {
  left: string
  right: string
  channelKey: string
  previousBlockHash: string
  previousStateHash: string
  channelNonce: number
  timestamp: number
  transitionId: number
  subchannels: Subchannel[]
  subcontracts: StoredSubcontract[]
}

export type ChannelData = {
  isLeft: boolean
  rollbacks: number
  sentTransitions: number
  pendingBlock: any | null
  pendingSignatures: string[]
  sendCounter: number
  receiveCounter: number
}

// Create initial channel state
export function createChannelState(left: string, right: string): ChannelState {
  const channelKey = createChannelKey(left, right);
  return {
    left: left < right ? left : right,
    right: left < right ? right : left,
    channelKey,
    previousBlockHash: '0x0',
    previousStateHash: '0x0',
    channelNonce: 0,
    timestamp: 0,
    transitionId: 0,
    subchannels: [],
    subcontracts: []
  };
}

// Create initial channel data
export function createChannelData(isLeft: boolean): ChannelData {
  return {
    isLeft,
    rollbacks: 0,
    sentTransitions: 0,
    pendingBlock: null,
    pendingSignatures: [],
    sendCounter: 0,
    receiveCounter: 0
  };
}

// Convert channel state to entity state
export function toEntityState(state: ChannelState, data: ChannelData): EntityRoot {
  return {
    status: 'idle',
    entityPool: new Map(),
    finalBlock: createEntityBlock(state),
    consensusBlock: undefined
  };
}

// Create entity block from channel state
function createEntityBlock(state: ChannelState): EntityBlock {
  return {
    blockNumber: state.channelNonce,
    storage: { value: 0 },
    channelRoot: Buffer.from(state.channelKey.slice(2), 'hex'),
    channelMap: new Map([
      [state.channelKey, encodeChannelState(state)]
    ]),
    inbox: [],
    validatorSet: []
  };
}

// Update channel state from entity state
export function fromEntityState(entityState: EntityRoot): ChannelState | undefined {
  if (!entityState.finalBlock) return undefined;

  const channelData = entityState.finalBlock.channelMap.values().next().value;
  if (!channelData) return undefined;

  return decodeChannelState(channelData);
}

// Helper functions
function createChannelKey(left: string, right: string): string {
  const [addr1, addr2] = left < right ? [left, right] : [right, left];
  return '0x' + createHash('sha256')
    .update(Buffer.concat([
      Buffer.from(addr1.slice(2), 'hex'),
      Buffer.from(addr2.slice(2), 'hex')
    ]))
    .digest('hex');
}

function encodeChannelState(state: ChannelState): Buffer {
  return Buffer.from(encode([
    state.left,
    state.right,
    state.previousBlockHash,
    state.previousStateHash,
    state.timestamp,
    state.transitionId,
    state.subchannels.map(s => encode([
      s.chainId,
      s.tokenId,
      s.leftCreditLimit.toString(),
      s.rightCreditLimit.toString(),
      s.leftAllowence.toString(),
      s.rightAllowence.toString(),
      s.collateral.toString(),
      s.ondelta.toString(),
      s.offdelta.toString(),
      s.cooperativeNonce,
      s.disputeNonce,
      s.deltas.map(d => encode([
        d.tokenId,
        d.collateral.toString(),
        d.ondelta.toString(),
        d.offdelta.toString(),
        d.leftCreditLimit.toString(),
        d.rightCreditLimit.toString(),
        d.leftAllowence.toString(),
        d.rightAllowence.toString()
      ])),
      s.proposedEvents.map(e => encode([
        e.type,
        e.chainId,
        e.tokenId,
        e.collateral.toString(),
        e.ondelta.toString()
      ])),
      s.proposedEventsByLeft ? 1 : 0
    ])),
    state.subcontracts.map(c => encode([
      c.chainId,
      c.tokenId,
      c.contractAddress,
      c.leftDeposit.toString(),
      c.rightDeposit.toString(),
      c.leftWithdraw.toString(),
      c.rightWithdraw.toString(),
      c.status
    ]))
  ]));
}

function decodeChannelState(data: Buffer): ChannelState {
  const decoded = decode(data) as unknown;
  if (!Array.isArray(decoded) || decoded.length !== 8) {
    throw new Error('Invalid channel state format');
  }

  const [
    left,
    right,
    previousBlockHash,
    previousStateHash,
    timestamp,
    transitionId,
    encodedSubchannels,
    encodedSubcontracts
  ] = decoded as [string, string, string, string, number, number, Buffer[], Buffer[]];

  const subchannels = (encodedSubchannels as Buffer[]).map(buf => {
    const decoded = decode(buf) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 14) {
      throw new Error('Invalid subchannel format');
    }

    const [
      chainId,
      tokenId,
      leftCreditLimit,
      rightCreditLimit,
      leftAllowence,
      rightAllowence,
      collateral,
      ondelta,
      offdelta,
      cooperativeNonce,
      disputeNonce,
      encodedDeltas,
      encodedProposedEvents,
      proposedEventsByLeft
    ] = decoded as [number, number, string, string, string, string, string, string, string, number, number, Buffer[], Buffer[], number];

    const deltas = (encodedDeltas as Buffer[]).map(buf => {
      const decoded = decode(buf) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 8) {
        throw new Error('Invalid delta format');
      }

      const [
        tokenId,
        collateral,
        ondelta,
        offdelta,
        leftCreditLimit,
        rightCreditLimit,
        leftAllowence,
        rightAllowence
      ] = decoded as [number, string, string, string, string, string, string, string];

      return {
        tokenId,
        collateral: BigInt(collateral),
        ondelta: BigInt(ondelta),
        offdelta: BigInt(offdelta),
        leftCreditLimit: BigInt(leftCreditLimit),
        rightCreditLimit: BigInt(rightCreditLimit),
        leftAllowence: BigInt(leftAllowence),
        rightAllowence: BigInt(rightAllowence)
      };
    });

    const proposedEvents = (encodedProposedEvents as Buffer[]).map(buf => {
      const decoded = decode(buf) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 5) {
        throw new Error('Invalid proposed event format');
      }

      const [
        type,
        chainId,
        tokenId,
        collateral,
        ondelta
      ] = decoded as [string, number, number, string, string];

      return {
        type,
        chainId,
        tokenId,
        collateral: BigInt(collateral),
        ondelta: BigInt(ondelta)
      } as ProposedEventData;
    });

    return {
      chainId,
      tokenId,
      leftCreditLimit: BigInt(leftCreditLimit),
      rightCreditLimit: BigInt(rightCreditLimit),
      leftAllowence: BigInt(leftAllowence),
      rightAllowence: BigInt(rightAllowence),
      collateral: BigInt(collateral),
      ondelta: BigInt(ondelta),
      offdelta: BigInt(offdelta),
      cooperativeNonce,
      disputeNonce,
      deltas,
      proposedEvents,
      proposedEventsByLeft: proposedEventsByLeft === 1
    };
  });

  const subcontracts = (encodedSubcontracts as Buffer[]).map(buf => {
    const decoded = decode(buf) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 8) {
      throw new Error('Invalid subcontract format');
    }

    const [
      chainId,
      tokenId,
      contractAddress,
      leftDeposit,
      rightDeposit,
      leftWithdraw,
      rightWithdraw,
      status
    ] = decoded as [number, number, string, string, string, string, string, string];

    return {
      chainId,
      tokenId,
      contractAddress,
      leftDeposit: BigInt(leftDeposit),
      rightDeposit: BigInt(rightDeposit),
      leftWithdraw: BigInt(leftWithdraw),
      rightWithdraw: BigInt(rightWithdraw),
      status: status as 'active' | 'closing' | 'closed'
    };
  });

  return {
    left,
    right,
    channelKey: createChannelKey(left, right),
    previousBlockHash,
    previousStateHash,
    channelNonce: transitionId,
    timestamp,
    transitionId,
    subchannels,
    subcontracts
  };
}

// Encode channel state for merkle store
export function encodeForMerkleStore(state: ChannelState): Map<StorageType, Buffer> {
  const channelMap = new Map<string, Buffer>();
  channelMap.set(state.channelKey, encodeChannelState(state));

  return new Map<StorageType, Buffer>([
    [StorageType.CURRENT_BLOCK, Buffer.from(encode([
      state.channelNonce,
      encode([['value', encode([0])]]),
      Buffer.from(state.channelKey.slice(2), 'hex'),
      encode(Array.from(channelMap.entries())),
      encode([]),
      encode([])
    ]))]
  ]);
} 