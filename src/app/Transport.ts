import WebSocket from 'ws';
import ITransport from '../types/ITransport';
import IMessage from '../types/IMessage';
import { IHubConnectionData } from '../types/IHubConnectionData';
import Logger from '../utils/Logger';
import ITransportMessageReceiver from '../types/ITransportListener';
import { decode, encode } from '../utils/Codec';

export default class Transport implements ITransport {
  private _ws!: WebSocket; // Use definite assignment assertion
  private _receiver?: ITransportMessageReceiver;
  private _id: string;
  private _isServer: boolean;
  private _url?: string;
  private _connectionData?: IHubConnectionData;
  private _userId?: string;
  private _autoReconnectInterval: number = 10000; // 10 seconds
  private _messageNumber: number = 0;

  constructor(options: {
    id: string;
    receiver: ITransportMessageReceiver;
    connectionData?: IHubConnectionData;
    userId?: string;
    ws?: WebSocket;
  }) {
    this._id = options.id;
    this.setReceiver(options.receiver);
    this._isServer = !!options.ws;

    if (this._isServer) {
      // Server-side initialization
      this._ws = options.ws!;
      this.setupWebSocketListeners();
    } else {
      // Client-side initialization
      if (!options.connectionData || !options.userId) {
        throw new Error("Connection data and userId are required for client-side transport");
      }
      this._connectionData = options.connectionData;
      this._userId = options.userId;
      this._url = `ws://${options.connectionData.host}:${options.connectionData.port}`;
      // For client-side, we'll initialize the WebSocket in the open() method
    }
  }

  private setupWebSocketListeners(): void {
    console.log('serverrr')

    this._ws.onopen = (event: WebSocket.Event) => {
      Logger.info(`WebSocket connected: ${this._id}`);
      //this._receiver?.onOpen?.(this, this._id);
    };

    this._ws.onmessage = async (event: WebSocket.MessageEvent) => {
      console.log("hubconn")

      if (this._receiver) {
        this._messageNumber++;
        const msg = decode(event.data as Buffer) as IMessage;
        Logger.info(`Handle message ${this._messageNumber}: ${encode(msg)}`);
        await this._receiver.onReceive(this, msg);
      } else {
        Logger.warn(`No message receiver set for transport ${this._id}`);
      }
    };

    this._ws.onclose = (event: WebSocket.CloseEvent) => {
      Logger.info(`WebSocket closed: ${event.reason}`);
      this._receiver?.onClose(this, this._id);
      if (!this._isServer && event.code !== 1000) {
        this.reconnect();
      }
    };

    this._ws.onerror = (event: WebSocket.ErrorEvent) => {
      Logger.error(`WebSocket error: ${event.message}`);
      if (!this._isServer) {
        this.reconnect();
      }
    };
  }

  private reconnect(): void {
    Logger.info(`Attempting to reconnect in ${this._autoReconnectInterval}ms`);
    setTimeout(() => {
      if (!this._isServer) {
        this.open();
      }
    }, this._autoReconnectInterval);
  }

  setReceiver(receiver: ITransportMessageReceiver): void {
    this._receiver = receiver;
  }

  open(): Promise<void> {
    if (this._isServer) {
      // For server-side, the WebSocket is already open, so we resolve immediately
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      console.log(this._url)

      this._ws = new WebSocket(this._url!, {
        headers: { authorization: this._userId },
      });
      this.setupWebSocketListeners();

      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000); // 10 seconds timeout

      this._ws.onopen = (event: WebSocket.Event) => {
        clearTimeout(timeout);
        Logger.info(`WebSocket connected: ${this._id}`);
        resolve();
      };

      // Set temporary error handler for connection phase
      const tempErrorHandler = (event: WebSocket.ErrorEvent) => {
        clearTimeout(timeout);
        Logger.error(`WebSocket connection error: ${event.message}`);
        reject(new Error(`WebSocket connection failed: ${event.message}`));
      };

      this._ws.onerror = tempErrorHandler;
    });
  }

  send(msg: IMessage): Promise<void> {
    const jsonMsg = encode(msg);
    Logger.info(`Send message ${encode(msg)}`);
    return new Promise((resolve, reject) => {
      if (this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not open"));
        return;
      }

      this._ws.send(jsonMsg, (err) => {
        if (err) {
          Logger.error(`Failed to send message: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this._ws.close(1000); // Normal closure
      this._ws.onclose = () => {
        Logger.info(`WebSocket closed: ${this._id}`);
        resolve();
      };
    });
  }
}