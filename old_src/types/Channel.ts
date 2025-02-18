import { Subchannel } from './Subchannel';
import { StoredSubcontract } from './Subcontract';

export interface ChannelState {
  left: string;
  right: string;
  channelKey: string;
  previousBlockHash: string;
  previousStateHash: string;
  blockId: number;
  timestamp: number;
  transitionId: number;
  subchannels: Subchannel[];
  subcontracts: StoredSubcontract[];
}

export interface ChannelData {
  isLeft: boolean;
  rollbacks: number;
  sentTransitions: number;
  pendingBlock: any | null;
  pendingSignatures: string[];
  sendCounter: number;
  receiveCounter: number;
} 