import ChannelState, { StoredSubcontract } from '../types/ChannelState';
import IMessage from '../types/IMessage';

import Logger from '../utils/Logger';

import Block from '../types/Block';



import ENV from '../env';
import { ethers, keccak256 } from 'ethers';
import { Depository__factory, SubcontractProvider, SubcontractProvider__factory } from '../../contracts/typechain-types/index';

import { deepClone, getTimestamp } from '../utils/Utils';
import FlushMessage, {isValidFlushMessage} from '../types/Messages/FlushMessage';
import IChannelStorage from '../types/IChannelStorage';

import ChannelData from '../types/ChannelData';
import IChannelContext from '../types/IChannelContext';


import Transition from './Transition';
import { sleep } from '../utils/Utils';

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

  return JSON.stringify(obj, replacer, 1)
}

const coder = ethers.AbiCoder.defaultAbiCoder()
enum MessageType {
  CooperativeUpdate,
  CooperativeDisputeProof,
  DisputeProof
}
const BLOCK_LIMIT = 5;

interface SwapOrder {
  chainId: number;
  ownerIsLeft: boolean;
  addAmount: bigint;
  subAmount: bigint;
  tokenId: number;
  subTokenId: number;
}

import { encrypt, decrypt } from 'eciesjs';
import exp from 'constants';

export default class Channel {
  public state: ChannelState;
  public dryRunState?: ChannelState;

  public logger: Logger;
  thisUserAddress: string;
  otherUserAddress: string;  


  public data: ChannelData;
  public storage: IChannelStorage;

  constructor(
    public ctx: IChannelContext
  ) {

    if (this.ctx.getUserAddress() === this.ctx.getRecipientAddress()) {
      throw new Error('Cannot create channel with self');
    }

    this.thisUserAddress = this.ctx.getUserAddress();
    this.otherUserAddress = this.ctx.getRecipientAddress();
    this.storage = this.ctx.getStorage(`${this.otherUserAddress}`);

    this.logger = ctx.user.logger;

    this.state = this.emptyState();
    this.data = this.emptyData();

    this.state.subcontracts = [];

    this.logger.log("New channel constructed "+this.thisUserAddress, this.otherUserAddress);
  }



  private emptyState(): ChannelState {
    const state: ChannelState = {
      left: this.ctx.getUserAddress(),
      right: this.ctx.getRecipientAddress(),
      channelKey: '0x0',
      previousBlockHash: '0x0',
      previousStateHash: '0x0',
      blockId: 0,
      timestamp: 0,
      transitionId: 0,
      subchannels: [],
      subcontracts: []
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
      pendingSignatures: [],

      sendCounter: 0,
      receiveCounter: 0
    };
  }






  getState(): ChannelState {
    return this.state;
  }
  
  getId() {
    return `${this.thisUserAddress}:${this.otherUserAddress}`;
  }

  
  

