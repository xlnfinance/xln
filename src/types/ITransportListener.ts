import IMessage from './IMessage';
import ITransport from './ITransport';

export default interface ITransportListener {
  onReceive(transport: ITransport, message: IMessage): Promise<void>;

  onClose(transport: ITransport, id: string): void;
}
