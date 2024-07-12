import IUserOptions from './IUserOptions';
import IStorageContext from './IStorageContext';
import ITransportFactory from './ITransportFactory';
import { ethers } from 'ethers';

export default interface IUserContext {
  getTransportFactory(): ITransportFactory;

  getStorageContext(): IStorageContext;

  getAddress(): string;

  getOptions(): IUserOptions;

  getSigner(): Promise<ethers.Signer | null>;

  signMessage(message: string): Promise<string>;

  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
