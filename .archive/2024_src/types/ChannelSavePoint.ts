import ChannelData from './ChannelData';
import ChannelState from './ChannelState';

export default interface ChannelSavePoint {
  data: ChannelData;
  state: ChannelState;
}
