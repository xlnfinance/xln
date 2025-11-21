import Block from './Block';
import ChannelState from './ChannelState';

export interface StoragePoint {
  block: Block;
  state: ChannelState;
  leftSignatures: string[];
  rightSignatures: string[];
}
