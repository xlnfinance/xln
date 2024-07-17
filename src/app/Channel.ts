import ChannelState from '../types/ChannelState';
import IMessage from '../types/IMessage';
import Transition from '../types/Transition';
import Logger from '../utils/Logger';

import Block from '../types/Block';
import { TransitionMethod } from '../types/TransitionMethod';
import TextMessageTransition from '../types/Transitions/TextMessageTransition';
import { deepClone, getTimestamp } from '../utils/Utils';
import BlockMessage from '../types/Messages/BlockMessage';
import IChannelStorage from '../types/IChannelStorage';
import hash from '../utils/Hash';
import ChannelData from '../types/ChannelData';
import IChannelContext from '../types/IChannelContext';
import IChannel from '../types/IChannel';
import PaymentTransition from '../types/Transitions/PaymentTransition';
import CreateSubchannelTransition from '../types/Transitions/CreateSubchannelTransition';
import ChannelSavePoint from '../types/ChannelSavePoint';
import { createSubchannelData, MoneyValue, Subchannel, TokenDelta } from '../types/Subchannel';
import AddCollateralTransition from '../types/Transitions/AddCollateralTransition';
import { BigNumberish } from 'ethers';
import SetCreditLimitTransition from '../types/Transitions/SetCreditLimitTransition';
import UnsafePaymentTransition from '../types/Transitions/UnsafePaymentTransition';
import { decode, encode } from '../utils/Codec';


const BLOCK_LIMIT = 5;
import { sleep } from '../utils/Utils';

export default class Channel implements IChannel {
  public state: ChannelState;
  thisUserAddress: string;
  otherUserAddress: string;  


  public data: ChannelData;
  public storage: IChannelStorage;

  constructor(
    private ctx: IChannelContext
  ) {
    this.thisUserAddress = this.ctx.getUserAddress();
    this.otherUserAddress = this.ctx.getRecipientAddress();
    this.storage = this.ctx.getStorage(`${this.otherUserAddress}`);

    this.state = this.emptyState();
    this.data = this.emptyData();
  }



  private emptyState(): ChannelState {
    return {
      left: this.ctx.getUserAddress() < this.ctx.getRecipientAddress() ? this.ctx.getUserAddress() : this.ctx.getRecipientAddress(),
      right: this.ctx.getUserAddress() > this.ctx.getRecipientAddress() ? this.ctx.getUserAddress() : this.ctx.getRecipientAddress(),
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockNumber: 0,
      timestamp: 0,
      transitionNumber: 0,
      subChannels: []
    };
  }

  private emptyData(): ChannelData {
    return {
      isLeft: this.ctx.getUserAddress() < this.ctx.getRecipientAddress(),
      rollbacks: 0,
      sentTransitions: 0,
      pendingBlock: null,
      mempool: [],
      pendingSignatures: [],
      pendingEvents: [],
    };
  }





  async load(): Promise<void> {
    try {
      const channelSavePoint = await this.storage.getValue<ChannelSavePoint>('channelSavePoint');
      this.data = channelSavePoint.data;
      this.state = channelSavePoint.state;
      Logger.info("Loaded last state ", this.state);
    } catch (e) {
      console.log("Load error", e);
      //await this.save();
    }
  }

  async save(): Promise<void> {
    const channelSavePoint: ChannelSavePoint = {
      data: this.data,
      state: this.state
    };

    console.log("Saving state", this.isLeft(), channelSavePoint, new Date());

    return this.storage.setValue<ChannelSavePoint>('channelSavePoint', channelSavePoint);
  }

  createSubchannel(chainId: number): Subchannel {
    let subChannel = this.getSubchannel(chainId);
    if(subChannel)
      return subChannel; //TODO мы тут должны возвращать существующий или кидать ошибку?
    
    subChannel = createSubchannelData(chainId, 1);
    this.state.subChannels.push(subChannel);

    return subChannel;
  }

  getSubchannel(chainId: number): Subchannel | undefined {
    let subChannel = this.state.subChannels.find(subChannel => subChannel.chainId === chainId);
    return subChannel;
  }

