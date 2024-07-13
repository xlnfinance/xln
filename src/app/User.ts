import IChannel from '../types/IChannel';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportListener from '../types/ITransportListener';
import BlockMessage from '../types/Messages/BlockMessage';
import Logger from '../utils/Logger';
import Channel from '../common/Channel';
import IUserContext from '../types/IUserContext';
import IChannelContext from '../types/IChannelContext';
import ChannelContext from './ChannelContext';
import { IHubConnectionData } from '../types/IHubAppConnectionData';
import { BodyTypes } from '../types/IBody';

export default class User implements ITransportListener {
  private _transports: Map<string, ITransport> = new Map();
  private _channelRecipientMapping: Map<ITransport, Map<string, IChannel>> = new Map();
  private _hubInfoMap: Map<string, IHubConnectionData> = new Map();

  constructor(private context: IUserContext) {}

  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);
    this._channelRecipientMapping.delete(transport);
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    if (message.body.type == BodyTypes.kBlockMessage) {
      const blockMessage = message.body as BlockMessage;
      const recipientChannelMap = this._channelRecipientMapping.get(transport);
      let channel = recipientChannelMap?.get(message.header.from);
      if (!channel) {
        if (
          this.context.getOptions().onExternalChannelRequestCallback &&
          this.context.getOptions().onExternalChannelRequestCallback!(message.header.from)
        ) {
          channel = await this.openChannel(message.header.from, transport);
        }
      }

      if (channel) {
        try {
          await channel.receive(blockMessage);
        } catch (e) {
          //TODO Collect error for send to client
          Logger.error(e);
        }
      }
    }
  }

  async addHub(data: IHubConnectionData) {
    if (this._transports.has(data.name)) {
      return;
    }

    this._hubInfoMap.set(data.name, data);

    const transport = this.context.getTransportFactory().create(data, this.context.getAddress(), data.name);
    this._transports.set(data.name, transport);
    transport.setReceiver(this);

    this._channelRecipientMapping.set(transport, new Map());

    await transport.open();
  }

  async start() {
    const signer = await this.context.getSigner();
    if (signer == null) {
      Logger.error(`Cannot get user information from RPC server with id ${this.context.getAddress()}`);
      return;
    }

    for (const opt of this.context.getOptions().hubConnectionDataList) {
      await this.addHub(opt);
    }
    await this.context.getStorageContext().initialize(this.context.getAddress());
  }

  async getChannelToHub(hubName: string): Promise<IChannel> {
    Logger.info(`Open channel to hub ${hubName}`);

    const transport = this._transports.get(hubName);
    if (!transport) {
      throw new Error(`Not found connection for hub with name ${hubName}`);
    }

    const address = this._hubInfoMap.get(hubName)!.address;

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    const channel = recipientChannelMap?.get(address);
    if (!channel) {
      return await this.openChannel(address, transport);
    }

    return channel;
  }

  async getChannelToUser(recipientUserId: string, hubName: string): Promise<IChannel> {
    Logger.info(`Open channel to user ${recipientUserId} use hub ${hubName}`);

    const transport = this._transports.get(hubName);

    if (!transport) {
      throw new Error(`Not found connection for hub with name ${hubName}`);
    }

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    const channel = recipientChannelMap?.get(recipientUserId);
    if (!channel) {
      return await this.openChannel(recipientUserId, transport);
    }
    return channel;
  }

  private async openChannel(recipientUserId: string, transport: ITransport): Promise<IChannel> {
    const channel = new Channel(this.makeChannelContext(recipientUserId, transport));
    await channel.initialize();

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    recipientChannelMap?.set(recipientUserId, channel);

    return channel;
  }

  private makeChannelContext(recipientUserId: string, transport: ITransport): IChannelContext {
    return new ChannelContext(this.context, recipientUserId, transport);
  }
}
