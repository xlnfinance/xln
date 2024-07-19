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


import Transition from './Transition';


import ChannelSavePoint from '../types/ChannelSavePoint';
import { createSubchannelData, Subchannel, Delta } from '../types/Subchannel';

import { BigNumberish } from 'ethers';

import { decode, encode } from '../utils/Codec';

import {SubcontractBatchABI, ProofbodyABI} from '../types/ABI';

export function stringify(obj: any) {
  function replacer(key: string, value: any) {
    if (typeof value === 'bigint') {
        return value.toString() + 'n';  // indicate that this is a BigInt
    }
    return value;
  }

  return JSON.stringify(obj, replacer, 4)
}

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

export default class Channel {
  public state: ChannelState;
  public logger: Logger;
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

    this.logger = new Logger(this.thisUserAddress);

    this.state = this.emptyState();
    this.data = this.emptyData();

    this.logger.log("New channel constructed "+this.thisUserAddress, this.otherUserAddress);
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






  getState(): ChannelState {
    return this.state;
  }
  
  getId() {
    return `${this.thisUserAddress}:${this.otherUserAddress}`;
  }

  
  private async applyBlock(isLeft: boolean, block: Block, dryRun: boolean): Promise<void> {
    this.logger.info(`applyBlock ${block.isLeft} isLeft ${isLeft}}`);

    // save previous hash first before changing this.state
    this.state.blockNumber++;
    this.state.timestamp = block.timestamp;
    this.state.previousBlockHash = keccak256(encode(block));
    this.state.previousStateHash = keccak256(encode(this.state));
    for (let i = 0; i < block.transitions.length; i++) {
      const transition = block.transitions[i];
      await this.applyTransition(block, transition, dryRun);
    }
  }
 
  

  private async handlePendingBlock(message: FlushMessage): Promise<boolean> {
    if (message.blockNumber == this.state.blockNumber + 1) {
      const pendingBlock: Block = this.data.pendingBlock!;
      const previousState = decode(encode(this.state));

      await this.applyBlock(this.data.isLeft, pendingBlock, true);

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

      this.data.mempool.splice(0, this.data.sentTransitions);
      this.logger.log("Clear mempool ",this.data.mempool);
      this.data.sentTransitions = 0;
      this.data.pendingBlock = null;
      this.data.pendingSignatures = [];

      await this.save();

    } else if (message.blockNumber == this.state.blockNumber && !this.data.isLeft) {
      this.data.sentTransitions = 0;
      this.data.pendingBlock = null;
      this.logger.log("Rollback");
      this.data.rollbacks++;
    } else {
      //
      return false;
    }
    

    await this.save();
    return true;
  }

  

  get isLeft(): boolean {
    return this.data.isLeft;
  }
  
  async receive(message: FlushMessage): Promise<void> {
    if (!isValidFlushMessage(message)) { 
      this.logger.log(message)
      throw new Error('Invalid FlushMessage');
    }


    this.logger.log(`Receive ${this.thisUserAddress} from ${this.otherUserAddress}`, this.data.isLeft, message);

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
      this.logger.log(decode(block.previousState), this.state);
      throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      throw new Error('Invalid previousBlockHash');
    }

    const stateBeforeDryRun = structuredClone(this.state);
    await this.applyBlock(this.data.isLeft, block, true);
    this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

    // verify signatures after the block is applied
    if (!message.newSignatures || message.newSignatures.length == 0) {
      throw new Error('Invalid new signatures length');
    }
    const globalSig = message.newSignatures.pop() as string;
    if (!(await this.ctx.user.verifyMessage(keccak256(encode(this.state)), globalSig, this.otherUserAddress))) {
      this.logger.log(block, this.state)
      throw new Error('Invalid verify new block signature');
    }
    // verify each subchannel proof


    this.state = stateBeforeDryRun;
    await this.applyBlock(this.data.isLeft, block, false);


    const newProofs = await this.getSubchannelProofs();

    
    const historicalBlock = { state: this.state, block: message.block!, 
      leftSignatures: message.newSignatures, rightSignatures: newProofs.sigs
     }

    if (this.data.isLeft) {
      [historicalBlock.leftSignatures, historicalBlock.rightSignatures] = [historicalBlock.rightSignatures, historicalBlock.leftSignatures];
    }

      
    await this.storage.put(historicalBlock);
    
    //await this.save();

