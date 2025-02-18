import { EntityRoot, EntityBlock, EntityStorage } from '../entity';
import { StorageType } from '../storage/merkle';
import Channel from './Channel';
import { ChannelState, ChannelData } from '../types/Channel';
import { encode, decode } from 'rlp';

export class ChannelSubmachine {
  private channel: Channel;
  
  constructor(channel: Channel) {
    this.channel = channel;
  }

  // Convert channel state to entity state
  toEntityState(): EntityRoot {
    const channelState = this.channel.getState();
    const channelData = this.channel.data;

    return {
      status: 'idle',
      entityPool: new Map(),
      finalBlock: this.createEntityBlock(channelState, channelData),
      consensusBlock: undefined
    };
  }

  // Create entity block from channel state
  private createEntityBlock(state: ChannelState, data: ChannelData): EntityBlock {
    return {
      blockNumber: state.blockId,
      storage: { value: new Map() } as EntityStorage,
      channelRoot: Buffer.from(state.channelKey.slice(2), 'hex'),
      channelMap: new Map([
        [state.channelKey, encode([
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
            s.offdelta.toString()
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
        ])]
      ]),
      inbox: Buffer.from([]),
      validatorSet: []
    };
  }

  // Update channel state from entity state
  fromEntityState(entityState: EntityRoot) {
    if (!entityState.finalBlock) return;

    const channelData = entityState.finalBlock.channelMap.values().next().value;
    if (!channelData) return;

    const decoded = decode(channelData) as unknown as [
      string, string, string, string, number, number, 
      Buffer[], Buffer[]
    ];

    const [
      left,
      right,
      previousBlockHash,
      previousStateHash,
      timestamp,
      transitionId,
      encodedSubchannels,
      encodedSubcontracts
    ] = decoded;

    const subchannels = encodedSubchannels.map(buf => {
      const [
        chainId,
        tokenId,
        leftCreditLimit,
        rightCreditLimit,
        leftAllowence,
        rightAllowence,
        collateral,
        ondelta,
        offdelta
      ] = decode(buf) as [number, number, string, string, string, string, string, string, string];

      return {
        chainId,
        tokenId,
        leftCreditLimit: BigInt(leftCreditLimit),
        rightCreditLimit: BigInt(rightCreditLimit),
        leftAllowence: BigInt(leftAllowence),
        rightAllowence: BigInt(rightAllowence),
        collateral: BigInt(collateral),
        ondelta: BigInt(ondelta),
        offdelta: BigInt(offdelta)
      };
    });

    const subcontracts = encodedSubcontracts.map(buf => {
      const [
        chainId,
        tokenId,
        contractAddress,
        leftDeposit,
        rightDeposit,
        leftWithdraw,
        rightWithdraw,
        status
      ] = decode(buf) as [number, number, string, string, string, string, string, string];

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

    const newState: ChannelState = {
      left,
      right,
      channelKey: '0x' + entityState.finalBlock.channelRoot.toString('hex'),
      previousBlockHash,
      previousStateHash,
      blockId: entityState.finalBlock.blockNumber,
      timestamp,
      transitionId,
      subchannels,
      subcontracts
    };

    // Update channel state
    Object.assign(this.channel.state, newState);
  }

  // Helper to encode channel state for merkle store
  encodeForMerkleStore(): Map<StorageType, Buffer> {
    const state = this.channel.getState();
    const channelMap = new Map<string, Buffer>();
    
    channelMap.set(state.channelKey, encode([
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
        s.offdelta.toString()
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

    return new Map([
      [StorageType.CURRENT_BLOCK, encode([
        state.blockId,
        encode([['value', encode([])]]),
        Buffer.from(state.channelKey.slice(2), 'hex'),
        encode(Array.from(channelMap.entries())),
        Buffer.from([]),
        []
      ])]
    ]);
  }
} 