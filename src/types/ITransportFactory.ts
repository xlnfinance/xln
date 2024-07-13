import { IHubConnectionData } from './IHubConnectionData';
import ITransport from './ITransport';

export default interface ITransportFactory {
  create(connectionData: IHubConnectionData, userId: string, id: string): ITransport;
}
