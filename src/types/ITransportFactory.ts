import { IHubAppConnectionData } from './IHubAppConnectionData';
import ITransport from './ITransport';

export default interface ITransportFactory {
  create(connectionData: IHubAppConnectionData, userId: string, id: string): ITransport;
}
