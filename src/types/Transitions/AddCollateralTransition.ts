import { MoneyValue } from '../Subсhannel';
import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class AddCollateralTransition extends Transition {
  chainId: number;
  tokenId: number;
  isLeft: boolean;
  collateral: MoneyValue;

  constructor(chainId: number, tokenId: number, isLeft: boolean, collateral: MoneyValue) {
    super(TransitionMethod.AddCollateral);
    this.chainId = chainId;
    this.tokenId = tokenId;
    this.collateral = collateral;
    this.isLeft = isLeft;
  }
}

