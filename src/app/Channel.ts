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

interface SwapOrder {
  chainId: number;
  ownerIsLeft: boolean;
  addAmount: bigint;
  subAmount: bigint;
  tokenId: number;
  subTokenId: number;
}

import { encrypt, decrypt } from 'eciesjs';

export default class Channel {
  public state: ChannelState;
  public logger: Logger;
  thisUserAddress: string;
  otherUserAddress: string;  


  public data: ChannelData;
  public storage: IChannelStorage;

  constructor(
    public ctx: IChannelContext
  ) {

    this.thisUserAddress = this.ctx.getUserAddress();
    this.otherUserAddress = this.ctx.getRecipientAddress();
    this.storage = this.ctx.getStorage(`${this.otherUserAddress}`);

    this.logger = new Logger(this.thisUserAddress);

    this.state = this.emptyState();
    this.data = this.emptyData();

    this.state.subcontracts = [];
    this.data.subcontracts = new Map();
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
      subcontracts: new Map(),
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

  
  

  private async handlePendingBlock(message: FlushMessage): Promise<boolean> {
    if (message.blockId == this.state.blockId + 1) {
      const pendingBlock: Block = this.data.pendingBlock!;
      const previousState = decode(encode(this.state));

      // dryRun: true to only change .state and check if sigs are valid
      console.log('beforehandl',this.state)
      await this.applyBlock(pendingBlock.isLeft, pendingBlock, true); // <--- dryRun until signature verification
      console.log('afterhandl',this.state)

      if (message.pendingSignatures.length == 0) {
        throw new Error('Invalid pending signatures length');
      }
      let debugState: any;
      // verify signatures after the block is applied
      if (message.debugState) {
        debugState = decode(Buffer.from(message.debugState, 'hex'));
      }

      this.logger.log('debug pending state', this.channelId, stringify(debugState), stringify(this.state))


      if (!await this.verifySignatures(message.pendingSignatures)) {
        this.state = previousState;
        throw new Error('Invalid verify pending block signature');
        return false;
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
      //this.data.rollbacks = 0;

      await this.save();
      return true;


    } else if (message.blockId == this.state.blockId) {
      if (this.data.isLeft) {
        console.log("no rollback as left");
        //throw new Error('left doesnt rollback');
        return false;
      } else {
        console.log("rollback as Right")
        this.data.sentTransitions = 0;
        this.data.pendingBlock = null;
        this.logger.log("Rollback");
        this.data.rollbacks++;
        await this.save();
        return false;
      }
    } else {
      throw new Error('fatal weird');
    }
    await this.save();

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
    
    return `${tags[0]}${toName(this.thisUserAddress)}---${this.state.blockId}.${this.state.transitionId}---${tags[1]}${toName(this.otherUserAddress)}`;
  }

  async verifySignatures(sigs: string[]): Promise<boolean> {
    const globalSig = sigs.pop() as string;
    if (!(await this.ctx.user.verifyMessage(keccak256(encode(this.state)), globalSig, this.otherUserAddress))) {

      throw new Error('Invalid verify global signature');
      return false
    }
    // verify each subchannel proof
    const proofs = await this.getSubchannelProofs();
    if (proofs.sigs.length != sigs.length + 1) {
      throw new Error('Invalid verify subchannel length');
      return false;
    }

    for (let i = 0; i < proofs.proofhash.length; i++) {
      if (!(await this.ctx.user.verifyMessage(proofs.proofhash[i], sigs[i], this.otherUserAddress))) {
        console.log(sigs, proofs)
        throw new Error('Invalid verify subchannel signature');
        return false;
        //throw new Error('Invalid verify subchannel proof signature '+i);
      }
    }
    return true;
  }
  
  async receive(message: FlushMessage): Promise<void> {
    if (!isValidFlushMessage(message)) { 
      this.logger.log(message)
      throw new Error('Invalid FlushMessage');
    }


    this.logger.log(`Receive ${this.channelId}`, message);

    if (this.data.pendingBlock) {
      if (!await this.handlePendingBlock(message)) {
        // don't throw, rollback is normal
        //throw new Error("Invalid handle pending block");
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
      this.logger.log(decode(Buffer.from(message.debugState as any,'hex')), this.state);
      throw new Error('Invalid previousStateHash: ' + block.previousStateHash);
    }

    if (block.previousBlockHash != this.state.previousBlockHash) {
      throw new Error('Invalid previousBlockHash');
    }

    if (block.isLeft == this.isLeft) {
      throw new Error('Invalid isLeft');
    }

    const stateBeforeDryRun = structuredClone(this.state);
    await this.applyBlock(block.isLeft, block, true);
    //this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

    // verify signatures after the block is applied
    if (!message.newSignatures || message.newSignatures.length == 0) {
      throw new Error('Invalid new signatures length');
    }

    if (!await this.verifySignatures(message.newSignatures)) {
      throw new Error('Invalid verify new block signature');
    }


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
      this.state.subcontracts.forEach((storedSubcontract: StoredSubcontract) => {
        const subcontract = storedSubcontract.originalTransition as Transition.AddPayment | Transition.AddSwap;

        const subchannelIndex = this.state.subchannels.findIndex(subchannel => subchannel.chainId === subcontract.chainId);
        if (subchannelIndex < 0) {
          throw new Error(`Subchannel with chainId ${subcontract.chainId} not found.`);
        }

        const deltaIndex = this.state.subchannels[subchannelIndex].deltas.findIndex(delta => delta.tokenId === subcontract.tokenId);
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
          const subTokenIndex = this.state.subchannels[subchannelIndex].deltas.findIndex(delta => delta.tokenId === subcontract.subTokenId);
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
    sigs.push(await this.ctx.user.signer!.signMessage(keccak256(encode(this.state))));

    return {
      encodedProofBody,
      subcontractBatch,
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
      body: new FlushMessage(this.state.blockId, [])
    };
    

    // signed before block is applied
    const initialProofs = await this.getSubchannelProofs();
    const body = message.body as FlushMessage;
    body.debugState = encode(this.state).toString('hex');
    body.pendingSignatures = initialProofs.sigs;

    if (body.pendingSignatures.length != this.state.subchannels.length + 1) {
      throw new Error('fatal: Invalid pending signatures length');
    }

    const transitions = this.data.mempool.slice(0, BLOCK_LIMIT);
    // flush may or may not include new block
    if (transitions.length > 0) {
      
      const previousState: ChannelState = decode(encode(this.state));

      const block: Block = {
        isLeft: this.data.isLeft,
        timestamp: getTimestamp(),
        previousStateHash: keccak256(encode(previousState)), // hash of previous state
        previousBlockHash: this.state.previousBlockHash, // hash of previous block
        blockId: this.state.blockId,
        transitions: transitions,
      };

      //this.logger.log('State before applying block:'+this.thisUserAddress, stringify(this.state));
      await this.applyBlock(this.data.isLeft, block, true); // <--- only dryRun in flush()
      this.logger.log('State after applying block:'+this.thisUserAddress, stringify(this.state));

      //this.logger.log("block", block, this.data.pendingBlock);


      this.data.pendingBlock = decode(encode(block));
      this.data.sentTransitions = transitions.length;

      // signed after block is applied
      body.newSignatures = (await this.getSubchannelProofs()).sigs;
      this.data.pendingSignatures = body.newSignatures

      if (body.newSignatures.length != this.state.subchannels.length + 1) {
        throw new Error('fatal: Invalid pending signatures length');
      }
      // revert state to previous
      this.state = previousState; // <--- revert state
      body.block = block;

    } 

    this.logger.info(
      `channel send message from ${this.thisUserAddress} to ${this.otherUserAddress} with block ${message.body.block}`,
    );

    await this.save();


    //this.logger.log("Sending flush ", this.otherUserAddress, message, message);
  

    await this.ctx.user.send(this.otherUserAddress, message);
  }

    // return various derived values of delta: inbound/outbound capacity, credit etc
    public deriveDelta(chainId: number, tokenId: number, isLeft: boolean): any {
      const d = this.getDelta(chainId, tokenId) as Delta;

      const nonNegative = (x: bigint) => x < 0n ? 0n : x;

      const delta = d.ondelta + d.offdelta;
      const collateral = nonNegative(d.collateral);

      let ownCreditLimit = isLeft ? d.leftCreditLimit : d.rightCreditLimit;
      let peerCreditLimit = isLeft ? d.rightCreditLimit : d.leftCreditLimit;
      
      let inCollateral = delta > 0n ? nonNegative(collateral - delta) : collateral;
      let outCollateral = delta > 0n ? (delta > collateral ? collateral : delta) : 0n;


      let inOwnCredit = nonNegative(-delta);
      if (inOwnCredit > ownCreditLimit) inOwnCredit = ownCreditLimit;

      let outPeerCredit = nonNegative(delta - collateral);
      if (outPeerCredit > peerCreditLimit) outPeerCredit = peerCreditLimit;
    
      let outOwnCredit = nonNegative(ownCreditLimit - inOwnCredit);
      let inPeerCredit = nonNegative(peerCreditLimit - outPeerCredit);
    
      let inAllowence = isLeft ? d.rightAllowence : d.leftAllowence;
      let outAllowence = isLeft ? d.leftAllowence : d.rightAllowence;
    
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
        [outOwnCredit, inOwnCredit, outPeerCredit, inPeerCredit] = [inPeerCredit, outPeerCredit, inOwnCredit, outOwnCredit];
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
    
    



  public getDelta(chainId: number, tokenId: number): Delta | undefined {
    const subchannel = this.getSubchannel(chainId);
    const delta = subchannel?.deltas.find(delta => delta.tokenId === tokenId);

    return delta;
  }
  
  public getSubchannel(chainId: number): Subchannel | undefined {
    //this.logger.log('Getting subchannel. Current subchannels:', stringify(this.state.subchannels));
    const subchannel = this.state.subchannels.find(subchannel => subchannel.chainId === chainId);
    //this.logger.log(`Getting subchannel ${chainId}:`, stringify(subchannel));
    return subchannel;
  }

  private async applyBlock(isLeft: boolean, block: Block, dryRun: boolean): Promise<void> {
    this.logger.info(`applyBlock ${block.isLeft} isLeft ${isLeft}}`);

    // save previous hash first before changing this.state
    this.state.previousStateHash = keccak256(encode(this.state));

    this.state.blockId++;
    this.state.timestamp = block.timestamp;
    this.state.previousBlockHash = keccak256(encode(block));
    for (let i = 0; i < block.transitions.length; i++) {
      await this.applyTransition(block, block.transitions[i], dryRun);
    }
  }
 

  private async applyTransition(block: Block, transitionData: any, dryRun: boolean): Promise<void> {
    let transition: Transition.Any;
    this.state.transitionId++;
    //try {
      transition = Transition.createFromDecoded(transitionData) as Transition.Any;
    //} catch (error: any) {
    //  this.logger.error(`Invalid transition data: ${error.message}`);
    //  return;
    //}

    console.log(`Applying transition: ${transition.type}`+this.thisUserAddress, stringify(transition));
    try{
      await transition.apply(this, block, dryRun);
    } catch(e){
      console.log('fatal in applytransiton', e);
    }
  //this.logger.log('State after applying transition:'+this.thisUserAddress, stringify(this.state));
    
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
      this.logger.log("Loaded last state "+this.thisUserAddress, stringify(this.state));
    } catch (e) {
      this.logger.log("Load error", e);
      await this.save(); // Initialize with empty state if load fails
    }
  }

  async receiveMessage(encryptedMessage: string): Promise<void> {
    const decryptedMessage = await this.ctx.user.decryptMessage(this.otherUserAddress, encryptedMessage);
    //console.log(`Received message in channel ${this.getId()}: ${decryptedMessage}`);
  }

  getBalance(): bigint { 
    return 123n;
  }

}