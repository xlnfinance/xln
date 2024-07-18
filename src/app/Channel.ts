import ChannelState from '../types/ChannelState';
import IMessage from '../types/IMessage';

import Logger from '../utils/Logger';

import Block from '../types/Block';


import { deepClone, getTimestamp } from '../utils/Utils';
import FlushMessage from '../types/Messages/FlushMessage';
import IChannelStorage from '../types/IChannelStorage';
import hash from '../utils/Hash';
import ChannelData from '../types/ChannelData';
import IChannelContext from '../types/IChannelContext';
import IChannel from '../types/IChannel';

import Transition from '../types/Transition';


import ChannelSavePoint from '../types/ChannelSavePoint';
import { createSubchannelData, Subchannel, TokenDelta } from '../types/Subchannel';

import { BigNumberish } from 'ethers';

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
      subchannels: []
    };
  }

  private emptyData(): ChannelData {
    return {
      isLeft: this.ctx.getUserAddress() < this.ctx.getRecipientAddress(),
      rollbacks: 0,
      sentTransitions: 0,
      pendingBlock: null,
      mempool: [],
      pendingSignatures: []
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

  private async applyTransition(block: Block, transitionData: any): Promise<void> {

    let transition: Transition.Any;
    try {
      transition = Transition.createFromDecoded(transitionData);
    } catch (error: any) {
      Logger.error(`Invalid transition data: ${error.message}`);
      return;
    }

    Logger.info(`Applying transition: ${transition.type} ${transitionData.toString()}`);
    transition.apply(this);
    
    /*
    switch (transition.method) {
      case TransitionMethod.TextMessage:
        {
          Logger.info(transition.message);
        }
        break;
      case TransitionMethod.DirectPayment:
        {
          const d = this.getSubchannelDelta(transition.chainId, transition.tokenId);
          if(d) {
            Logger.info(`Processing PaymentTransition ${transition.chainId}`);
            d.offdelta += block.isLeft ? -transition.amount : transition.amount;
          }
        }
        break;
        case TransitionMethod.AddSubchannel:
        {
          const subchannel = this.addSubchannel(transition.chainId);
          Logger.info(`Processing CreateSubchannelTransition ${subchannel.chainId}`);
        }
        break;
     */
        /*
        case TransitionMethod.ProposedEvent:
        {
          const subchannel = this.getSubchannel(transition.chainId);
          if(subchannel) {
            Logger.info(`Processing ProposedEvent ${transition.chainId}`);

            if (subchannel.proposedEvents.length > 0) {
              if (subchannel.proposedEventsByLeft == block.isLeft) {
                // keep pushing
                subchannel.proposedEvents.push(transition);
              } else {
                if (encode(subchannel.proposedEvents[0]) == encode(transition)) {
                  // apply event
                  const event = subchannel.proposedEvents.shift();

                  const d = this.getSubchannelDelta(event.chainId, event.tokenId);
                  d?.collateral = event.collateral;
                  d?.ondelta = event.ondelta;

                }
              }
                
                
            } else {
              subchannel.proposedEvents.push(transition);
              subchannel.proposedEventsByLeft = block.isLeft;
            }
          }

        }
        break;
        
        case TransitionMethod.SetCreditLimit:
        {
          const tr = transition as SetCreditLimitTransition;
          //TODO handle errors if subchannel, token or smth was not found
          //this.setCreditLimit(tr.chainId, tr.tokenId, tr.isLeft, tr.creditLimit);
        }
          */
      //  break;
    //}

    this.state.transitionNumber++;
  }

  private async handlePendingBlock(message: FlushMessage): Promise<boolean> {
    if (message.blockNumber == this.state.blockNumber + 1) {
      const pendingBlock: Block = this.data.pendingBlock!;
      const previousState = decode(encode(this.state));

      await this.applyBlock(this.data.isLeft, pendingBlock);

      const allSignatures = [message.pendingSignatures, this.data.pendingSignatures];
      if (this.data.isLeft) allSignatures.reverse();

      // verify signatures after the block is applied
      if (!(await this.ctx.verifyMessage(hash<ChannelState>(this.state), message.pendingSignatures[0], this.otherUserAddress))) {
        this.state = previousState;
        throw new Error('Invalid verify pending block signature');
      }

      await this.storage.put({ state: this.state, block: pendingBlock, allSignatures: allSignatures });
      //await this.save();

      this.data.mempool.splice(0, this.data.sentTransitions);
      console.log("Clear mempool ",this.data.mempool);
      this.data.sentTransitions = 0;
      this.data.pendingBlock = null;
    } else if (message.blockNumber == this.state.blockNumber && !this.data.isLeft) {
      this.data.sentTransitions = 0;
      this.data.pendingBlock = null;
      console.log("Rollback");
      this.data.rollbacks++;
    } else {
      //
      return false;
    }
    

    //await this.save();
    return true;
  }

  async receive(message: FlushMessage): Promise<void> {
    console.log(`Receive ${this.thisUserAddress} from ${this.otherUserAddress}`, this.isLeft(), message);

    if (this.data.pendingBlock) {
      if (!await this.handlePendingBlock(message)) {
        return;
      }
    }
    

    if (!message.block) {
      if (this.data.mempool.length > 0) {
        await this.flush()
      } else {
        await this.save();
      }
      return;
    }


    const block: Block = message.block!;

    if (block.previousStateHash != hash<ChannelState>(this.state)) {
      console.log(decode(block.previousState), this.state);
      throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      throw new Error('Invalid previousBlockHash');
    }


    await this.applyBlock(this.data.isLeft, block);

    // verify signatures after the block is applied
    if (!(await this.ctx.verifyMessage(hash<ChannelState>(this.state), message.newSignatures[0], this.otherUserAddress))) {
      throw new Error('Invalid verify new block signature');
    }
    const ourNewSignatures = [await this.ctx.signMessage(hash<ChannelState>(this.state))];
    const allSignatures = [message.newSignatures, ourNewSignatures];

    if (this.data.isLeft) allSignatures.reverse();

    await this.storage.put({ state: this.state, block: message.block!, allSignatures: allSignatures });
    
    //await this.save();

    console.log("Sending flush back as ", this.isLeft)
    await this.flush();
  }

  async push(transition: Transition.Any): Promise<void> {
    this.data.mempool.push(transition);
    console.log('Mempool', this.data.sentTransitions, this.data.mempool);
    return this.save();
  }

  
  async flush(): Promise<void> {
    if (this.data.sentTransitions > 0) {
      console.log("Already flushing ", this.data.isLeft, this.data.sentTransitions);
      return;
    }


    const message: IMessage = {
      header: {
        from: this.thisUserAddress,
        to: this.ctx.getRecipientAddress(),
      },
      body: (new FlushMessage(this.state.blockNumber, [], []) as FlushMessage)
    };

    const transitions = this.data.mempool.slice(0, BLOCK_LIMIT);
    // flush may or may not include new block
    if (transitions.length > 0) {
      const body = message.body as FlushMessage;
      
      // signed before block is applied
      body.pendingSignatures = [await this.ctx.signMessage(hash<ChannelState>(this.state))];

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



  

  setCreditLimit(chainId: number, tokenId: number, isLeft: boolean, creditLimit: bigint) : void {
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

  applyUnsafePayment(chainId: number, tokenId: number, isLeft: boolean, amount: bigint) : void {
    let delta = this.getSubchannelDelta(chainId, tokenId);
    if (!delta) {
      console.log(`TokenDelta with tokenId ${tokenId} not found.`);
      return;
    }

    delta.offdelta += (isLeft ? -amount : amount);
  }

  public addSubchannel(chainId: number): Subchannel {
    let subchannel = this.getSubchannel(chainId);
    if(subchannel)
      return subchannel; //TODO мы тут должны возвращать существующий или кидать ошибку?
    
    subchannel = createSubchannelData(chainId, 1);
    this.state.subchannels.push(subchannel);

    return subchannel;
  }

  public getSubchannel(chainId: number): Subchannel | undefined {
    let subchannel = this.state.subchannels.find(subchannel => subchannel.chainId === chainId);
    return subchannel;
  }

  public getSubchannelDelta(chainId: number, tokenId: number): TokenDelta | undefined {
    let subchannel = this.getSubchannel(chainId);
    if(!subchannel)
      return;

    return subchannel.deltas.find(delta => delta.tokenId === tokenId);
  }
}
