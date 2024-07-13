import IUserOptions from './IUserOptions';
import IStorageContext from './IStorageContext';
import ITransportFactory from './ITransportFactory';
import { ethers } from 'ethers';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider } from 'ethers';
import Logger from '../utils/Logger';

import { Depository, Depository__factory, ERC20Mock, ERC20Mock__factory, ERC721Mock, ERC721Mock__factory, ERC1155Mock, ERC1155Mock__factory } from '../../contracts/typechain-types/index';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';
import { env } from 'process';

export default interface IUserContext {
  provider: JsonRpcProvider;
  signer: Signer;
  depository: Depository;
  erc20Mock: ERC20Mock;
  erc721Mock: ERC721Mock;
  erc1155Mock: ERC1155Mock;

  getTransportFactory(): ITransportFactory;

  getStorageContext(): IStorageContext;

  getAddress(): string;

  getOptions(): IUserOptions;

  getSigner(): Promise<ethers.Signer | null>;

  signMessage(message: string): Promise<string>;

  verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean>;
}
