import { MoneyValue } from '../SubChannel';
import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class UnsafePaymentTransition extends Transition {
  toUserId: string = "";
  fromUserId: string = "";
  chainId: number = 0;
  tokenId: number = 0;
  isLeft: boolean = false;
  amount: MoneyValue = 0;

  constructor() {
    super(TransitionMethod.UnsafePayment);
  }
}

