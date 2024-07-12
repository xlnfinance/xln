import Transition from '../Transition';
import { TransitionMethod } from './../TransitionMethod';

enum DepositoryEventType {
  kCollateralChange,
  kDeltaChange,
}

export class DepositoryEvent {
  type: DepositoryEventType;

  constructor(type: DepositoryEventType) {
    this.type = type;
  }
}

export interface ProposedEvent extends DepositoryEvent { }

export default class ProposedEventTransition extends Transition {
  event: DepositoryEvent;

  constructor(event: DepositoryEvent) {
    super(TransitionMethod.ProposedEvent);
    this.event = event;
  }
}