  private async handlePendingBlock(message: FlushMessage): Promise<boolean> {
    if (message.blockId == this.state.blockId) {
      if (this.data.isLeft) {
        this.data.rollbacks++;
        this.logger.info("Rollbackon as Left: "+this.data.rollbacks)
        return false; // we ignore right's block
      } else {
        if (this.data.rollbacks == 0) {
          this.data.sentTransitions = 0;
          this.data.pendingBlock = null;
          //this.data.pendingSignatures = [];
          this.data.rollbacks++;
          this.logger.info("Rollbackon as Right: "+this.data.rollbacks)
          //this.logger.error("flushed after rollback")
          return true; // we *continue* with left's block, like our block never existed
        } else {
          this.logger.info("fatal Right rollbacks once: "+this.data.rollbacks)
          process.exit(1)
          return false; // we ignore right's block
        }
      }
    } else if (message.blockId == this.state.blockId + 1) {
      // they sign on our pending block
      if (this.data.rollbacks>0) {
        // they built block on top of ours 
        this.data.rollbacks--
        this.logger.log("Rollbackoff "+this.data.rollbacks)
      }

      if (message.pendingSignatures.length == 0) {
        this.logger.error('fatal: Invalid pending signatures length')
        throw new Error('Invalid pending signatures length');
      }
      const pendingBlock: Block = this.data.pendingBlock!;
      const previousState = decode(encode(this.state));

      // dryRun: true to only change .state and check if sigs are valid
      await this.applyBlock(pendingBlock, true); // <--- dryRun until signature verification
      const identical = encode(this.dryRunState!)

      let debugState: any;
      // verify signatures after the block is applied
      if (message.debugState) {
        debugState = decode(Buffer.from(message.debugState, 'hex'));
      }

      if (!await this.verifySignatures(message.pendingSignatures, true)) {
        this.logger.log('fatal verifysigpending', stringify(debugState), message, stringify(this.state), this.data.pendingBlock);

        //this.state = previousState;
        process.exit(1)
        throw new Error('fatal Invalid verify pending block signature');
        return false;
      }
      //this.state = previousState;
      
      await this.applyBlock(pendingBlock, false); // <--- now apply as block creator
      if (Buffer.compare(identical, encode(this.state)) != 0) {
        this.logger.log('fatal not! identical', decode(identical), this.state);
        process.exit(1);
      }

      const historicalBlock = { 
        state: this.state, 
        block: pendingBlock, 
        leftSignatures: message.pendingSignatures, 
        rightSignatures: this.data.pendingSignatures 
      };
      if (this.data.isLeft) {
        [historicalBlock.leftSignatures, historicalBlock.rightSignatures] = [historicalBlock.rightSignatures, historicalBlock.leftSignatures];
      }
      await this.storage.put(historicalBlock);


      let mempool = this.ctx.user.mempoolMap.get(this.otherUserAddress)!
      if (mempool === undefined) {
        mempool = [];
      }
      this.logger.log('mempol before', mempool)
      mempool.splice(0, this.data.sentTransitions);
      this.logger.info("Clear finalized transitions from mempool ",mempool);
      this.logger.log('mempol now', mempool)

      this.data.sentTransitions = 0;
      this.data.pendingBlock = null;
      this.data.pendingSignatures = [];
      //this.data.rollbacks = 0;

      this.logger.logState(this.channelId, this.state);
      await this.save();
      return true;


    } 
    this.logger.error('fatal unexpected handle pending block');
  
    return false;
  }

  get isLeft(): boolean {
    return this.data.isLeft;
  }

  get channelId(): string {
    let tags = ['(L)', '(R)'];
    if (!this.data.isLeft) { tags.reverse(); }
    const toName = (addr:string) => {
      return ENV.profiles[addr] ? ENV.profiles[addr].name+" "+addr.substring(2,6) : addr;
    }
    
    return `${toName(this.thisUserAddress)}${tags[0]}---${toName(this.otherUserAddress)}${tags[1]}`;
  }

  async onready(timeout: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.data.sentTransitions === 0) {
        resolve();
        return;
      }
  
      const checkInterval = 50; // Check every 50ms
      let elapsedTime = 0;
  
