import ChannelState from '../types/ChannelState';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import Transition from '../types/Transition';
import Logger from '../utils/Logger';

import Block from '../types/Block';
import { TransitionMethod } from '../types/TransitionMethod';
import TextMessageTransition from '../types/Transitions/TextMessageTransition';
import { deepClone, getTimestamp } from '../utils/Utils';
import BlockMessage from '../types/Messages/BlockMessage';
import IChannelStorage from '../types/IChannelStorage';
import SyncQueueWorker from '../utils/SyncQueueWorker';
import hash from '../utils/Hash';
import ChannelPrivateState from '../types/ChannelPrivateState';
import IChannelContext from '../types/IChannelContext';
import IChannel from '../types/IChannel';
import PaymentTransition from '../types/Transitions/PaymentTransition';
import CreateSubchannelTransition, { CreateSubchannelResultTransition } from '../types/Transitions/CreateSubchannelTransition';
import ChannelSavePoint from '../types/ChannelSavePoint';
import { Subchannel } from '../types/SubChannel';

const BLOCK_LIMIT = 5;

export default class Channel implements IChannel {
  state: ChannelState;
  thisUserAddress: string;
  otherUserAddress: string;

  private syncQueue: SyncQueueWorker;
  private privateState: ChannelPrivateState;
  private transport: ITransport;
  private storage: IChannelStorage;

  constructor(
    private ctx: IChannelContext
  ) {
    this.syncQueue = new SyncQueueWorker();

    this.thisUserAddress = this.ctx.getUserAddress();
    this.otherUserAddress = this.ctx.getRecipientAddress();
    this.transport = this.ctx.getTransport();
    this.storage = this.ctx.getStorage(`${this.otherUserAddress}`);

    this.state = {
      left: this.thisUserAddress < this.otherUserAddress ? this.thisUserAddress : this.otherUserAddress,
      right: this.thisUserAddress > this.otherUserAddress ? this.thisUserAddress : this.otherUserAddress,
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockNumber: 0,
      timestamp: 0,
      transitionNumber: 0,
      subChannels: []
    };

    this.privateState = {
      isLeft: this.thisUserAddress < this.otherUserAddress,
      rollbacks: 0,
      sentTransitions: 0,
      pendingBlock: null,
      mempool: [],
      pendingSignatures: [],
      pendingEvents: [],
    };
  }

