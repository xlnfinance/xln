import { IHubConnectionData } from './IHubConnectionData';

export interface IHubOptions {
  host: string;
  port: number;
  address: string;
}

export default interface IUserOptions {
  hubConnectionDataList: Array<IHubConnectionData>;
  jsonRPCUrl: string;
  depositoryContractAddress: string;
  onExternalChannelRequestCallback?: (userId: string) => boolean;
  hub?: IHubOptions;
}
