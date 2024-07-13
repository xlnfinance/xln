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
    this.userId = TEMP_ENV.firstUserAddress;
  }




  testErc20() : void {
    //const ERC20Mock = await hre.ethers.getContractFactory("ERC20Mock");
    //erc20 = await ERC20Mock.deploy("ERC20Mock", "ERC20", 1000000);
    //await erc20.waitForDeployment();
  }

  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        this.provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
        this.signer = await this.provider.getSigner(TEMP_ENV.firstUserAddress);

        this.depository = Depository__factory.connect(TEMP_ENV.depositoryContractAddress, this.signer);

        const eventsFilter = this.depository.filters.TransferReserveToCollateral();
          this.depository.on<TransferReserveToCollateralEvent.Event>(
            eventsFilter,
            (receiver, addr, collateral, ondelta, tokenId, event) => {
              console.log(receiver, addr, collateral, ondelta, tokenId, event);
            },
        );
        
        const erc20signer = await this.provider.getSigner(TEMP_ENV.firstUserAddress);
        this.erc20Mock = ERC20Mock__factory.connect(TEMP_ENV.erc20Address, erc20signer);
        this.erc20Mock.transfer(TEMP_ENV.firstUserAddress, 5000);
 
        const packedToken = await this.depository.packTokenReference(0, await this.erc20Mock.getAddress(), 0);
        const packedTokenTest = await this.depository.packTokenReference(0, TEMP_ENV.erc20Address, 0);
        const testIsEq = (packedToken == packedTokenTest);


        await this.erc20Mock.approve(TEMP_ENV.firstUserAddress, 10000);
        const testBalance1 = await this.erc20Mock.balanceOf(TEMP_ENV.firstUserAddress);
        console.log(testBalance1);
        await this.erc20Mock.approve(this.getAddress(), 10000);
        const testBalance11 = await this.erc20Mock.balanceOf(this.getAddress());
        console.log(testBalance11);

                
        await this.erc20Mock.approve(TEMP_ENV.hubAddress, 10000);
        const testBalance = await this.erc20Mock.balanceOf(TEMP_ENV.hubAddress);

        await this.erc20Mock.approve(TEMP_ENV.depositoryContractAddress, 10000);
        const testBalance2 = await this.erc20Mock.balanceOf(TEMP_ENV.depositoryContractAddress);
        await this.erc20Mock.approve(await this.depository.getAddress(), 10000);
        const testBalance3 = await this.erc20Mock.balanceOf(await this.depository.getAddress());
        const testAllowance = await this.erc20Mock.allowance(TEMP_ENV.firstUserAddress, TEMP_ENV.depositoryContractAddress);

        //this.erc20Mock.on("debug", (data: any) => console.log(data))

        const testAddrss = await this.depository.getChannels(this.getAddress(), [TEMP_ENV.secondUserAddress]);

        await this.depository.registerHub(0, "sdfsf");
        const testHubs = await this.depository.getAllHubs();

        
        

        await this.depository.reserveToReserve(
          { receiver: TEMP_ENV.secondUserAddress, tokenId: 0, amount: 50 }
        );

        await this.depository.externalTokenToReserve(
          { receiver: TEMP_ENV.depositoryContractAddress, packedToken, internalTokenId: 0n, amount: 1n }
        );

        const reserve = await this.depository._reserves(this.getAddress(), 0);

        Logger.info(`Contract address :: ${await this.depository.getAddress()}`);
        Logger.info(`Contract getAllHubs :: ${await this.depository.getAllHubs()}`);

        

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

      
          

      } catch (exp: any) {
        this.signer = null;
        Logger.error(exp);

        const revertData = exp.error.data.originalError;
        const decodedError = this.erc20Mock!.interface.parseError(revertData);
        console.log("Custom Error:", decodedError!.name);
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
