import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class CreateSubchannelTransition extends Transition {
  tokenId: string;

  constructor(tokenId: string) {
    super(TransitionMethod.CreateSubchannel);
    this.tokenId = tokenId;
  }
}
