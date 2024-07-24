import { Subchannel } from "./Subchannel";
import Transition from "../app/Transition";

export interface StoredSubcontract {
  originalTransition: Transition.Any;
  isLeft: boolean;
  transitionId: number;
  blockId: number;
  timestamp: number;
  data?: any;
}

export default interface ChannelState {
  left: string;
  right: string;
  channelKey: string;

  previousBlockHash: string;
  previousStateHash: string;

  timestamp: number;
  blockId: number;
  transitionId: number;

  subchannels: Array<Subchannel>;

  subcontracts: Array<StoredSubcontract>; 
}
