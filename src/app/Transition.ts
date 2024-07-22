import Channel, {stringify} from './Channel';
import { ethers, keccak256 } from 'ethers';
import { encode } from '../utils/Codec';
import { token } from '../../contracts/typechain-types/@openzeppelin/contracts';
import { BinaryLike } from 'crypto';
import { Subchannel } from '../types/Subchannel';
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
    UpdatePayment,
    AddSwap,
    UpdateSwap,
    SettlePayment,
    CancelPayment,
  }

  export interface TransitionType {
    type: string;
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void;
  }

  export class AddPayment implements TransitionType {
    readonly type = 'AddPayment';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint,
      public readonly hashlock: string,
      public readonly timelock: number,
      public readonly encryptedPackage: string
    ) {}
  
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      channel.state.subcontracts.push(this);

      if (!dryRun) channel.ctx.user.processPayment(channel, this);      
    }
  }

  export class UpdatePayment implements TransitionType {
    readonly type = 'UpdatePayment';
    constructor(
      public readonly chainId: number,
      public readonly subcontractIndex: number,
      public readonly secret: string | null,
      public readonly failureReason?: string
    ) {}
  
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const payment = channel.state.subcontracts[this.subcontractIndex] as AddPayment;
      
      if (payment) {
        if (this.secret && ethers.keccak256(ethers.toUtf8Bytes(this.secret)) === payment.hashlock) {
          // Settle the payment
          const delta = channel.getDelta(this.chainId, payment.tokenId);
          if (delta) {
            delta.offdelta += isLeft ? -payment.amount : payment.amount;
          }
        } else if (this.failureReason) {
          // Payment failed, log the reason
          channel.logger.error(`Payment failed: ${this.failureReason}`);
        }
  
        channel.state.subcontracts.splice(this.subcontractIndex, 1);
      }
    }
  }

  export class SettlePayment implements TransitionType {
    readonly type = 'SettlePayment';
    constructor(
      public readonly chainId: number,
      public readonly tokenId: number,
      public readonly amount: bigint,
      public readonly secret: string
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const delta = channel.getDelta(this.chainId, this.tokenId);
      if (delta) {
        delta.offdelta += isLeft ? -this.amount : this.amount;
      }
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

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      // Implementation for cancelling a payment
      // This might involve reverting the offdelta changes
      const delta = channel.getDelta(this.chainId, this.tokenId);
      if (delta) {
        delta.offdelta -= isLeft ? -this.amount : this.amount;
      }
    }
  }

  export class TextMessage implements TransitionType {
    readonly type = 'TextMessage';
    constructor(public readonly message: string) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
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

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      if (this.ownerIsLeft == !isLeft) {
        throw new Error('Incorrect0 owner for swap');
      }

      channel.state.subcontracts.push(this);
    }
  }

  export class UpdateSwap implements TransitionType {
    readonly type = 'UpdateSwap';
    constructor(
      public readonly chainId: number,
      public readonly subcontractIndex: number,
      public readonly fillingRatio: number | null
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      const swap = createFromDecoded(channel.state.subcontracts[this.subcontractIndex]) as any;
      
      if (subchannel && swap) {
        if (swap.ownerIsLeft == isLeft) {
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
  
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
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

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
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
 
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const delta = channel.getDelta(this.chainId, this.tokenId);
      const derived = channel.deriveDelta(this.chainId, this.tokenId, isLeft);

      console.log("Derived as ",isLeft, derived.outCapacity, this.amount)

      if (delta && this.amount > 0 && derived.outCapacity >= this.amount) {
        console.log(`Apply delta ${delta.offdelta}, ${isLeft} ${this.amount}`)
        delta.offdelta += isLeft ? -this.amount : this.amount;
        console.log(`Result ${delta.offdelta}`)
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

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const delta = channel.getDelta(this.chainId, this.tokenId);
      if (delta) {
        if (!isLeft) {
          delta.leftCreditLimit = this.amount;
        } else {
          delta.rightCreditLimit = this.amount;
        }
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
  
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      if (!subchannel) return;
  
      if (subchannel.proposedEvents.length > 0) {
        if (subchannel.proposedEventsByLeft === isLeft) {
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
        subchannel.proposedEventsByLeft = isLeft;
      }
    }
  }

  export type Any = TextMessage | DirectPayment | AddSubchannel | AddDelta | SetCreditLimit | ProposedEvent | AddPayment | UpdatePayment | AddSwap | UpdateSwap |
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

  export function isUpdatePayment(transition: any): transition is UpdatePayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'UpdatePayment' &&
      typeof transition.chainId === 'number' &&
      typeof transition.subcontractIndex === 'number' &&
      (transition.secret === null || typeof transition.secret === 'string')
    );
  }

  export function isSettlePayment(transition: any): transition is SettlePayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'SettlePayment' &&
      typeof transition.chainId === 'number' &&
      typeof transition.tokenId === 'number' &&
      typeof transition.amount === 'bigint' &&
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

  export function isUpdateSwap(transition: any): transition is UpdateSwap {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'UpdateSwap' &&
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
    } else if (isUpdatePayment(data)) {
      return new UpdatePayment(data.chainId, data.subcontractIndex, data.secret, data.failureReason);
    } else if (isSettlePayment(data)) {
      return new SettlePayment(data.chainId, data.tokenId, data.amount, data.secret);
    } else if (isCancelPayment(data)) {
      return new CancelPayment(data.chainId, data.tokenId, data.amount, data.hashlock);
    } else {
      throw new Error(`Invalid transition data: ${stringify(data)}`);
    }
  }
}

export default Transition;