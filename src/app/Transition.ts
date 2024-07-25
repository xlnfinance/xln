import Channel, {stringify} from './Channel';
import { ethers, keccak256 } from 'ethers';
import { encode } from '../utils/Codec';
import { token } from '../../contracts/typechain-types/@openzeppelin/contracts';
import { BinaryLike } from 'crypto';
import { Subchannel } from '../types/Subchannel';
import Block from '../types/Block';
import { StoredSubcontract } from '../types/ChannelState';

export namespace Transition {
  export enum Method {
    TextMessage,
    AddSubchannel,
    RemoveSubchannel,
    AddDelta,
    RemoveDelta,
    DirectPayment,
    ProposedEvent,
    SetCreditLimit,
    
    AddPayment,
    SettlePayment,

    AddSwap,
    SettleSwap,

  }

  export interface TransitionType {
    type: string;
    apply(channel: Channel, block: Block, dryRun: boolean): Promise<void>;
  }

  export class AddPayment implements TransitionType {
    readonly type = 'AddPayment';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint,
      public readonly hashlock: string,
      public readonly timelock: number,
      public encryptedPackage: string
    ) {}
  
    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const storedSubcontract = {
        originalTransition: this,
        timestamp: block.timestamp,
        isLeft: block.isLeft,
        transitionId: channel.state.transitionId,
        blockId: block.blockId
      } as StoredSubcontract;
      channel.state.subcontracts.push(storedSubcontract);

