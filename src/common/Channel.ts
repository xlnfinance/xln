import IChannel from '../types/IChannel';
import Logger from '../utils/Logger';
import BlockMessage from '../types/Messages/BlockMessage';
import IChannelStorage from '../types/IChannelStorage';
import IChannelContext from '../types/IChannelContext';
import ISubChannel from '../types/ISubChannel';
import { SubChannel } from './SubChannel';
import ChannelSavePoint from '../types/ChannelSavePoint';

export default class Channel implements IChannel {
  private subChannels: Map<string, SubChannel>;
  private storage: IChannelStorage;

  constructor(private ctx: IChannelContext) {
    this.subChannels = new Map();
    this.storage = this.ctx.getStorage(this.ctx.getRecipientUserId());
  }

  async openSubChannel(otherUserAddress: string, tokenId: number): Promise<ISubChannel> {
    const uniqSubChannelId = this.getUniqSubChannelId(otherUserAddress, tokenId);
    let subChannel = this.subChannels.get(uniqSubChannelId);
    if (!subChannel) {
      subChannel = await this.makeSubChannel(otherUserAddress, tokenId);
      this.subChannels.set(uniqSubChannelId, subChannel);
      await this.save();
    }
    return subChannel;
  }

  private async makeSubChannel(otherUserAddress: string, tokenId: number): Promise<SubChannel> {
    const subChannel = new SubChannel(otherUserAddress, tokenId, this.ctx);
    await subChannel.initialize();
    return subChannel;
  }

  private getUniqSubChannelId(otherUserAddress: string, tokenId: number) {
    return `${otherUserAddress}:${tokenId}`;
  }

  async initialize(): Promise<void> {
    try {
      const savePoint = await this.storage.getValue<ChannelSavePoint>('channelSavePoint');
      for (const subChannelInfo of savePoint.subChannels) {
        const subChannel = await this.makeSubChannel(subChannelInfo.otherUserAddress, subChannelInfo.tokenId);
        const uniqSubChannelId = this.getUniqSubChannelId(subChannelInfo.otherUserAddress, subChannelInfo.tokenId);
        this.subChannels.set(uniqSubChannelId, subChannel);
      }
    } catch {
      this.subChannels = new Map();
    }
  }

  async receive(message: BlockMessage): Promise<void> {
    const uniqSubChannelId = this.getUniqSubChannelId(message.thisUserAddress, message.tokenId);
    const channel = this.subChannels.get(uniqSubChannelId);
    if (channel) {
      await channel.receive(message);
    }
  }

  private async save(): Promise<void> {
    const savePoint: ChannelSavePoint = {
      subChannels: [],
    };

    for (const pair of this.subChannels) {
      savePoint.subChannels.push({
        otherUserAddress: pair[1].otherUserAddress,
        tokenId: pair[1].tokenId,
      });
    }

    await this.storage.setValue<ChannelSavePoint>('channelSavePoint', savePoint);
  }
}
