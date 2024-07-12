import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default class TextMessageTransition extends Transition {
  message: string;

  constructor(message: string) {
    super(TransitionMethod.TextMessage);
    this.message = message;
  }
}