      if (!dryRun && block.isLeft != channel.isLeft) {
        await channel.ctx.user.processAddPayment(channel, storedSubcontract, block.isLeft === channel.isLeft);    
      }  
    }
  }

  

  export class SettlePayment implements TransitionType {
    readonly type = 'SettlePayment';
    constructor(
      public readonly transitionId: number,
      public readonly secret: string
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const hashlock = ethers.keccak256(ethers.toUtf8Bytes(this.secret))
      channel.logger.log('applying secret, lock', this.secret, hashlock)
     // use scId instead of hashlock

      let payment: AddPayment | undefined;
      let paymentIndex: number | undefined;
      let subcontract: any;

      for (let i = 0; i < channel.state.subcontracts.length; i++) {
        //instanceof AddPayment
        subcontract = channel.state.subcontracts[i];
        if (subcontract && subcontract.transitionId === this.transitionId && subcontract.isLeft !== block.isLeft) {
          payment = subcontract.originalTransition;
          paymentIndex = i;
          break;      
        }
      }
      if (payment === undefined || paymentIndex === undefined) {
        channel.logger.log(channel.state.subcontracts)
        throw new Error('No such payment')
        return;
      }
      
      const delta = channel.getDelta(payment.chainId, payment.tokenId);
      if (!delta) {
        throw new Error('Delta not found for payment');
        return;
      }
      // other way around, because Settle is echoed back
      if (payment.hashlock === hashlock) {
        channel.logger.log('outcome unlocked')
        delta.offdelta += !block.isLeft ? -payment.amount : payment.amount;        
      } else {
        channel.logger.log('fatal reason for fail '+this.secret);
      }
      channel.state.subcontracts.splice(paymentIndex, 1);


      if (!dryRun) {
        await channel.ctx.user.processSettlePayment(channel, subcontract, this.secret);
        
      }

      return;
    }
  }

  export class CancelPayment implements TransitionType {
    readonly type = 'CancelPayment';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint,
      public readonly hashlock: string
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      // Implementation for cancelling a payment
      // This might involve reverting the offdelta changes
      const delta = channel.getDelta(this.chainId, this.tokenId);
      if (delta) {
        delta.offdelta -= block.isLeft ? -this.amount : this.amount;
      }
    }
  }

  export class TextMessage implements TransitionType {
    readonly type = 'TextMessage';
    constructor(public readonly message: string) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      channel.logger.log(`Applying TextMessage: ${this.message}`);
    }
  }
  

  export class AddSwap implements TransitionType {
    readonly type = 'AddSwap';
    constructor(
      public readonly chainId: number,
      public readonly ownerIsLeft: boolean,
      public readonly tokenId: number,
      public readonly addAmount: bigint,
      public readonly subTokenId: number,
      public readonly subAmount: bigint
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      if (this.ownerIsLeft == !block.isLeft) {
        throw new Error('Incorrect0 owner for swap');
      }
      const storedSubcontract = {
        originalTransition: this,
        timestamp: block.timestamp,
        isLeft: block.isLeft,
        transitionId: channel.state.transitionId,
        blockId: block.blockId
      } as StoredSubcontract;

      channel.state.subcontracts.push(storedSubcontract);
    }
  }

  export class SettleSwap implements TransitionType {
    readonly type = 'SettleSwap';
    constructor(
      public readonly chainId: number,
      public readonly subcontractIndex: number,
      public readonly fillingRatio: number | null
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const swap = createFromDecoded(channel.state.subcontracts[this.subcontractIndex]) as any;
      
      if (swap) {
        if (swap.ownerIsLeft == block.isLeft) {
          throw new Error('Incorrect owner for swap');
        }
        if (this.fillingRatio === null) {
          // Remove the swap
          channel.state.subcontracts.splice(this.subcontractIndex, 1);
        } else {
          // Resolve the swap
          const addDelta = channel.getDelta(this.chainId, swap.tokenId);
          const subDelta = channel.getDelta(this.chainId, swap.subTokenId);
          if (addDelta && subDelta) {
            const filledAddAmount = BigInt(Math.floor(Number(swap.addAmount) * this.fillingRatio));
            const filledSubAmount = BigInt(Math.floor(Number(swap.subAmount) * this.fillingRatio));
            
            addDelta.offdelta -= filledAddAmount;
            subDelta.offdelta += filledSubAmount;
          } else {
            throw new Error('Delta not found for swap');
          }
          channel.state.subcontracts.splice(this.subcontractIndex, 1);
        }

      }
        
    }
    
  }
  export class AddSubchannel implements TransitionType {
    readonly type = 'AddSubchannel';
    constructor(public readonly chainId: number) {}
  
    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const chainId = this.chainId;

      channel.logger.log('Current subchannels before adding:', stringify(channel.state.subchannels));
      let subchannel = channel.getSubchannel(chainId);
      if (subchannel) {
        channel.logger.log(`Subchannel ${chainId} already exists:`, stringify(subchannel));        
      }
      
      subchannel = {
        chainId: chainId,
        deltas: [],
        cooperativeNonce: 0,
        disputeNonce: 0,
    
        proposedEvents: [],
        proposedEventsByLeft: false
      } as Subchannel;
      channel.state.subchannels.push(subchannel);
      channel.logger.log(`Added new subchannel ${chainId}:`, stringify(subchannel));
      channel.logger.log('Current subchannels after adding:', stringify(channel.state.subchannels));
  
  

    }
  }

  export class AddDelta implements TransitionType {
    readonly type = 'AddDelta';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const subchannel = channel.getSubchannel(this.chainId);
      if (subchannel) {
        subchannel.deltas.push({
          tokenId: this.tokenId,
          collateral: 0n,
          ondelta: 0n,
          offdelta: 0n,
          leftCreditLimit: 0n,
          rightCreditLimit: 0n,
          leftAllowence: 0n,
          rightAllowence: 0n
        });
      } else {
        throw new Error('Subchannel not found for add Delta');
      }
    }
  }

  export class DirectPayment implements TransitionType {
    readonly type = 'DirectPayment';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint
    ) {}
 
    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const delta = channel.getDelta(this.chainId, this.tokenId);
      const derived = channel.deriveDelta(this.chainId, this.tokenId, block.isLeft);

      channel.logger.log("Derived as ",block.isLeft, derived.outCapacity, this.amount)

      if (delta && this.amount > 0 && derived.outCapacity >= this.amount) {
        channel.logger.log(`Apply delta ${delta.offdelta}, ${block.isLeft} ${this.amount}`)
        delta.offdelta += block.isLeft ? -this.amount : this.amount;
        channel.logger.log(`Result ${delta.offdelta}`)
      } else {
        throw new Error("Insufficient capacity for direct "+derived.outCapacity);
      }

    }
  }

  export class SetCreditLimit implements TransitionType {
    readonly type = 'SetCreditLimit';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint
    ) {}

    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const delta = channel.getDelta(this.chainId, this.tokenId);
      if (delta) {

        if (!block.isLeft) {
          delta.leftCreditLimit = this.amount;
        } else {
          delta.rightCreditLimit = this.amount;
        }

      } else {
        throw new Error("non existant delta");
      }
    }
  }

  export class ProposedEvent implements TransitionType {
    readonly type = 'ProposedEvent';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly collateral: bigint,
      public readonly ondelta: bigint
    ) {}
  
    async apply(channel: Channel, block: Block, dryRun: boolean): Promise<void> {
      const subchannel = channel.getSubchannel(this.chainId);
      if (!subchannel) return;
  
      if (subchannel.proposedEvents.length > 0) {
        if (subchannel.proposedEventsByLeft === block.isLeft) {
          subchannel.proposedEvents.push(this);
        } else {
          if (encode(subchannel.proposedEvents[0]) === encode(this)) {
            const event = subchannel.proposedEvents.shift();
            if (event) {
              const delta = channel.getDelta(event.chainId, event.tokenId);
              if (delta) {
                delta.collateral = event.collateral;
                delta.ondelta = event.ondelta;
              }
            }
          }
        }
      } else {
        subchannel.proposedEvents.push(this);
        subchannel.proposedEventsByLeft = block.isLeft;
      }
    }
  }

  export type Any = TextMessage | DirectPayment | AddSubchannel | AddDelta | SetCreditLimit | ProposedEvent | AddPayment | AddSwap | SettleSwap |
                    SettlePayment | CancelPayment;

  export function isAddPayment(transition: any): transition is AddPayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'AddPayment' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.amount === 'bigint' &&
      typeof transition.hashlock === 'string' &&
      typeof transition.timelock === 'number' &&
      typeof transition.encryptedPackage === 'string'
    );
  }

  

  export function isSettlePayment(transition: any): transition is SettlePayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'SettlePayment' &&
      typeof transition.transitionId === 'number' &&
      typeof transition.secret === 'string'
    );
  }

  export function isCancelPayment(transition: any): transition is CancelPayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'CancelPayment' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.amount === 'bigint' &&
      typeof transition.hashlock === 'string'
    );
  }

  export function isProposedEvent(transition: any): transition is ProposedEvent {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'ProposedEvent' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.collateral === 'bigint' &&
      typeof transition.ondelta === 'bigint'
    );
  }

  export function isTextMessage(transition: any): transition is TextMessage {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'TextMessage' &&
      typeof transition.message === 'string'
    );
  }

  export function isAddSubchannel(transition: any): transition is AddSubchannel {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'AddSubchannel' &&
      typeof transition.chainId === 'number'
    );
  }

  export function isAddDelta(transition: any): transition is AddDelta {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'AddDelta' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number'
    );
  }

  export function isDirectPayment(transition: any): transition is DirectPayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'DirectPayment' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.amount === 'bigint'
    );
  }

  export function isSetCreditLimit(transition: any): transition is SetCreditLimit {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'SetCreditLimit' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.amount === 'bigint'
    );
  }

  

  export function isAddSwap(transition: any): transition is AddSwap {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'AddSwap' &&
      typeof transition.chainId === 'number' &&
      typeof transition.ownerIsLeft === 'boolean' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.addAmount === 'bigint' &&
      typeof transition.subTokenId === 'number' &&
      typeof transition.subAmount === 'bigint'
    );
  }

  export function isSettleSwap(transition: any): transition is SettleSwap {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'SettleSwap' &&
      typeof transition.chainId === 'number' &&
      typeof transition.subcontractIndex === 'number' &&
      (transition.fillingRatio === null || typeof transition.fillingRatio === 'number')
    );
  }

  export function createFromDecoded(data: any) {
    if (isTextMessage(data)) {
      return new TextMessage(data.message);
    } else if (isDirectPayment(data)) {
      return new DirectPayment(data.chainId, data.tokenId, data.amount);
    } else if (isAddSubchannel(data)) {
      return new AddSubchannel(data.chainId);
    } else if (isAddDelta(data)) {
      return new AddDelta(data.chainId, data.tokenId);
    } else if (isSetCreditLimit(data)) {
      return new SetCreditLimit(data.chainId, data.tokenId, data.amount);
    } else if (isProposedEvent(data)) {
      return new ProposedEvent(data.chainId, data.tokenId, data.collateral, data.ondelta);
    } else if (isAddPayment(data)) {
      return new AddPayment(data.chainId, data.tokenId, data.amount, data.hashlock, data.timelock, data.encryptedPackage);
    } else if (isSettlePayment(data)) {
      return new SettlePayment(data.transitionId, data.secret);
    } else {
      throw new Error(`Invalid transition data: ${stringify(data)}`);
    }
  }
}

export default Transition;