import IChannel from '../types/IChannel';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportListener from '../types/ITransportListener';
import BlockMessage from '../types/Messages/BlockMessage';
import Logger from '../utils/Logger';
import Channel from '../common/Channel';
import IChannelContext from '../types/IChannelContext';
import ChannelContext from './ChannelContext';
import { IHubConnectionData } from '../types/IHubConnectionData';
import { BodyTypes } from '../types/IBody';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider, BigNumberish } from 'ethers';
import {
  Depository,
  Depository__factory,
  ERC20Mock,
  ERC20Mock__factory,
  ERC721Mock,
  ERC721Mock__factory,
  ERC1155Mock,
  ERC1155Mock__factory,
} from '../../contracts/typechain-types/index';
import IUserOptions from '../types/IUserOptions';
import TransportFactory from './TransportFactory';
import StorageContext from './StorageContext';
import CreateSubchannelTransition from '../types/Transitions/CreateSubchannelTransition';
import AddCollateralTransition from '../types/Transitions/AddCollateralTransition';
import { MoneyValue } from '../types/SubChannel';
import SetCreditLimitTransition from '../types/Transitions/SetCreditLimitTransition';

const TEMP_ENV = {
  hubAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  firstUserAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  secondUserAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  depositoryContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  erc20Address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  rpcNodeUrl: 'http://127.0.0.1:8545',
};

export default class User implements ITransportListener {
  private _transports: Map<string, ITransport> = new Map();
  private _channelRecipientMapping: Map<ITransport, Map<string, IChannel>> = new Map();
  private _hubInfoMap: Map<string, IHubConnectionData> = new Map();

  thisUserAddress: string;
  opt: IUserOptions;
  transportFactory: TransportFactory;
  storageContext: StorageContext;

  provider!: JsonRpcProvider;
  signer!: Signer;
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;