      const timer = setInterval(() => {
        if (this.data.sentTransitions === 0) {
          clearInterval(timer);
          resolve();
        } else if (elapsedTime >= timeout) {
          clearInterval(timer);
          reject(new Error('Timeout waiting for flush to complete'));
        }
        elapsedTime += checkInterval;
      }, checkInterval);
    });
  }



  async verifySignatures(sigs: string[], dryRun: boolean): Promise<boolean> {
    sigs = structuredClone(sigs);
    let state
    if (dryRun) {
      if (!this.dryRunState) throw new Error('Invalid dryRunState verify');
      state = structuredClone(this.dryRunState!);
    } else {
      state = structuredClone(this.state);
    }

    const globalSig = sigs.pop() as string;
    if (!(await this.ctx.user.verifyMessage(keccak256(encode(state)), globalSig, this.otherUserAddress))) {
      this.logger.log('Invalid verify global signature');
      return false
    }
    // verify each subchannel proof
    const proofs = await this.getSubchannelProofs(dryRun);
    if (proofs.sigs.length != sigs.length + 1) {
      throw new Error('Invalid verify subchannel length');
      return false;
    }

    for (let i = 0; i < proofs.proofhash.length; i++) {
      if (!(await this.ctx.user.verifyMessage(proofs.proofhash[i], sigs[i], this.otherUserAddress))) {
        this.logger.log('invalid proofs',sigs, proofs)
        throw new Error('Invalid verify subchannel signature');
        return false;
        //throw new Error('Invalid verify subchannel proof signature '+i);
      }
    }
    return true;
  }
  
  async receive(message: FlushMessage): Promise<void> {
    this.logger.logState(this.channelId, this.state);

    if (!isValidFlushMessage(message)) { 
      this.logger.log(message)
      throw new Error('Invalid FlushMessage');
    }


    let debugState: any;
    // verify signatures after the block is applied
    if (message.debugState) {
      debugState = decode(Buffer.from(message.debugState, 'hex'));
    }

    this.logger.log(`Receive msg ${message.counter} ${this.channelId} `, message);
    if (this.data.pendingBlock) {
      if (await this.handlePendingBlock(message)) {
        this.logger.log('pending block handled, continue');
        //return;
      } else {
        //this.logger.log('rollback as left! or error, halt');
        return;
      }
    }

    if (message.blockId != this.state.blockId) {


      this.logger.log(`fatal blockId mismatch #${message.counter} ${this.data.receiveCounter}/${this.data.sendCounter} ${this.channelId}`)
      console.log(stringify(debugState.blockId), message.blockId, stringify(this.state.blockId), this.data.pendingBlock);

      //process.exit(1)
      //return
    }
    

    if (!message.block) {
      this.logger.log('no msg block ',message);

      const mempool = this.ctx.user.mempoolMap.get(this.otherUserAddress)!;
      if (mempool && mempool.length > 0) {
        this.logger.log('memopl ',mempool,this.state);

        await this.ctx.user.addToFlushable(this.otherUserAddress) // todo dont flush inside section
      } else {
        await this.save();
      }
      return;
    }

    this.logger.log('verifying block');

    const block: Block = message.block!;
    if (block.isLeft == this.isLeft) {
      this.logger.log('fatal impersonation attempt');
      return
    }


    if (block.previousStateHash != keccak256(encode(this.state))) {
      this.logger.log('fatal prevhashstate', stringify(debugState), block, stringify(this.state), this.data.pendingBlock);
      throw new Error(`Invalid previousStateHash: ${this.ctx.user.toTag()} ${block.previousStateHash} ${debugState.blockId} vs ${this.state.blockId}`);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      this.logger.log('fatal prevhashblock', debugState, this.state);
      throw new Error('Invalid previousBlockHash');
    }

    if (block.isLeft == this.isLeft) {
      throw new Error('Invalid isLeft');
    }

    const stateBeforeDryRun = decode(encode(this.state));
    await this.applyBlock(block, true);
    //this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

    
    // verify signatures after the block is applied
    if (!message.newSignatures || message.newSignatures.length == 0) {
      throw new Error('Invalid new signatures length');
    }

    if (!await this.verifySignatures(message.newSignatures, true)) {
      this.logger.log('fatal verifysig', stringify(debugState), block, stringify(this.state), this.data.pendingBlock);
      throw new Error('Invalid verify new block signature');
    }


    this.state = stateBeforeDryRun;
    await this.applyBlock(block, false);


    const newProofs = await this.getSubchannelProofs(false);

    
    const historicalBlock = { state: this.state, block: message.block!, 
      leftSignatures: message.newSignatures, rightSignatures: newProofs.sigs
     }
    if (this.data.isLeft) {
      [historicalBlock.leftSignatures, historicalBlock.rightSignatures] = [historicalBlock.rightSignatures, historicalBlock.leftSignatures];
    }
    await this.storage.put(historicalBlock);
    
    await this.save();

    this.logger.logState(this.channelId, this.state);
    this.logger.info(`Sending flush back ${this.channelId}`)

    return this.ctx.user.addToFlushable(this.otherUserAddress);
  }


  

  async getSubchannelProofs(dryRun: boolean) {
    let state;
    if (dryRun) {
      state = this.dryRunState!;
      delete this.dryRunState;
    } else {
      state = this.state;
    }

    const encodedProofBody: string[] = [];
    const proofhash: any[] = [];
    const sigs: string[] = [];
    const subcontractBatch: SubcontractProvider.BatchStruct[] = [];

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

      // Build subcontracts for this subchannel
      subcontractBatch[i] = {
        payment: [],
        swap: []
      };

    }

    // mapping subcontracts to respective subchannels
    // figure out deltaIndexes that subcontractprovider uses internally from tokenIds
    state.subcontracts.forEach((storedSubcontract: StoredSubcontract) => {
        const subcontract = storedSubcontract.originalTransition as Transition.AddPayment | Transition.AddSwap;

        const subchannelIndex = state.subchannels.findIndex(subchannel => subchannel.chainId === subcontract.chainId);
        if (subchannelIndex < 0) {
          throw new Error(`Subchannel with chainId ${subcontract.chainId} not found.`);
        }

        const deltaIndex = state.subchannels[subchannelIndex].deltas.findIndex(delta => delta.tokenId === subcontract.tokenId);
        if (deltaIndex < 0) {
          throw new Error(`Delta with tokenId ${subcontract.tokenId} not found.`);
        }

        if (subcontract.type === 'AddPayment') {
          subcontractBatch[subchannelIndex].payment.push({
            deltaIndex: deltaIndex,
            amount: subcontract.amount,
            revealedUntilBlock: subcontract.timelock,
            hash: subcontract.hashlock,
          });
        } else if (subcontract.type === 'AddSwap') {
          const subTokenIndex = state.subchannels[subchannelIndex].deltas.findIndex(delta => delta.tokenId === subcontract.subTokenId);
          subcontractBatch[subchannelIndex].swap.push({
            ownerIsLeft: subcontract.ownerIsLeft,
            addDeltaIndex: deltaIndex,
            addAmount: subcontract.addAmount,
            subDeltaIndex: subTokenIndex,
            subAmount: subcontract.subAmount,
          });

        }
      
      });


    


    for (let i = 0; i < state.subchannels.length; i++) {
      const encodedBatch = ethers.AbiCoder.defaultAbiCoder().encode(
        [(SubcontractBatchABI as unknown) as ethers.ParamType],
        [subcontractBatch[i]]
      );

      proofbody[i].subcontracts.push({
        subcontractProviderAddress: ENV.subcontractProviderAddress,
        encodedBatch: encodedBatch,
        allowences: [] // Implement allowance logic if needed
      });



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
    sigs.push(await this.ctx.user.signer!.signMessage(keccak256(encode(state))));

    return {
      encodedProofBody,
      subcontractBatch,
      proofbody,
      proofhash,
      sigs      
    };
  }

  
  async flush(): Promise<void> {
    const identical = encode(this.state)

    if (this.data.sentTransitions > 0) {
      this.logger.log(`Already flushing ${this.channelId} blockid ${this.state.blockId}`);
      return;
    }
    const message: IMessage = {
      header: {
        from: this.thisUserAddress,
        to: this.otherUserAddress,
      },
      body: new FlushMessage(this.state.blockId, [])
    };
    

    // signed before block is applied
    const initialProofs = await this.getSubchannelProofs(false);
    const body = message.body as FlushMessage;
    body.debugState = encode(this.state).toString('hex');
    body.pendingSignatures = initialProofs.sigs;

    if (body.pendingSignatures.length != this.state.subchannels.length + 1) {
      throw new Error('fatal: Invalid pending signatures length');
    }
    const mempool = this.ctx.user.mempoolMap.get(this.otherUserAddress);

    // flush may or may not include new block
    if (mempool && mempool.length > 0) {
      const transitions = mempool.slice(0, BLOCK_LIMIT);

      const previousState: ChannelState = decode(encode(this.state));

      const block: Block = {
        isLeft: this.data.isLeft,
        timestamp: getTimestamp(),
        previousStateHash: keccak256(encode(previousState)), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockId: this.state.blockId,
        transitions: transitions,
      };

      if (Buffer.compare(identical, encode(this.state)) != 0) {
        this.logger.log('fatal3 not identical', decode(identical), this.state);
        process.exit(1);
      }
      //this.logger.log('State before applying block:'+this.thisUserAddress, stringify(this.state));
      //this.logger.log(123, this.state)
      await this.applyBlock(block, true); // <--- only dryRun

      let expectedLength = this.dryRunState!.subchannels.length + 1;
      //this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

      //this.logger.log("block", block, this.data.pendingBlock);


      this.data.pendingBlock = decode(encode(block));
      this.data.sentTransitions = transitions.length;

      // signed after block is applied
      body.newSignatures = (await this.getSubchannelProofs(true)).sigs;
      if (expectedLength != body.newSignatures.length) {
        throw new Error('invalid sig len')
      }
      this.data.pendingSignatures = body.newSignatures
      // revert state to previous
      //this.state = previousState; // <--- revert state
      body.block = block;

      if (Buffer.compare(identical, encode(this.state)) != 0) {
        this.logger.log('fatal not2 identical', decode(identical), this.state);
        process.exit(1);
      }
      if (body.newSignatures.length != expectedLength) {
        throw new Error('fatal: Invalid pending signatures length');
      }

    } 

    this.logger.info(
      `Flush ${this.channelId} with block ${!!message.body.block}`,
    );

    if (Buffer.compare(identical, encode(this.state)) != 0) {
      this.logger.log('fatal5 not identical', decode(identical), this.state);
      process.exit(1);
    }

    await this.save();

    if (Buffer.compare(identical, encode(this.state)) != 0) {
      this.logger.log('fatal4 not identical', decode(identical), this.state);
      process.exit(1);
    }
    message.body.counter = ++this.data.sendCounter;


    if (Buffer.compare(identical, encode(this.state)) != 0) {
      this.logger.log('fatal not identical', decode(identical), this.state);
      process.exit(1);
    }

    await this.ctx.user.send(this.otherUserAddress, message);
  }

    // return various derived values of delta: inbound/outbound capacity, credit etc
    public deriveDelta(chainId: number, tokenId: number, isLeft: boolean): any {
      const d = this.getDelta(chainId, tokenId, false) as Delta;

      const nonNegative = (x: bigint) => x < 0n ? 0n : x;

      const delta = d.ondelta + d.offdelta;
      const collateral = nonNegative(d.collateral);

      let ownCreditLimit = d.leftCreditLimit;
      let peerCreditLimit = d.rightCreditLimit;
      
      let inCollateral = delta > 0n ? nonNegative(collateral - delta) : collateral;
      let outCollateral = delta > 0n ? (delta > collateral ? collateral : delta) : 0n;


      let inOwnCredit = nonNegative(-delta);
      if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;

      let outPeerCredit = nonNegative(delta - collateral);
      if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;
    
      let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
      let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);
    
      let inAllowence = d.rightAllowence;
      let outAllowence = d.leftAllowence;
    
      const totalCapacity = collateral + ownCreditLimit + peerCreditLimit;
    
      let inCapacity = nonNegative(inOwnCredit + inCollateral + inPeerCredit - inAllowence);
      let outCapacity = nonNegative(outPeerCredit + outCollateral + outOwnCredit - outAllowence);
    
      if (!isLeft) {
        // flip the view


        [inCollateral, inAllowence, inCapacity,
         outCollateral, outAllowence, outCapacity] = 
        [outCollateral, outAllowence, outCapacity,
         inCollateral, inAllowence, inCapacity];

        [ownCreditLimit, peerCreditLimit] = [peerCreditLimit, ownCreditLimit];
        // swap in<->out own<->peer credit
        [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] = 
        [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
    }

  
    
      // ASCII visualization (using number conversion only for display purposes)
      const totalWidth = Number(totalCapacity);
      const leftCreditWidth = Math.floor((Number(ownCreditLimit) / totalWidth) * 50);
      const collateralWidth = Math.floor((Number(collateral) / totalWidth) * 50);
      const rightCreditWidth = 50 - leftCreditWidth - collateralWidth;
      const deltaPosition = Math.floor(((Number(delta) + Number(ownCreditLimit)) / totalWidth) * 50);
    
      const ascii = 
        '[' + 
        '-'.repeat(leftCreditWidth) +
        '='.repeat(collateralWidth) +
        '-'.repeat(rightCreditWidth) +
        ']'.substring(0, deltaPosition) + 
        '|' + 
        ']'.substring(deltaPosition + 1);
    
      return {
        delta,
        collateral,
        inCollateral,
        outCollateral,
        inOwnCredit,
        outPeerCredit,
        inAllowence,
        outAllowence,
        totalCapacity,
        ownCreditLimit,
        peerCreditLimit,
        inCapacity,
        outCapacity,
        outOwnCredit,
        inPeerCredit,
        ascii
      };    
    }
    
    



  public getDelta(chainId: number, tokenId: number, dryRun: boolean): Delta | undefined {
    const subchannel = this.getSubchannel(chainId, dryRun);
    const delta = subchannel?.deltas.find(delta => delta.tokenId === tokenId);

    return delta;
  }
  
  public getSubchannel(chainId: number, dryRun: boolean): Subchannel | undefined {
    //this.logger.log('Getting subchannel. Current subchannels:', stringify(this.state.subchannels));
    const subchannel = (dryRun ? this.dryRunState! : this.state).subchannels.find(subchannel => subchannel.chainId === chainId);
    //this.logger.log(`Getting subchannel ${chainId}:`, stringify(subchannel));
    return subchannel;
  }

  private async applyBlock(block: Block, dryRun: boolean): Promise<void> {
    let state;
    if (dryRun) {
      this.dryRunState = structuredClone(this.state);
      state = this.dryRunState;
    } else {
      state = this.state;
    }

    // save previous hash first before changing this.state
    state.previousStateHash = keccak256(encode(state));

    state.blockId++;
    state.timestamp = block.timestamp;
    state.previousBlockHash = keccak256(encode(block));

    for (let i = 0; i < block.transitions.length; i++) {
      await this.applyTransition(block, block.transitions[i], dryRun);
    }
    if (!dryRun) {
      this.logger.log(`applyblock ${this.channelId} ${state.blockId} ${state.previousBlockHash}`);
    }

  }
 

  private async applyTransition(block: Block, transitionData: any, dryRun: boolean): Promise<void> {
    let transition: Transition.Any;
    let state;
    if (dryRun) {
      state = this.dryRunState!;
    } else {
      state = this.state;
    }


      state.transitionId++;
    //try {
      transition = Transition.createFromDecoded(transitionData) as Transition.Any;
    //} catch (error: any) {
    //  this.logger.error(`Invalid transition data: ${error.message}`);
    //  return;
    //}
     //if (!dryRun){
      this.logger.debug(`applyTr${dryRun} ${transition.type}`+this.thisUserAddress, stringify(transition));
     //}
    
    //try{
    await transition.apply(this, block, dryRun);
   // } catch(e){
     // this.logger.log(e);
     // this.logger.debug('fatal in applytransiton', e);
     // throw(e);
    //}
    this.logger.log('State after applying transition:'+this.thisUserAddress, stringify(state));
    
  }

  async save(): Promise<void> {
    const channelSavePoint: ChannelSavePoint = {
      data: this.data,
      state: this.state
    };

    //this.logger.log("Saving state"+this.thisUserAddress, this.data.isLeft, stringify(channelSavePoint), new Date());

    await this.storage.setValue<ChannelSavePoint>('channelSavePoint', channelSavePoint);
    //this.logger.log("State saved successfully "+this.thisUserAddress);
  }

  async load(): Promise<void> {
    try {
      const channelSavePoint = await this.storage.getValue<ChannelSavePoint>('channelSavePoint');
      this.data = channelSavePoint.data;
      this.state = channelSavePoint.state;
      //this.logger.log("Loaded last state "+this.thisUserAddress, stringify(this.state));
    } catch (e) {
      //this.logger.log("Load error", e);
      await this.save(); // Initialize with empty state if load fails
    }
  }

  async receiveMessage(encryptedMessage: string): Promise<void> {
    const decryptedMessage = await this.ctx.user.decryptMessage(this.otherUserAddress, encryptedMessage);
    this.logger.log(`Decrypted ${this.getId()}: ${decryptedMessage}`);
  }

  getBalance(): bigint { 
    return 123n;
  }

}