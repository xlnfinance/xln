import IHubOptions from '../types/IHubOptions';
import WebSocket from 'ws';
import Logger from '../utils/Logger';
import { IncomingMessage } from 'http';
import IMessage from '../types/IMessage';
import Channel from '../common/Channel';
import ITransportListener from '../types/ITransportListener';
import ITransport from '../types/ITransport';
import Transport from './Transport';
import BlockMessage from '../types/Messages/BlockMessage';
import IStorageContext from '../types/IStorageContext';
import StorageContext from './StorageContext';
import ChannelContext from './ChannelContext';
import { JsonRpcProvider, Signer } from 'ethers';
import { BodyTypes } from '../types/IBody';

export default class HubApp implements ITransportListener {
  private _server!: WebSocket.Server<typeof WebSocket, typeof import('http').IncomingMessage>;

  // TODO CREATE UserID STORAGE
  private _users: Map<string, ITransport> = new Map();
  private _channels: Map<string, Channel> = new Map();
  private _storage: IStorageContext = new StorageContext();
  private _provider!: JsonRpcProvider | null;
  private _signer!: Signer | null;

  constructor(private opt: IHubOptions) {}

  onClose(_: ITransport, id: string): void {
    this._users.delete(id);
    Logger.info(`Client disconnected ${id}`);
  }

  onReceive(_: ITransport, message: IMessage): Promise<void> {
    Logger.info(`New message ${message}`);
    return this.isProxyMessage(message) ? this.receiveProxyMessage(message) : this.receiveMessage(message);
  }

  async start(): Promise<void> {
    try {
      this._provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
      this._signer = await this._provider.getSigner(this.opt.address);
    } catch (exp) {
      this._signer = null;
      Logger.error(exp);
      throw exp;
    }

    Logger.info(`Start listen ${this.opt.host}:${this.opt.port}`);

    this._server = new WebSocket.Server({ port: this.opt.port, host: this.opt.host || '127.0.0.1' });

    this._server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const userId = req.headers.authorization;
      if (!userId) {
        Logger.error('Try connect user without identification information');
        ws.close();
        return;
      }

      Logger.info(`New user connection with id ${userId}`);

      this._users.set(userId, new Transport(userId, ws, this));
    });
  }

  private isProxyMessage(message: IMessage) {
    return message.header.to !== this.opt.address;
  }

  private async receiveProxyMessage(message: IMessage) {
    const recipientUserId = message.header.to;
    if (this._users.has(recipientUserId)) {
      const transport = this._users.get(recipientUserId);
      await transport!.send(message);
    } else {
      //TODO send error
    }
  }

  private async receiveMessage(message: IMessage) {
    const recipientUserId = message.header.to;
    const channel = await this.getChannel(recipientUserId);

    if (message.body.type == BodyTypes.kBlockMessage) {
      await channel.receive(message.body as BlockMessage);
    }
  }

  private async getChannel(userId: string): Promise<Channel> {
    Logger.info(`Open channel ${userId}`);

    const transport = this._users.get(userId);

    if (!transport) {
      throw new Error(`Not found connection for user with name ${transport}`);
    }

    let channel = this._channels.get(userId);

    if (!channel) {
      channel = new Channel(
        new ChannelContext(
          this.opt.address,
          userId,
          transport,
          this._storage.getChannelStorage(`${this.opt.address}-${userId}`),
          this._signer!,
        ),
      );

      await channel.initialize();
    }

    return channel;
  }
}