  constructor(address: string, opt: IUserOptions) {
    this.thisUserAddress = address;
    this.opt = opt;
    this.transportFactory = new TransportFactory();
    this.storageContext = new StorageContext();
  }

  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);
    this._channelRecipientMapping.delete(transport);
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    if (message.body.type == BodyTypes.kBlockMessage) {
      const blockMessage = message.body as BlockMessage;
      const recipientChannelMap = this._channelRecipientMapping.get(transport);
      const channelAddress = message.header.from;
      let channel = recipientChannelMap?.get(channelAddress);
      if (!channel) {
        if (this.opt.onExternalChannelRequestCallback && this.opt.onExternalChannelRequestCallback!(channelAddress)) {
          channel = await this.openChannel(channelAddress, transport);
        }
      }

      if (channel) {
        try {
          await channel.receive(blockMessage);
        } catch (e) {
          //TODO Collect error for send to client
          Logger.error(e);
        }
      }
    }
  }

  async addHub(data: IHubConnectionData) {
    if (this._transports.has(data.name)) {
      return;
    }

    this._hubInfoMap.set(data.name, data);

    const transport = this.transportFactory.create(data, this.thisUserAddress, data.name);
    this._transports.set(data.name, transport);
    transport.setReceiver(this);

    this._channelRecipientMapping.set(transport, new Map());

    await transport.open();
  }

  async start() {
    const signer = await this.getSigner();
    if (signer == null) {
      Logger.error(`Cannot get user information from RPC server with id ${this.thisUserAddress}`);
      return;
    }

    for (const opt of this.opt.hubConnectionDataList) {
      await this.addHub(opt);
    }
    await this.storageContext.initialize(this.thisUserAddress);
  }

  // TODO думаю надо две разные функции getChannel и openChannel. Наверно лучше явно открывать канал, если необходимо
  async getChannel(userId: string): Promise<IChannel> {
    Logger.info(`Open channel to <user> ${userId}`);

    const transport = this._transports.get(userId);
    if (!transport) {
      throw new Error(`Not found connection for hub with name ${userId}`);
    }

    const address = this.getHubAddressByName(userId);

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    const channel = recipientChannelMap?.get(address);
    if (!channel) {
      return await this.openChannel(address, transport);
    }

    return channel;
  }

  getHubAddressByName(hubName: string): string {
    const address = this._hubInfoMap.get(hubName)!.address;
    return address;
  }

  async getChannelToUser(recipientUserId: string, hubName: string): Promise<IChannel> {
    Logger.info(`Open channel to user ${recipientUserId} use hub ${hubName}`);

    const transport = this._transports.get(hubName);

    if (!transport) {
      throw new Error(`Not found connection for hub with name ${hubName}`);
    }

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    const channel = recipientChannelMap?.get(recipientUserId);
    if (!channel) {
      return await this.openChannel(recipientUserId, transport);
    }
    return channel;
  }

  async createSubchannel(userId: string, chainId: number) : Promise<void> {
    const channel = await this.getChannel(userId);

    // send notification to the other party to create the same subchannel on the other side
    // TODO: should we await here for flush to be completed?
    // если сначала создать саб-канал, а затем отправить сообщение, то мы снимем хеш с состояния, где есть один сабканал
    // а на другой стороне revious state hash будет без этого сабканала и не сработает
    const t: CreateSubchannelTransition = new CreateSubchannelTransition(chainId);
    channel.push(t);
    channel.send();
  }

  // TODO save fromBlockNumber to the storage
  startDepositoryEventsListener(fromBlockNumber: number): void {
    //const fromBlockNumber = 3; // Replace with the desired starting block number

    const eventFilter = this.depository.filters.TransferReserveToCollateral();
    this.depository.queryFilter(eventFilter, fromBlockNumber).then((pastEvents) => {
      pastEvents.forEach((event) => {
        const { receiver, addr, collateral, ondelta, tokenId } = event.args;
        console.log(receiver, addr, collateral, ondelta, tokenId, event);
      });
    });

    // Listen for future events starting from the latest block
    this.depository.on<TransferReserveToCollateralEvent.Event>(
      eventFilter,
      (receiver, addr, collateral, ondelta, tokenId, event) => {
        console.log(receiver, addr, collateral, ondelta, tokenId, event);
      },
    );
  }

  async externalTokenToReserve(erc20Address: string, amount: BigNumberish): Promise<void> {
    let erc20Mock: ERC20Mock = ERC20Mock__factory.connect(erc20Address, this.signer);
    let depository = this.depository;
    let thisUserAddress = this.thisUserAddress;

    const testAllowance1 = await erc20Mock.allowance(thisUserAddress, await depository.getAddress());

    await erc20Mock.approve(await depository.getAddress(), amount);
    //await erc20Mock.transfer(await depository.getAddress(), 10000);

    console.log('user1_balance_before', await erc20Mock.balanceOf(thisUserAddress));
    console.log('depository_balance_before', await erc20Mock.balanceOf(await depository.getAddress()));

    const packedToken = await depository.packTokenReference(0, await erc20Mock.getAddress(), 0);
    //console.log(packedToken);
    //console.log(await depository.unpackTokenReference(packedToken));
    //console.log(await erc20Mock.getAddress());

    /* TODO FIX ERROR MISSING ARGUMENT ResiverAddress
    await depository.externalTokenToReserve(
      { packedToken, internalTokenId: 0n, amount: 10n }
    );
    */
    console.log('user1_balance_after', await erc20Mock.balanceOf(thisUserAddress));
    console.log('depository_balance_after', await erc20Mock.balanceOf(await depository.getAddress()));
    console.log('reserveTest1', await depository._reserves(thisUserAddress, 0));
  }

  //TODO this is test function
  async reserveToCollateral(otherUserOfChannelAddress: string, tokenId: number, amount: BigNumberish): Promise<void> {
    let depository = this.depository;
    let thisUserAddress = this.thisUserAddress;

    await depository.reserveToCollateral({
      tokenId: tokenId,
      receiver: thisUserAddress,
      pairs: [{ addr: otherUserOfChannelAddress, amount: amount }],
    });

    const collateralTest = await depository._collaterals(
      await depository.channelKey(thisUserAddress, otherUserOfChannelAddress),
      tokenId,
    );
    const reserveTest2 = await depository._reserves(thisUserAddress, tokenId);
  }

  //TODO эта функция async только потому что getChannel async, когда переделаю getChannel, убрать тут async
  // хотя функции канала тоже async, подумать
  async test_reserveToCollateral(userId: string, chainId: number, tokenId: number, collateral: MoneyValue): Promise<void> {
    const channel = await this.getChannel(userId);

    const t: AddCollateralTransition = new AddCollateralTransition(chainId, tokenId, channel.isLeft(), collateral);
    channel.push(t);
    channel.send();
  }
  async test_setCreditLimit(userId: string, chainId: number, tokenId: number, creditLimit: MoneyValue): Promise<void> {
    const channel = await this.getChannel(userId);

    const t: SetCreditLimitTransition = new SetCreditLimitTransition(chainId, tokenId, channel.isLeft(), creditLimit);
    channel.push(t);
    channel.send();
  }

  private async openChannel(recipientUserId: string, transport: ITransport): Promise<IChannel> {
    const channel = new Channel(this.makeChannelContext(recipientUserId, transport));
    await channel.initialize();

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    recipientChannelMap?.set(recipientUserId, channel);

    return channel;
  }

  private makeChannelContext(recipientUserId: string, transport: ITransport): IChannelContext {
    return new ChannelContext(this, recipientUserId, transport);
  }

  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        this.provider = new JsonRpcProvider(this.opt.jsonRPCUrl);
        this.signer = await this.provider.getSigner(this.thisUserAddress);

        this.depository = Depository__factory.connect(TEMP_ENV.depositoryContractAddress, this.signer);

        //this.depository.queryFilter(TransferReserveToCollateralEvent, 1, 5);
        //const eventsFilter = this.depository.filters.TransferReserveToCollateral();

        //this.depository.on<TransferReserveToCollateralEvent.Event>(
        //    eventsFilter1,
        //    (receiver, addr, collateral, ondelta, tokenId, event) => {
        //      console.log(receiver, addr, collateral, ondelta, tokenId, event);
        //    },
        //);
      } catch (exp: any) {
        //this.signer = null;
        Logger.error(exp);
      }
    }

    return this.signer;
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
