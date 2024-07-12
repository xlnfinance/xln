import { IHubAppConnectionData } from './IHubAppConnectionData';

export default interface IUserOptions {
  hubConnectionDataList: Array<IHubAppConnectionData>;
  jsonRPCUrl: string;
  depositoryContractAddress: string;
  onExternalChannelRequestCallback?: (userId: string) => boolean;
}
