import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

export default interface TextMessageTransition extends Transition {
  message: string;
}

export class TextMessageTransitionFactory {
  public static CreateTextMessageTransition(message: string): TextMessageTransition {
    return { message: message, method: TransitionMethod.TextMessage };
  }
}
