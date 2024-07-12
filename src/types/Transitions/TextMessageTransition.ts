import Transition from '../Transition';

export default interface TextMessageTransition extends Transition {
  message: string;
}