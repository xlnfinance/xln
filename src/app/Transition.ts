

import Channel, {stringify} from './Channel';



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
    apply(channel: Channel, isLeft: boolean): void;
  }

  export class TextMessage implements TransitionType {
    readonly type = 'TextMessage';
    constructor(public readonly message: string) {}

    apply(channel: Channel, isLeft: boolean): void {
      channel.logger.log(`Applying TextMessage: ${this.message}`);
    }
  }

  export class AddSubchannel implements TransitionType {
    readonly type = 'AddSubchannel';
    constructor(public readonly chainId: number) {}
  
    apply(channel: Channel, isLeft: boolean): void {
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

    apply(channel: Channel, isLeft: boolean): void {
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
 
    apply(channel: Channel, isLeft: boolean): void {
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

    apply(channel: Channel, isLeft: boolean): void {
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

  export type Any = TextMessage | DirectPayment | AddSubchannel | AddDelta | SetCreditLimit;

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
    } else {
      throw new Error(`Invalid transition data: ${stringify(data)}`);
    }
  }
}

export default Transition;