  getState(): ChannelState {
    return this.state;
  }
  
  getId() {
    return `${this.thisUserAddress}:${this.otherUserAddress}`;
  }

  isLeft() : boolean {
    return this.data.isLeft;
  }

  private async applyBlock(isLeft: boolean, block: Block): Promise<void> {
    Logger.info(`applyBlock ${block.isLeft} isLeft ${isLeft}}`);

    // save previous hash first before changing this.state
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
          const subChannel = await this.getSubchannel(paymentTransition.tokenId);
          if(subChannel) {
            Logger.info(`Processing PaymentTransition ${subChannel.chainId}`);

            //subChannel.offDelta += block.isLeft ? -paymentTransition.amount : paymentTransition.amount;
          }
        }
        break;
        case TransitionMethod.CreateSubchannel:
        {
          const subchannelTransition = transition as CreateSubchannelTransition;
          const subChannel = await this.createSubchannel(subchannelTransition.chainId);
          Logger.info(`Processing CreateSubchannelTransition ${subChannel.chainId}`);
        }
        break;
        case TransitionMethod.AddCollateral:
        {
          const tr = transition as AddCollateralTransition;
          //TODO handle errors if subchannel, token or smth was not found
          this.addCollateral(tr.chainId, tr.tokenId, tr.isLeft, tr.collateral);
        }
        break;
        case TransitionMethod.SetCreditLimit:
        {
          const tr = transition as SetCreditLimitTransition;
          //TODO handle errors if subchannel, token or smth was not found
          this.setCreditLimit(tr.chainId, tr.tokenId, tr.isLeft, tr.creditLimit);
        }
        break;
        case TransitionMethod.UnsafePayment:
        {
          const tr = transition as UnsafePaymentTransition;
          //TODO handle errors if subchannel, token or smth was not found
          //TODO проверить допустимые лимиты для платежа, не выходит ли за пределы
          this.applyUnsafePayment(tr.chainId, tr.tokenId, tr.isLeft, tr.amount);

          if(this.thisUserAddress == tr.fromUserId || this.thisUserAddress == tr.toUserId) {
            //do nothing
          }
          else {
            // we are hub, resend payment to target channel
          }
        }
        break;
    }

    this.state.transitionNumber++;
  }

  private async syncSignatures(message: BlockMessage): Promise<boolean> {
    if (this.data.pendingBlock != null) {
      if (message.blockNumber == this.state.blockNumber + 1) {
        const pendingBlock: Block = this.data.pendingBlock;
        await this.applyBlock(this.data.isLeft, pendingBlock);

        const allSignatures = [message.ackSignatures, this.data.pendingSignatures];
        if (this.data.isLeft) allSignatures.reverse();


        // verify signatures after the block is applied
        if (!(await this.ctx.verifyMessage(hash<ChannelState>(this.state), message.ackSignatures[0], this.otherUserAddress))) {
          throw new Error('Invalid verify pending block signature');
        }

        await this.storage.put({ state: this.state, block: pendingBlock, allSignatures: allSignatures });
        await this.save();

        this.data.mempool.splice(0, this.data.sentTransitions);
        console.log("Clear mempool ",this.data.mempool);
        this.data.sentTransitions = 0;
        this.data.pendingBlock = null;
      } else if (message.blockNumber == this.state.blockNumber && !this.data.isLeft) {
        this.data.pendingBlock = null;
        this.data.sentTransitions = 0;
        console.log("Rollback");
        this.data.rollbacks++;
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
      if (this.data.mempool.length > 0) {
        await this.flush()
      } else {
        await this.save();
      }
      return;
    }

    console.log("Receive ", this.isLeft(), message.block);

    const block: Block = message.block!;

    if (block.previousStateHash != hash<ChannelState>(this.state)) {
      console.log(decode(block.previousState), this.state);
      throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      throw new Error('Invalid previousBlockHash');
    }

    const data = this.data;

    await this.applyBlock(data.isLeft, block);

    // verify signatures after the block is applied
    if (!(await this.ctx.verifyMessage(hash<ChannelState>(this.state), message.newSignatures[0], this.otherUserAddress))) {
      throw new Error('Invalid verify new block signature');
    }

    const allSignatures = [message.ackSignatures, data.pendingSignatures];
    if (data.isLeft) allSignatures.reverse();


    await this.storage.put({ state: this.state, block: message.block!, allSignatures: allSignatures });
    
    await this.save();

    console.log("Sending flush back as ", this.isLeft)
    await this.flush();
  
  }

  async push(transition: Transition): Promise<void> {
    this.data.mempool.push(transition);
    console.log('Mempool', this.data.sentTransitions, this.data.mempool);
    return this.save();
  }

  
  async flush(): Promise<void> {
    //await sleep(0);
    if (this.data.sentTransitions > 0) {
      console.log("Already flushing ", this.data.isLeft, this.data.sentTransitions);
      return;
    }


    const message: IMessage = {
      header: {
        from: this.thisUserAddress,
        to: this.ctx.getRecipientAddress(),
      },
      body: (new BlockMessage(this.state.blockNumber, [], []) as BlockMessage)
    };

    const transitions = this.data.mempool.slice(0, BLOCK_LIMIT);
    // flush may or may not include new block
    if (transitions.length > 0) {
      const body = message.body as BlockMessage;
      
      // signed before block is applied
      body.ackSignatures = [await this.ctx.signMessage(hash<ChannelState>(this.state))];

      console.log("Flushing ", this.data.isLeft, this.state, transitions);
      const previousState: ChannelState = decode(encode(this.state));
      const block: Block = {
        isLeft: this.data.isLeft,
        timestamp: getTimestamp(),
        previousState: encode(previousState),
        previousStateHash: hash<ChannelState>(previousState), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockNumber: this.state.blockNumber,
        transitions: transitions,
      };

      await this.applyBlock(this.data.isLeft, block);


      console.log("block", block, this.data.pendingBlock);


      this.data.pendingBlock = decode(encode(block));
      this.data.sentTransitions = transitions.length;

      // signed after block is applied
      body.newSignatures = [await this.ctx.signMessage(hash<ChannelState>(this.state))];

      this.data.pendingSignatures = body.newSignatures

      // revert state to previous
      this.state = previousState;
      body.block = block;

    } 

    Logger.info(
      `channel send message from ${this.thisUserAddress} to ${this.otherUserAddress} with body ${message.body}`,
    );

    await this.save();


    console.log("Sending flush ", this.otherUserAddress, message, message);
  

    await this.ctx.user.send(this.otherUserAddress, message);
  }



  addCollateral(chainId: number, tokenId: number, isLeft: boolean, collateral: MoneyValue) : void {
    let delta = this.getSubchannelDelta(chainId, tokenId);
    if (!delta) {
      throw new Error(`TokenDelta with tokenId ${tokenId} not found.`);
      return;
    }

    delta.collateral += collateral;

    if(isLeft) {
      delta.offdelta += collateral;
    }
  }

  setCreditLimit(chainId: number, tokenId: number, isLeft: boolean, creditLimit: MoneyValue) : void {
    let delta = this.getSubchannelDelta(chainId, tokenId);
    if (!delta) {
      throw new Error(`TokenDelta with tokenId ${tokenId} not found.`);
      return;
    }

    if(isLeft) {
      delta.leftCreditLimit = creditLimit;
    }
    else {
      delta.rightCreditLimit = creditLimit;
    }
  }

  applyUnsafePayment(chainId: number, tokenId: number, isLeft: boolean, amount: MoneyValue) : void {
    let delta = this.getSubchannelDelta(chainId, tokenId);
    if (!delta) {
      console.log(`TokenDelta with tokenId ${tokenId} not found.`);
      return;
    }

    delta.offdelta += (isLeft ? -amount : amount);
  }

  private getSubchannelDelta(chainId: number, tokenId: number): TokenDelta | undefined {
    let subchannel = this.getSubchannel(chainId);
    if(!subchannel)
      return subchannel;

    return subchannel.deltas.find(delta => delta.tokenId === tokenId);
  }
}
