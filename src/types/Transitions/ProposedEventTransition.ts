import Transition from '../Transition';

enum DepositoryEventType {
    kCollateralChange,
    kDeltaChange, // for test
}

export interface DepositoryEvent {
    type: DepositoryEventType;
}

export interface ProposedEvent extends DepositoryEvent {
    
}


export default interface ProposedEventTransition extends Transition {
    //event: ProposedEvent;
    eventType: DepositoryEventType;
}