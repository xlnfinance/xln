import { IHubConnectionData } from '../types/IHubConnectionData';
import ITransport from '../types/ITransport';
import ITransportFactory from '../types/ITransportFactory';
import Transport from './Transport';

export default class TransportFactory implements ITransportFactory {
  create(connectionData: IHubConnectionData, userId: string, id: string): ITransport {
    return new Transport(connectionData, userId, id);
  }
}
