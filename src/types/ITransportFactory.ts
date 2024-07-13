import { IHubConnectionData } from './IHubAppConnectionData';
import ITransport from './ITransport';

export default interface ITransportFactory {
  create(connectionData: IHubConnectionData, userId: string, id: string): ITransport;
}
