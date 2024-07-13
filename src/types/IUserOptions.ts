import { IHubConnectionData } from './IHubConnectionData';

export default interface IUserOptions {
  hubConnectionDataList: Array<IHubConnectionData>;
  jsonRPCUrl: string;
  depositoryContractAddress: string;
  onExternalChannelRequestCallback?: (userId: string) => boolean;
}
