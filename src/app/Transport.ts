import WebSocket from 'ws';
import ITransport from '../types/ITransport';
import IMessage from '../types/IMessage';
import { IHubAppConnectionData } from '../types/IHubAppConnectionData';
import Logger from '../utils/Logger';
import ITransportMessageReceiver from '../types/ITransportListener';
import { decode, encode } from '../utils/Codec';

export default class Transport implements ITransport {
  private _ws: WebSocket;
  private _receiver?: ITransportMessageReceiver;
  private _id: string;

  constructor(connectionData: IHubAppConnectionData, userId: string, id: string) {
    this._id = id;
    this._ws = new WebSocket(`ws://${connectionData.host}:${connectionData.port}`, {
      headers: { authorization: userId },
    });

    this._ws.onmessage = async (event: WebSocket.MessageEvent) => {
      if (this._receiver) {
        const msg = decode(event.data as Buffer) as IMessage;
        Logger.info(`Handle message ${msg}`);
        await this._receiver.onReceive(this, msg);
      }
    };
  }

  setReceiver(receiver: ITransportMessageReceiver): void {
    this._receiver = receiver;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO Check work for on events (Auto reconnection ?)
      this._ws.onopen = () => {
        resolve();

        this._ws.onclose = (event: WebSocket.Event) => {
          Logger.info(event);
          this._receiver?.onClose(this, this._id);
        };

        this._ws.onerror = (event: WebSocket.Event) => {
          Logger.info(event);
          // TODO added global listener
        };
      };

      this._ws.onclose = (event: WebSocket.Event) => {
        Logger.info(event);
        reject(event);
      };

      this._ws.onerror = (event: WebSocket.Event) => {
        Logger.info(event);
        reject(event);
      };
    });
  }

  send(msg: IMessage): Promise<void> {
    const jsonMsg = encode(msg);
    Logger.info(`Send message ${msg}`);
    return new Promise((res, rej) => this._ws.send(jsonMsg, (err) => (err ? rej(err) : res())));
  }
}
