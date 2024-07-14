import ChannelPrivateState from './ChannelPrivateState';
import ChannelState from './ChannelState';

export default interface ChannelSavePoint {
  privateState: ChannelPrivateState;
  state: ChannelState;
}