  async initialize() {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      const channelSavePoint = await this.storage.getValue<ChannelSavePoint>('channelSavePoint');
      this.privateState = channelSavePoint.privateState;
      this.state = channelSavePoint.state;
    } catch {
      await this.save();
    }
  }

  async save(): Promise<void> {
    const channelSavePoint: ChannelSavePoint = {
      privateState: this.privateState,
      state: this.state
    };
    return this.storage.setValue<ChannelSavePoint>('channelSavePoint', channelSavePoint);
  }

  async createSubсhannel(chainId: number): Promise<Subchannel> {
    let subChannel = await this.getSubсhannel(chainId);
    if(subChannel)
      return subChannel; //TODO мы тут должны возвращать существующий или кидать ошибку?
    
    subChannel = {chainId: chainId, offDelta: 0};
    this.state.subChannels.push(subChannel);
    this.state.subChannels.sort((a: Subchannel, b: Subchannel) => a.chainId - b.chainId); 

    return subChannel;
  }

  async getSubсhannel(chainId: number): Promise<Subchannel | undefined> {
    let subChannel = this.state.subChannels.find(subChannel => subChannel.chainId === chainId);
    return subChannel;
  }

  getState(): ChannelState {
    return this.state;
  }
  
  getId() {
    return `${this.thisUserAddress}:${this.otherUserAddress}`;
  }

  private async applyBlock(isLeft: boolean, block: Block): Promise<void> {
    Logger.info(`applyBlock ${block.isLeft} isLeft ${isLeft}}`);

    this.state.blockNumber++;
    this.state.timestamp = block.timestamp;
    this.state.previousBlockHash = hash<Block>(block);
    this.state.previousStateHash = hash<ChannelState>(this.state);

    for (let i = 0; i < block.transitions.length; i++) {
      const transition = block.transitions[i];
      await this.applyTransition(block, transition);
    }
  }

  private async applyTransition(block: Block, transition: Transition): Promise<void> {
    Logger.info(`applyTransition ${block.isLeft} ${transition}}`);

    switch (transition.method) {
      case TransitionMethod.TextMessage:
        {
          const textMessageTransition = transition as TextMessageTransition;
          Logger.info(textMessageTransition.message);
        }
        break;
      case TransitionMethod.PaymentTransition:
        {
          const paymentTransition = transition as PaymentTransition;
          const subChannel = await this.getSubсhannel(paymentTransition.tokenId);
          if(subChannel) {
            Logger.info(`Processing PaymentTransition ${subChannel.chainId}`);

            subChannel.offDelta += block.isLeft ? -paymentTransition.amount : paymentTransition.amount;
          }
        }
        break;
        case TransitionMethod.CreateSubchannel:
        {
          const subchannelTransition = transition as CreateSubchannelTransition;
          const subChannel = await this.createSubсhannel(subchannelTransition.chainId);
          Logger.info(`Processing CreateSubchannelTransition ${subChannel.chainId}`);

          //const t: CreateSubchannelResultTransition = new CreateSubchannelResultTransition(subchannelTransition.chainId, true);
          //this.push(t);
        }
        break;
        /*case TransitionMethod.CreateSubchannelResult:
        {
          const tr = transition as CreateSubchannelResultTransition;
          if(tr.isSuccess) {
            await this.createSubсhannel(tr.chainId);
          }
          Logger.info(`Processing CreateSubchannelResultTransition ${tr.chainId}:${tr.isSuccess}`);
        }
        break;*/
    }

    this.state.transitionNumber++;
  }

  private async syncSignatures(message: BlockMessage): Promise<boolean> {
    if (this.privateState.pendingBlock != null) {
      if (message.blockNumber == this.state.blockNumber + 1) {
        const pendingBlock: Block = this.privateState.pendingBlock;
        await this.applyBlock(this.privateState.isLeft, pendingBlock);

        const allSignatures = [message.ackSignatures, this.privateState.pendingSignatures];
        if (this.privateState.isLeft) allSignatures.reverse();

        await this.storage.put({ state: this.state, block: pendingBlock, allSignatures: allSignatures });
        await this.save();

        this.privateState.mempool.splice(0, this.privateState.sentTransitions);
        this.privateState.sentTransitions = 0;
        this.privateState.pendingBlock = null;
      } else if (message.blockNumber == this.state.blockNumber && !this.privateState.isLeft) {
        this.privateState.pendingBlock = null;
        this.privateState.sentTransitions = 0;
        this.privateState.rollbacks++;
      } else {
        //
        return false;
      }
    }

    await this.save();
    return true;
  }

  async receive(message: BlockMessage): Promise<void> {
    const syncSignaturesResult = await this.syncSignatures(message);
    if (!syncSignaturesResult) {
      return;
    }

    if (!message.block) {
      return;
    }

    this.syncQueue.sync(async () => {
      const block: Block = message.block!;

      if (block.previousStateHash != hash<ChannelState>(this.state)) {
        throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
      }

      if (block.previousBlockHash != this.state.previousBlockHash) {
        throw new Error('Invalid previousBlockHash');
      }

      if (!(await this.ctx.verifyMessage(hash<Block>(block), message.newSignatures[0], this.otherUserAddress))) {
        throw new Error('Invalid verify block signature');
      }

      const privateState = this.privateState;

      await this.applyBlock(privateState.isLeft, block);

      const allSignatures = [message.ackSignatures, privateState.pendingSignatures];
      if (privateState.isLeft) allSignatures.reverse();

      await this.storage.put({ state: this.state, block: message.block!, allSignatures: allSignatures });
      await this.save();

      if (privateState.mempool.length > 0 || block.transitions.length > 0) {
        await this.flush();
      }
    });
  }

  push(transition: Transition): Promise<void> {
    return this.syncQueue.sync(async () => {
      this.privateState.mempool.push(transition);
      await this.save();
    });
  }

  send(): Promise<void> {
    return this.syncQueue.sync(() => this.flush());
  }

  private async flush(): Promise<void> {
    if (this.privateState.sentTransitions > 0) {
      return;
    }

    const message: IMessage = {
      header: {
        from: this.thisUserAddress,
        to: this.ctx.getRecipientAddress(),
      },
      body: new BlockMessage(this.state.blockNumber, [], []),
    };

    const transitions = this.privateState.mempool.slice(0, BLOCK_LIMIT);
    if (transitions.length > 0) {
      const previousState: ChannelState = deepClone(this.state);

      const block: Block = {
        isLeft: this.privateState.isLeft,
        timestamp: getTimestamp(),
        previousStateHash: hash<ChannelState>(previousState), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockNumber: this.state.blockNumber,
        transitions: transitions,
      };

      await this.applyBlock(this.privateState.isLeft, block);

      this.privateState.pendingBlock = deepClone(block); //зачем клон блока??
      this.privateState.sentTransitions = transitions.length;
      this.privateState.pendingSignatures = [
        hash<Block>(this.privateState.pendingBlock!),
        hash<ChannelState>(this.state),
      ];

      this.state = previousState;

      const body = message.body as BlockMessage;
      body.block = block;
      body.newSignatures = [await this.ctx.signMessage(hash<Block>(block))];

      Logger.info(
        `Sub channel send message from ${this.thisUserAddress} to ${this.otherUserAddress} with body ${message.body}`,
      );

      await this.save();
    }

    await this.transport.send(message);
  }
}
