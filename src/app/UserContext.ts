import IUserOptions from '../types/IUserOptions';
import IUserContext from '../types/IUserContext';
import IStorageContext from '../types/IStorageContext';
import ITransportFactory from '../types/ITransportFactory';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider } from 'ethers';
import Logger from '../utils/Logger';

import { Depository, Depository__factory, ERC20Mock, ERC20Mock__factory, ERC721Mock, ERC721Mock__factory, ERC1155Mock, ERC1155Mock__factory } from '../../contracts/typechain-types/index';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';

export default class UserContext<
  TransportFactoryType extends ITransportFactory,
  StorageContextType extends IStorageContext,
> implements IUserContext
{
  private provider: JsonRpcProvider | null;
  private signer: Signer | null;
  private depository: Depository | null;
  private erc20Mock: ERC20Mock | null;
  private erc721Mock: ERC721Mock | null;
  private erc1155Mock: ERC1155Mock | null;


  constructor(
    private transportFactory: TransportFactoryType,
    private storageContext: StorageContextType,
    private userId: string,
    private opt: IUserOptions,
  ) {
    this.provider = null;
    this.signer = null;
    this.depository = null;
    this.erc20Mock = null;
    this.erc721Mock = null;
    this.erc1155Mock = null;
  }

  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        this.provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
        this.signer = await this.provider.getSigner(this.getAddress());

        this.depository = Depository__factory.connect('0x5FbDB2315678afecb367f032d93F642f64180aa3', this.signer);

        const eventsFilter = this.depository.filters.TransferReserveToCollateral();
          this.depository.on<TransferReserveToCollateralEvent.Event>(
            eventsFilter,
            (receiver, addr, collateral, ondelta, tokenId, event) => {
              console.log(receiver, addr, collateral, ondelta, tokenId, event);
            },
        );
        
        this.erc20Mock = ERC20Mock__factory.connect('0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9', this.signer);
        this.erc721Mock = ERC721Mock__factory.connect('0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9', this.signer);
        this.erc1155Mock = ERC1155Mock__factory.connect('0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', this.signer);

        await this.erc721Mock.mint(this.getAddress(), 1);
        await this.erc1155Mock.mint(this.getAddress(), 0, 100, "0x");


        const packedToken = await this.depository.packTokenReference(0, await this.erc20Mock.getAddress(), 0);
        await this.erc20Mock.approve(await this.depository.getAddress(), 10000);

        //expect(await this.erc20Mock.balanceOf(this.getAddress())).to.equal(1000000);

        //await erc20.transfer(await depository.getAddress(), 100000);

        await this.depository.externalTokenToReserve(
          { receiver: this.getAddress(), packedToken, internalTokenId: 0, amount: 10000 }
        );

        const reserve = await this.depository._reserves(this.getAddress(), 0);

        await this.depository.reserveToCollateral({
          tokenId: 0,
          receiver: this.getAddress(),
          pairs: [{ addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", amount: 50 }]
        });
  
        //const collateral = await this.depository._collaterals(await depository.channelKey(owner.address, user1.address), 0);
        //const reserve = await depository._reserves(owner.address, 0);

        Logger.info(`Chel reserves :: ${reserve}`);

        //expect(reserve).to.equal(10000);

        //expect(await erc20.balanceOf(owner.address)).to.equal(990000);

        //this.contract = new Contract('0x5FbDB2315678afecb367f032d93F642f64180aa3', abi, this.signer);
        Logger.info(`Contract address :: ${await this.depository.getAddress()}`);
        Logger.info(`Contract getAllHubs :: ${await this.depository.getAllHubs()}`);

      //this.contract.on<TransferReserveToCollateralEvent.Event>((receiver, addr, collateral, ondelta, tokenId, event) => {
      //    Logger.error(1);
      //  });

        //this.contract.on("TransferReserveToCollateralEvent",
        //  (receiver, addr, collateral, ondelta, tokenId, event) => {
        //    Logger.error(1);
        //  }
        //)}
      //});

      
          

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
