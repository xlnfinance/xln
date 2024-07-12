import IUserOptions from '../types/IUserOptions';
import IUserContext from '../types/IUserContext';
import IStorageContext from '../types/IStorageContext';
import ITransportFactory from '../types/ITransportFactory';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider } from 'ethers';
import Logger from '../utils/Logger';

import { Depository, Depository__factory } from 'xlnfinance-contracts/typechain-types/index';

export default class UserContext<
  TransportFactoryType extends ITransportFactory,
  StorageContextType extends IStorageContext,
> implements IUserContext
{
  private provider: JsonRpcProvider | null;
  private signer: Signer | null;
  private contract: Depository | null;

  constructor(
    private transportFactory: TransportFactoryType,
    private storageContext: StorageContextType,
    private userId: string,
    private opt: IUserOptions,
  ) {
    this.provider = null;
    this.signer = null;
    this.contract = null;
  }

  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        this.provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
        this.signer = await this.provider.getSigner(this.getAddress());

        this.contract = Depository__factory.connect('0x5FbDB2315678afecb367f032d93F642f64180aa3', this.signer);

        //this.contract = new Contract('0x5FbDB2315678afecb367f032d93F642f64180aa3', abi, this.signer);
        Logger.info(`Contract address :: ${await this.contract.getAddress()}`);
        Logger.info(`Contract getAllHubs :: ${await this.contract.getAllHubs()}`);
      } catch (exp) {
        this.signer = null;
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
