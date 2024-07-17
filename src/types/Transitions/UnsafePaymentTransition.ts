import { MoneyValue } from '../Subchannel';
import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class UnsafePaymentTransition extends Transition {
  toUserId: string = "";
  fromUserId: string = "";
  chainId: number = 0;
  tokenId: number = 0;
  isLeft: boolean = false;
  amount: MoneyValue = 0n;

  constructor() {
    super(TransitionMethod.UnsafePayment);
  }
}

