import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class TextMessageTransition extends Transition {
  constructor() {
    super(TransitionMethod.TextMessage);
  }
}
