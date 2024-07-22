import IMessage from './IMessage';
import ITransportMessageReceiver from './ITransportListener';

export default interface ITransport {
  open(): Promise<void>;

  setReceiver(receiver: ITransportMessageReceiver): void;

  send(msg: IMessage): Promise<void>;
  close(): void;
  
}
