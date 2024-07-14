import SubChannelSavePoint from "./SubChannelSavePoint";

export default interface ChannelSavePoint {
  subChannels: Array<SubChannelSavePoint>;
}