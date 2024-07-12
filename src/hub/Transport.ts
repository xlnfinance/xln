import WebSocket from 'ws';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportMessageReceiver from '../types/ITransportListener';
import { decode, encode } from '../utils/Codec';
import Logger from '../utils/Logger';

export default class Transport implements ITransport {
  private _ws: WebSocket;
  private _receiver?: ITransportMessageReceiver;
  private _id: string;

  constructor(id: string, ws: WebSocket, receiver: ITransportMessageReceiver) {
    this.setReceiver(receiver);
    this._id = id;
    this._ws = ws;
    this._ws.onmessage = async (event: WebSocket.MessageEvent) => {
      if (this._receiver) {
        const msg = decode(event.data as Buffer) as IMessage;
        Logger.info(`Handle message ${msg}`);
        await this._receiver.onReceive(this, msg);
      }
    };

    this._ws.onclose = () => {
      this._receiver?.onClose(this, this._id);
    };
  }

  open(): Promise<void> {
    throw new Error('Method not implemented.');
  }

  setReceiver(receiver: ITransportMessageReceiver): void {
    this._receiver = receiver;
  }

  send(msg: IMessage): Promise<void> {
    const jsonMsg = encode(msg);
    Logger.info(`Send message ${msg}`);
    return new Promise((res, rej) => this._ws.send(jsonMsg, (err) => (err ? rej(err) : res())));
  }
}
