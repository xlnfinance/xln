import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class CreateSubchannelTransition extends Transition {
  chainId: number;

  constructor(chainId: number) {
    super(TransitionMethod.CreateSubchannel);
    this.chainId = chainId;
  }
}

export class CreateSubchannelResultTransition extends Transition {
  chainId: number;
  isSuccess: boolean;

  constructor(chainId: number, isSuccess: boolean) {
    super(TransitionMethod.CreateSubchannelResult);
    this.chainId = chainId;
    this.isSuccess = isSuccess;
  }
}
