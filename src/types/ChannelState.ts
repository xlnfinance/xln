import { Subchannel } from "./Subchannel";
import Transition from "../app/Transition";

export default interface ChannelState {
  left: string;
  right: string;
  channelKey: string;

  previousBlockHash: string;
  previousStateHash: string;

  timestamp: number;
  blockNumber: number;
  transitionNumber: number;

  subchannels: Array<Subchannel>;
  subcontracts: Array<Transition.Any>;
}
