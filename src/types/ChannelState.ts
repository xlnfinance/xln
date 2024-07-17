import { Subchannel } from "./Subсhannel";

export default interface ChannelState {
  left: string;
  right: string;

  previousBlockHash: string;
  previousStateHash: string;

  timestamp: number;
  blockNumber: number;
  transitionNumber: number;

  subChannels: Array<Subchannel>;
}
