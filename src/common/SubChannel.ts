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
import ISubChannel from '../types/ISubChannel';


const BLOCK_LIMIT = 5;

export class SubChannel implements ISubChannel {
  state: ChannelState;
  thisUserAddress: string;
  otherUserAddress: string;
  tokenId: number;

  private syncQueue: SyncQueueWorker;
  private privateState: ChannelPrivateState;
  private transport: ITransport;
  private storage: IChannelStorage;

  constructor(
    otherUserAddress: string,
    tokenId: number,
    private ctx: IChannelContext,
  ) {
    this.syncQueue = new SyncQueueWorker();

    this.tokenId = tokenId;
    this.thisUserAddress = this.ctx.getUserId();
    this.otherUserAddress = otherUserAddress;
    this.transport = this.ctx.getTransport();
    this.storage = this.ctx.getStorage(`${this.otherUserAddress}:${this.tokenId}`);

    this.state = {
      left: this.thisUserAddress < this.otherUserAddress ? this.thisUserAddress : this.otherUserAddress,
      right: this.thisUserAddress > this.otherUserAddress ? this.thisUserAddress : this.otherUserAddress,
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockNumber: 0,
      timestamp: 0,
      offDelta: 0,
      transitionNumber: 0,
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

  getState(): ChannelState {
    return this.state;
  }

  private savePrivateState(): Promise<void> {
    return this.storage.setValue<ChannelPrivateState>('privateState', this.privateState);
  }

  private async loadPrivateState(): Promise<void> {
    try {
      this.privateState = await this.storage.getValue<ChannelPrivateState>('privateState');
    } catch {
      await this.savePrivateState();
    }
  }

  private saveState(): Promise<void> {
    return this.storage.setValue<ChannelState>('state', this.state);
  }

  private async loadState(): Promise<void> {
    try {
      this.state = await this.storage.getValue<ChannelState>('state');
    } catch {
      await this.saveState();
    }
  }

  async initialize() {
    await this.loadState();
    await this.loadPrivateState();
  }

  getId() {
    return `${this.thisUserAddress}:${this.otherUserAddress}:${this.tokenId}`;
  }

  private applyBlock(isLeft: boolean, block: Block) {
    Logger.info(`applyBlock ${block.isLeft} isLeft ${isLeft}}`);

    this.state.blockNumber++;
    this.state.timestamp = block.timestamp;
    this.state.previousBlockHash = hash<Block>(block);
    this.state.previousStateHash = hash<ChannelState>(this.state);

    for (let i = 0; i < block.transitions.length; i++) {
      const transition = block.transitions[i];
      this.applyTransition(block, transition);
    }
  }

  private applyTransition(block: Block, transition: Transition) {
    Logger.info(`applyTransition ${block.isLeft} ${transition}}`);

    switch (transition.method) {
      case TransitionMethod.TextMessage:
        {
          const textMessageTransition = transition as TextMessageTransition;
          const diff = Number.parseInt(textMessageTransition.message);

          if (isNaN(diff)) {
            Logger.info(textMessageTransition.message);
          } else {
            Logger.info(`Processing diff ${this.state.offDelta} ${diff}`);
            this.state.offDelta += block.isLeft ? -diff : diff;
          }
        }
        break;
    }

    this.state.transitionNumber++;
  }

  private async syncSignatures(message: BlockMessage): Promise<boolean> {
    if (this.privateState.pendingBlock != null) {
      if (message.blockNumber == this.state.blockNumber + 1) {
        const pendingBlock: Block = this.privateState.pendingBlock;
        this.applyBlock(this.privateState.isLeft, pendingBlock);

        const allSignatures = [message.ackSignatures, this.privateState.pendingSignatures];
        if (this.privateState.isLeft) allSignatures.reverse();

        await this.storage.put({ state: this.state, block: pendingBlock, allSignatures: allSignatures });
        await this.saveState();

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

    await this.savePrivateState();
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

      this.applyBlock(privateState.isLeft, block);

      const allSignatures = [message.ackSignatures, privateState.pendingSignatures];
      if (privateState.isLeft) allSignatures.reverse();

      await this.storage.put({ state: this.state, block: message.block!, allSignatures: allSignatures });
      await this.saveState();

      if (privateState.mempool.length > 0 || block.transitions.length > 0) {
        await this.flush();
      }
    });
  }

  push(transition: Transition): Promise<void> {
    return this.syncQueue.sync(async () => {
      this.privateState.mempool.push(transition);
      await this.savePrivateState();
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
        to: this.ctx.getRecipientUserId(),
      },
      body: new BlockMessage(this.state.blockNumber, this.thisUserAddress, this.otherUserAddress, this.tokenId, [], []),
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

      this.applyBlock(this.privateState.isLeft, block);

      this.privateState.pendingBlock = deepClone(block); //зачем клон блока??
      this.privateState.sentTransitions = transitions.length;
      this.privateState.pendingSignatures = [
        hash<Block>(this.privateState.pendingBlock!),
        hash<ChannelState>(this.state),
      ];

      await this.savePrivateState();

      this.state = previousState;

      const body = message.body as BlockMessage;
      body.block = block;
      body.newSignatures = [await this.ctx.signMessage(hash<Block>(block))];

      Logger.info(
        `Sub channel send message from ${this.thisUserAddress} to ${this.otherUserAddress} with body ${message.body}`,
      );
    }

    await this.transport.send(message);
  }
}