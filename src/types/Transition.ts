import { TransitionMethod } from './TransitionMethod';

export default class Transition {
  method: TransitionMethod;

  constructor(method: TransitionMethod) {
    this.method = method;
  }
}
