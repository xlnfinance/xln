import { IHubAppConnectionData } from '../types/IHubAppConnectionData';
import ITransport from '../types/ITransport';
import ITransportFactory from '../types/ITransportFactory';
import Transport from './Transport';

export default class TransportFactory implements ITransportFactory {
  create(connectionData: IHubAppConnectionData, userId: string, id: string): ITransport {
    return new Transport(connectionData, userId, id);
  }
}
