import { MoneyValue } from '../Subchannel';
import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class SetCreditLimitTransition extends Transition {
  chainId: number;
  tokenId: number;
  isLeft: boolean;
  creditLimit: MoneyValue;

  constructor(chainId: number, tokenId: number, isLeft: boolean, creditLimit: MoneyValue) {
    super(TransitionMethod.SetCreditLimit);
    this.chainId = chainId;
    this.tokenId = tokenId;
    this.creditLimit = creditLimit;
    this.isLeft = isLeft;
  }
}

