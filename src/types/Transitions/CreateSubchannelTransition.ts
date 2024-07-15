import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class CreateSubchannelTransition extends Transition {
  chainId: number;

  constructor(chainId: number) {
    super(TransitionMethod.CreateSubchannel);
    this.chainId = chainId;
  }
}
