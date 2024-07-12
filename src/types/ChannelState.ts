export default interface ChannelState {
  left: string;
  right: string;

  previousBlockHash: string;
  previousStateHash: string;

  offDelta: number;

  timestamp: number;
  blockNumber: number;
  transitionNumber: number;
}
