

import Channel, {stringify} from './Channel';


import { encode } from '../utils/Codec';

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
    AddPaymentSubcontract,
    UpdatePaymentSubcontract,
    AddSwapSubcontract,
    RemoveSwapSubcontract,
  }
  export interface TransitionType {
    type: string;
    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void;
  }

  export class TextMessage implements TransitionType {
    readonly type = 'TextMessage';
    constructor(public readonly message: string) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      channel.logger.log(`Applying TextMessage: ${this.message}`);
    }
  }

  export class AddPayment implements TransitionType {
    readonly type = 'AddPayment';
    constructor(
      public readonly chainId: number,
      public readonly deltaIndex: number,
      public readonly amount: bigint,
      public readonly hash: string
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      if (subchannel) {
        subchannel.subcontracts.push({
            deltaIndex: this.deltaIndex,
            amount: this.amount,
            revealedUntilBlock: 0, // Set to 0 initially
            hash: this.hash
          });
      }
    }
  }

  export class ResolvePayment implements TransitionType {
    readonly type = 'ResolvePayment';
    constructor(
      public readonly chainId: number,
      public readonly subcontractIndex: number,
      public readonly secret: string | null
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      if (subchannel && subchannel.subcontracts[this.subcontractIndex]) {
        const payment = subchannel.subcontracts[this.subcontractIndex].payment[0];
        if (this.secret === null) {
          // Remove the payment
          subchannel.subcontracts.splice(this.subcontractIndex, 1);
        } else {
          // Resolve the payment
          const delta = channel.getDelta(this.chainId, payment.deltaIndex);
          if (delta) {
            delta.offdelta += isLeft ? -payment.amount : payment.amount;
          }
          subchannel.subcontracts.splice(this.subcontractIndex, 1);
        }
      }
    }
  }

  export class AddSwap implements TransitionType {
    readonly type = 'AddSwap';
    constructor(
      public readonly chainId: number,
      public readonly ownerIsLeft: boolean,
      public readonly addDeltaIndex: number,
      public readonly addAmount: bigint,
      public readonly subDeltaIndex: number,
      public readonly subAmount: bigint
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      if (subchannel) {
        subchannel.subcontracts.push({
          payment: [],
          swap: [{
            ownerIsLeft: this.ownerIsLeft,
            addDeltaIndex: this.addDeltaIndex,
            addAmount: this.addAmount,
            subDeltaIndex: this.subDeltaIndex,
            subAmount: this.subAmount
          }]
        });
      }
    }
  }

  export class ResolveSwap implements TransitionType {
    readonly type = 'ResolveSwap';
    constructor(
      public readonly chainId: number,
      public readonly subcontractIndex: number,
      public readonly fillingRatio: number | null
    ) {}

    apply(channel: Channel, isLeft: boolean, dryRun: boolean): void {
      const subchannel = channel.getSubchannel(this.chainId);
      if (subchannel && subchannel.subcontracts[this.subcontractIndex]) {
        const swap = subchannel.subcontracts[this.subcontractIndex].swap[0];
        if (swap) {
          if (this.fillingRatio === null) {
            // Remove the swap
            subchannel.subcontracts.splice(this.subcontractIndex, 1);
          } else {
            // Resolve the swap
            const addDelta = channel.getDelta(this.chainId, swap.addDeltaIndex);
            const subDelta = channel.getDelta(this.chainId, swap.subDeltaIndex);
            if (addDelta && subDelta) {
              const filledAddAmount = BigInt(Math.floor(Number(swap.addAmount) * this.fillingRatio));
              const filledSubAmount = BigInt(Math.floor(Number(swap.subAmount) * this.fillingRatio));
              
              if (swap.ownerIsLeft === isLeft) {
                addDelta.offdelta -= filledAddAmount;
                subDelta.offdelta += filledSubAmount;
              } else {
                addDelta.offdelta += filledAddAmount;
                subDelta.offdelta -= filledSubAmount;
              }
            }
            subchannel.subcontracts.splice(this.subcontractIndex, 1);
          }
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
        subcontracts: [],
    
        proposedEvents: [],
        proposedEventsByLeft: false
      };
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
      if (delta) {
        delta.offdelta += isLeft ? -this.amount : this.amount;
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

  export type Any = TextMessage | DirectPayment | AddSubchannel | AddDelta | SetCreditLimit | ProposedEvent | AddPayment | ResolvePayment | AddSwap | ResolveSwap;

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

  export function createFromDecoded(data: any): Any {
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
    } else {
      throw new Error(`Invalid transition data: ${stringify(data)}`);
    }
  }
}

export default Transition;