    this.logger.log("Sending flush back as ", this.data.isLeft)
    await this.flush();
  }


  async getSubchannelProofs() {
    const state = this.state;
    const encodedProofBody: string[] = [];
    const proofhash: any[] = [];
    const sigs: string[] = [];

    const proofbody: any[] = [];

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

      // Handle subcontracts
      for (let j = 0; j < subch.subcontracts.length; j++) {
        const subcontract = subch.subcontracts[j];
        const encodedBatch = ethers.AbiCoder.defaultAbiCoder().encode(
          [(SubcontractBatchABI as unknown) as ethers.ParamType],
          [{
            payment: subcontract.payment,
            swap: subcontract.swap
          }]
        );
        proofbody[i].subcontracts.push({
          subcontractProviderAddress: ENV.subcontractProviderAddress, // You need to add this to your options
          encodedBatch: encodedBatch,
          allowences: [] // You may need to implement allowance logic
        });
      }
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
    this.logger.log('Mempool', this.data.sentTransitions, this.data.mempool);
    return this.save();
  }

  
  async flush(): Promise<void> {
    if (this.data.sentTransitions > 0) {
      this.logger.log("Already flushing ", this.data.isLeft, this.data.sentTransitions);
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
      
      const previousState: ChannelState = decode(encode(this.state));

      const block: Block = {
        isLeft: this.data.isLeft,
        timestamp: getTimestamp(),
        previousState: encode({}),
        previousStateHash: keccak256(encode(previousState)), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockNumber: this.state.blockNumber,
        transitions: transitions,
      };

      this.logger.log('State before applying block:'+this.thisUserAddress, stringify(this.state));
      await this.applyBlock(this.data.isLeft, block, true);
      this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

      this.logger.log("block", block, this.data.pendingBlock);


      this.data.pendingBlock = decode(encode(block));
      this.data.sentTransitions = transitions.length;

      // signed after block is applied
      body.newSignatures = (await this.getSubchannelProofs()).sigs;
      this.data.pendingSignatures = body.newSignatures

      // revert state to previous
      this.state = previousState;
      body.block = block;

    } 

    this.logger.info(
      `channel send message from ${this.thisUserAddress} to ${this.otherUserAddress} with body ${message.body}`,
    );

    await this.save();


    this.logger.log("Sending flush ", this.otherUserAddress, message, message);
  

    await this.ctx.user.send(this.otherUserAddress, message);
  }



    public deriveDelta(chainId: number, tokenId: number, isLeft = true) {
      const d = this.getDelta(chainId, tokenId) as Delta;
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
    let delta = this.getDelta(chainId, tokenId);
    if (!delta) {
      throw new Error(`Delta with tokenId ${tokenId} not found.`);
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
    let delta = this.getDelta(chainId, tokenId);
    if (!delta) {
      this.logger.log(`Delta with tokenId ${tokenId} not found.`);
      return;
    }

    delta.offdelta += (isLeft ? -amount : amount);
  }



  public getDelta(chainId: number, tokenId: number): Delta | undefined {
    const subchannel = this.getSubchannel(chainId);
    const delta = subchannel?.deltas.find(delta => delta.tokenId === tokenId);

    return delta;
  }

  
  public getSubchannel(chainId: number): Subchannel | undefined {
    this.logger.log('Getting subchannel. Current subchannels:', stringify(this.state.subchannels));
    const subchannel = this.state.subchannels.find(subchannel => subchannel.chainId === chainId);
    this.logger.log(`Getting subchannel ${chainId}:`, stringify(subchannel));
    return subchannel;
  }

  private async applyTransition(block: Block, transitionData: any, dryRun: boolean): Promise<void> {
    let transition: Transition.Any;
    try {
      transition = Transition.createFromDecoded(transitionData);
    } catch (error: any) {
      this.logger.error(`Invalid transition data: ${error.message}`);
      return;
    }

    this.logger.log(`Applying transition: ${transition.type}`+this.thisUserAddress, stringify(transition));
    transition.apply(this, block.isLeft, dryRun);
    this.logger.log('State after applying transition:'+this.thisUserAddress, stringify(this.state));
    
    this.state.transitionNumber++;
  }



  async save(): Promise<void> {
    const channelSavePoint: ChannelSavePoint = {
      data: this.data,
      state: this.state
    };

    this.logger.log("Saving state"+this.thisUserAddress, this.data.isLeft, stringify(channelSavePoint), new Date());

    await this.storage.setValue<ChannelSavePoint>('channelSavePoint', channelSavePoint);
    this.logger.log("State saved successfully"+this.thisUserAddress);
  }

  async load(): Promise<void> {
    try {
      const channelSavePoint = await this.storage.getValue<ChannelSavePoint>('channelSavePoint');
      this.data = channelSavePoint.data;
      this.state = channelSavePoint.state;
      this.logger.log("Loaded last state "+this.thisUserAddress, stringify(this.state));
    } catch (e) {
      this.logger.log("Load error", e);
      await this.save(); // Initialize with empty state if load fails
    }
  }
}
