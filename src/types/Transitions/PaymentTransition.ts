import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class PaymentTransition extends Transition {
  constructor(public amount: number, public tokenId: number) {
    super(TransitionMethod.PaymentTransition);
  }
}
