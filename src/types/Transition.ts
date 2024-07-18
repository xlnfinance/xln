

import Channel from '../app/Channel';

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
    apply(channel: Channel): void;
  }

  export class TextMessage implements TransitionType {
    readonly type = 'TextMessage';
    constructor(public readonly message: string) {}

    apply(channel: Channel): void {
      console.log(`Applying TextMessage: ${this.message}`);
    }
  }

  export class DirectPayment implements TransitionType {
    readonly type = 'DirectPayment';
    constructor(public readonly chainId: number, public readonly tokenId: number, public readonly amount: bigint) {}
 
    apply(channel: Channel): void {
      const delta = channel.getSubchannelDelta(this.chainId, this.tokenId);
      if (delta) {
        delta.offdelta += channel.isLeft() ? -this.amount : this.amount;
      }
    }
  }

  export class AddSubchannel implements TransitionType {
    readonly type = 'AddSubchannel';
    constructor(public readonly chainId: number) {}

    apply(channel: Channel): void {
      channel.addSubchannel(this.chainId);
    }
  }
  
  export class SetCreditLimit implements TransitionType {
    readonly type = 'SetCreditLimit';
    constructor(public readonly chainId: number, public readonly tokenId: number, public readonly amount: bigint) {}

    apply(channel: Channel): void {
      const delta = channel.getSubchannelDelta(this.chainId, this.tokenId);
      if (delta){
        
        delta.leftCreditLimit = this.amount;
      }

    }
  }

  export type Any = TextMessage | DirectPayment | AddSubchannel | SetCreditLimit;

  // Improved type guards with runtime checks
  export function isTextMessage(transition: any): transition is TextMessage {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'TextMessage' &&
      typeof transition.message === 'string'
    );
  }

  export function isDirectPayment(transition: any): transition is DirectPayment {
    return (
      transition &&
      typeof transition === 'object' &&
      transition.type === 'DirectPayment' &&
      typeof transition.amount === 'bigint' &&
      typeof transition.tokenId === 'number'
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

  // Function to safely create a transition from possibly untrusted data
  export function createFromDecoded(data: any): Any {
    if (isTextMessage(data)) {
      return new TextMessage(data.message);
    } else if (isDirectPayment(data)) {
      return new DirectPayment(data.chainId, data.tokenId, data.amount);
    } else if (isAddSubchannel(data)) {
      return new AddSubchannel(data.chainId);
    } else {
      throw new Error(`Invalid transition data: ${JSON.stringify(data)}`);
    }
  }

  
}






export default Transition;