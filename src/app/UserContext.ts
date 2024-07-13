import IUserOptions from '../types/IUserOptions';
import IUserContext from '../types/IUserContext';
import IStorageContext from '../types/IStorageContext';
import ITransportFactory from '../types/ITransportFactory';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider } from 'ethers';
import Logger from '../utils/Logger';

import { Depository, Depository__factory, ERC20Mock, ERC20Mock__factory, ERC721Mock, ERC721Mock__factory, ERC1155Mock, ERC1155Mock__factory } from '../../contracts/typechain-types/index';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';
import { env } from 'process';

const TEMP_ENV = {
  hubAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  firstUserAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  secondUserAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  depositoryContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  erc20Address:'0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  rpcNodeUrl: 'http://127.0.0.1:8545',
};

//import hre from "hardhat";
//import { Contract } from "ethers";
//import { ethers } from "hardhat";

export default class UserContext<
  TransportFactoryType extends ITransportFactory,
  StorageContextType extends IStorageContext,
> implements IUserContext
{
  provider!: JsonRpcProvider;
  signer!: Signer;
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;

  constructor(
    private transportFactory: TransportFactoryType,
    private storageContext: StorageContextType,
    private userId: string,
    private opt: IUserOptions,
  ) {
    
  }

  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        this.provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
        this.signer = await this.provider.getSigner(this.getAddress());

        this.depository = Depository__factory.connect(TEMP_ENV.depositoryContractAddress, this.signer);

        //this.depository.queryFilter(TransferReserveToCollateralEvent, 1, 5);
        //const eventsFilter = this.depository.filters.TransferReserveToCollateral();
          
        //this.depository.on<TransferReserveToCollateralEvent.Event>(
        //    eventsFilter1,
        //    (receiver, addr, collateral, ondelta, tokenId, event) => {
        //      console.log(receiver, addr, collateral, ondelta, tokenId, event);
        //    },
        //);
      } 
      catch (exp: any) {
        //this.signer = null;
        Logger.error(exp);
      }
    }

    return this.signer;
  }

  getAddress(): string {
    return this.userId;
  }

  getOptions(): IUserOptions {
    return this.opt;
  }

  getTransportFactory(): ITransportFactory {
    return this.transportFactory;
  }

  getStorageContext(): IStorageContext {
    return this.storageContext;
  }

  async signMessage(message: string): Promise<string> {
    const signer = await this.getSigner();
    if (signer == null) {
      return '';
    }
    return await signer.signMessage(message);
  }

  async verifyMessage(message: string, signature: string, senderAddress: string): Promise<boolean> {
    return ethersVerifyMessage(message, signature) === senderAddress;
  }
}
