import ChannelState from '../types/ChannelState';
import IMessage from '../types/IMessage';

import Logger from '../utils/Logger';

import Block from '../types/Block';



import ENV from '../../test/env';
import { ethers, keccak256 } from 'ethers';
import { Depository__factory, SubcontractProvider__factory } from '../../contracts/typechain-types/index';

import { deepClone, getTimestamp } from '../utils/Utils';
import FlushMessage, {isValidFlushMessage} from '../types/Messages/FlushMessage';
import IChannelStorage from '../types/IChannelStorage';

import ChannelData from '../types/ChannelData';
import IChannelContext from '../types/IChannelContext';
import IChannel from '../types/IChannel';

import Transition from '../types/Transition';


import ChannelSavePoint from '../types/ChannelSavePoint';
import { createSubchannelData, Subchannel, TokenDelta } from '../types/Subchannel';

import { BigNumberish } from 'ethers';

import { decode, encode } from '../utils/Codec';

import {SubcontractBatchABI, ProofbodyABI} from '../types/ABI';


const coder = ethers.AbiCoder.defaultAbiCoder()
enum MessageType {
  CooperativeUpdate,
  CooperativeDisputeProof,
  DisputeProof
}
const BLOCK_LIMIT = 5;
import { sleep } from '../utils/Utils';
import { util } from 'chai';
import { keccak224 } from 'js-sha3';

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
    const state: ChannelState = {
      left: this.ctx.getUserAddress(),
      right: this.ctx.getRecipientAddress(),
      channelKey: '0x0',
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockNumber: 0,
      timestamp: 0,
      transitionNumber: 0,
      subchannels: []
    };

    if (this.ctx.getUserAddress() > this.ctx.getRecipientAddress()) {
      [state.left, state.right] = [state.right, state.left];
    }
    state.channelKey = ethers.solidityPackedKeccak256(['address', 'address'], [state.left, state.right]);
    return state;
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
    this.state.previousBlockHash = keccak256(encode(block));
    this.state.previousStateHash = keccak256(encode(this.state));
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

      if (message.pendingSignatures.length == 0) {
        throw new Error('Invalid pending signatures length');
      }

      // verify signatures after the block is applied
      const globalSig = message.pendingSignatures.pop() as string;
      if (!(await this.ctx.user.verifyMessage(keccak256(encode(this.state)), globalSig, this.otherUserAddress))) {
        this.state = previousState;
        throw new Error('Invalid verify pending block signature');
      }



      const historicalBlock = { state: this.state, block: pendingBlock, leftSignatures: message.pendingSignatures, rightSignatures: this.data.pendingSignatures };
      if (this.data.isLeft) {
        [historicalBlock.leftSignatures, historicalBlock.rightSignatures] = [historicalBlock.rightSignatures, historicalBlock.leftSignatures];
      }
      await this.storage.put(historicalBlock);
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
    if (!isValidFlushMessage(message)) { 
      console.log(message)
      throw new Error('Invalid FlushMessage');
    }


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

    if (block.previousStateHash != keccak256(encode(this.state))) {
      console.log(decode(block.previousState), this.state);
      throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      throw new Error('Invalid previousBlockHash');
    }


    await this.applyBlock(this.data.isLeft, block);

    // verify signatures after the block is applied
    if (!message.newSignatures || message.newSignatures.length == 0) {
      throw new Error('Invalid new signatures length');
    }
    const globalSig = message.newSignatures.pop() as string;
    if (!(await this.ctx.user.verifyMessage(keccak256(encode(this.state)), globalSig, this.otherUserAddress))) {
      console.log(block, this.state)
      throw new Error('Invalid verify new block signature');
    }
    // verify each subchannel proof


    const newProofs = await this.getSubchannelProofs();

    
    const historicalBlock = { state: this.state, block: message.block!, 
      leftSignatures: message.newSignatures, rightSignatures: newProofs.sigs
     }

    if (this.data.isLeft) {
      [historicalBlock.leftSignatures, historicalBlock.rightSignatures] = [historicalBlock.rightSignatures, historicalBlock.leftSignatures];
    }

      
    await this.storage.put(historicalBlock);
    
    //await this.save();

    console.log("Sending flush back as ", this.isLeft)
    await this.flush();
  }


  async getSubchannelProofs() {
    const state = this.state;
    const encodedProofBody: string[] = [];
    const proofhash: any[] = [];
    const sigs: string[] = [];

    const proofbody: any[] = [];

    // 1. Fill with deltas
    for (let i = 0; i < state.subchannels.length; i++) {
      let subch = state.subchannels[i];
      proofbody[i] = {
        offdeltas: [],
        tokenIds: [],
        subcontracts: []
      };

      for (let j = 0; j < subch.deltas.length; j++) {
        let d = subch.deltas[j];
        proofbody[i].offdeltas.push(d.offdelta);
        proofbody[i].tokenIds.push(d.tokenId);
      }

      // Handle subcontracts if any
      // This is a placeholder and should be implemented based on your specific requirements
      // proofbody[i].subcontracts = ...
    }
    
    for (let i = 0; i < state.subchannels.length; i++) {
      encodedProofBody[i] = coder.encode([(ProofbodyABI as unknown) as ethers.ParamType], [proofbody[i]]);

      const fullProof = [
        MessageType.DisputeProof,
        state.channelKey, 
        state.subchannels[i].cooperativeNonce,
        state.subchannels[i].disputeNonce,
        keccak256(encodedProofBody[i])
      ];

      const encoded_msg = coder.encode(
        ['uint8', 'bytes', 'uint', 'uint', 'bytes32'],
        fullProof
      );
      proofhash[i] = keccak256(encoded_msg);

      sigs[i] = await this.ctx.user.signer!.signMessage(proofhash[i]);
    }
    // add global state signature on top
    sigs.push(await this.ctx.user.signer!.signMessage(keccak256(encode(this.state))));

    return {
      encodedProofBody,
      proofbody,
      proofhash,
      sigs      
    };
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
      body: new FlushMessage(this.state.blockNumber, [])
    };

    // signed before block is applied
    const initialProofs = await this.getSubchannelProofs();
    const body = message.body as FlushMessage;
    body.pendingSignatures = initialProofs.sigs;

    const transitions = this.data.mempool.slice(0, BLOCK_LIMIT);
    // flush may or may not include new block
    if (transitions.length > 0) {
      
      console.log("Flushing ", this.data.isLeft, this.state, transitions);
      const previousState: ChannelState = decode(encode(this.state));
      const block: Block = {
        isLeft: this.data.isLeft,
        timestamp: getTimestamp(),
        previousState: encode(previousState),
        previousStateHash: keccak256(encode(previousState)), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockNumber: this.state.blockNumber,
        transitions: transitions,
      };

      await this.applyBlock(this.data.isLeft, block);


      console.log("block", block, this.data.pendingBlock);


      this.data.pendingBlock = decode(encode(block));
      this.data.sentTransitions = transitions.length;

      // signed after block is applied
      body.newSignatures = (await this.getSubchannelProofs()).sigs;
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



    public deriveDelta(chainId: number, tokenId: number, isLeft = true) {
      const d = this.getSubchannelDelta(chainId, tokenId) as TokenDelta;
      const delta = d.ondelta + d.offdelta
      const collateral = d.collateral
    
      const o = {
        delta: delta,
        collateral: collateral, 
    
        inCollateral: delta > collateral ? 0n : delta > 0n ? collateral - delta : collateral,
        outCollateral: delta > collateral ? collateral : delta > 0n ? delta : 0n,
    
        inOwnCredit: delta < 0n ? -delta : 0n,
        outPeerCredit: delta > collateral ? delta - collateral : 0n,
    
        inAllowence: d.rightAllowence,
        outAllowence: d.leftAllowence,
    
        totalCapacity: collateral + d.leftCreditLimit + d.rightCreditLimit,
        
        ownCreditLimit: d.leftCreditLimit,
        peerCreditLimit: d.rightCreditLimit,
        
        inCapacity: 0n,
        outCapacity: 0n,
        
        outOwnCredit: 0n,
    
        inPeerCredit: 0n,
        ascii: ''
      }
    
      if (!isLeft) {
        [o.outCollateral, o.outPeerCredit, o.inCollateral, o.inOwnCredit] = [o.inCollateral, o.inOwnCredit, o.outCollateral, o.outPeerCredit];
      }
    
      o.outOwnCredit = o.ownCreditLimit - o.inOwnCredit
      o.inPeerCredit = o.peerCreditLimit - o.outPeerCredit
    
      o.inCapacity = o.inOwnCredit + o.inCollateral + o.inPeerCredit - o.inAllowence
      o.outCapacity = o.outPeerCredit + o.outCollateral + o.outOwnCredit - o.outAllowence
        
      // ASCII visualization
      const totalWidth = Number(o.totalCapacity);
      const leftCreditWidth = Math.floor((Number(o.ownCreditLimit) / totalWidth) * 50);
      const collateralWidth = Math.floor((Number(collateral) / totalWidth) * 50);
      const rightCreditWidth = 50 - leftCreditWidth - collateralWidth;
      
      const deltaPosition = Math.floor(((Number(delta) + Number(o.ownCreditLimit)) / totalWidth) * 50);
      
      let ascii = '[';
      ascii += '-'.repeat(leftCreditWidth);
      ascii += '='.repeat(collateralWidth);
      ascii += '-'.repeat(rightCreditWidth);
      ascii += ']';
      
      ascii = ascii.substring(0, deltaPosition) + '|' + ascii.substring(deltaPosition + 1);

      o.ascii = ascii;
      return o
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
