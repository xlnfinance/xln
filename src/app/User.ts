import IChannel from '../types/IChannel';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportListener from '../types/ITransportListener';
import BlockMessage from '../types/Messages/BlockMessage';
import Logger from '../utils/Logger';
import Channel from '../common/Channel';
import IUserContext from '../types/IUserContext';
import IChannelContext from '../types/IChannelContext';
import ChannelContext from './ChannelContext';
import { IHubConnectionData } from '../types/IHubConnectionData';
import { BodyTypes } from '../types/IBody';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';
import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider, BigNumberish } from 'ethers';
import { Depository, Depository__factory, ERC20Mock, ERC20Mock__factory, ERC721Mock, ERC721Mock__factory, ERC1155Mock, ERC1155Mock__factory } from '../../contracts/typechain-types/index';


export default class User implements ITransportListener {
  private _transports: Map<string, ITransport> = new Map();
  private _channelRecipientMapping: Map<ITransport, Map<string, IChannel>> = new Map();
  private _hubInfoMap: Map<string, IHubConnectionData> = new Map();

  constructor(private context: IUserContext) {}

  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);
    this._channelRecipientMapping.delete(transport);
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    if (message.body.type == BodyTypes.kBlockMessage) {
      const blockMessage = message.body as BlockMessage;
      const recipientChannelMap = this._channelRecipientMapping.get(transport);
      let channel = recipientChannelMap?.get(message.header.from);
      if (!channel) {
        if (
          this.context.getOptions().onExternalChannelRequestCallback &&
          this.context.getOptions().onExternalChannelRequestCallback!(message.header.from)
        ) {
          channel = await this.openChannel(message.header.from, transport);
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

    const transport = this.context.getTransportFactory().create(data, this.context.getAddress(), data.name);
    this._transports.set(data.name, transport);
    transport.setReceiver(this);

    this._channelRecipientMapping.set(transport, new Map());

    await transport.open();
  }

  async start() {
    const signer = await this.context.getSigner();
    if (signer == null) {
      Logger.error(`Cannot get user information from RPC server with id ${this.context.getAddress()}`);
      return;
    }

    for (const opt of this.context.getOptions().hubConnectionDataList) {
      await this.addHub(opt);
    }
    await this.context.getStorageContext().initialize(this.context.getAddress());
  }

  async getChannelToHub(hubName: string): Promise<IChannel> {
    Logger.info(`Open channel to hub ${hubName}`);

    const transport = this._transports.get(hubName);
    if (!transport) {
      throw new Error(`Not found connection for hub with name ${hubName}`);
    }

    const address = this._hubInfoMap.get(hubName)!.address;

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    const channel = recipientChannelMap?.get(address);
    if (!channel) {
      return await this.openChannel(address, transport);
    }

    return channel;
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


  // TODO save fromBlockNumber to the storage
  startDepositoryEventsListener(fromBlockNumber : number) : void {
    //const fromBlockNumber = 3; // Replace with the desired starting block number

    const eventFilter = this.context.depository.filters.TransferReserveToCollateral();
    this.context.depository.queryFilter(eventFilter, fromBlockNumber).then((pastEvents) => {
      pastEvents.forEach((event) => {
        const { receiver, addr, collateral, ondelta, tokenId } = event.args;
        console.log(receiver, addr, collateral, ondelta, tokenId, event);
      });
    });

    // Listen for future events starting from the latest block
    this.context.depository.on<TransferReserveToCollateralEvent.Event>(
      eventFilter,
      (receiver, addr, collateral, ondelta, tokenId, event) => {
        console.log(receiver, addr, collateral, ondelta, tokenId, event);
      }
    );
  }

  async externalTokenToReserve(erc20Address: string, amount: BigNumberish): Promise<void> 
  {
    let erc20Mock: ERC20Mock = ERC20Mock__factory.connect(erc20Address, this.context.signer);
    let depository = this.context.depository;
    let thisUserAddress = this.context.getAddress();

    const testAllowance1 = await erc20Mock.allowance(thisUserAddress, await depository.getAddress());

    await erc20Mock.approve(await depository.getAddress(), amount);
    //await erc20Mock.transfer(await depository.getAddress(), 10000);
    
    console.log("user1_balance_before", await erc20Mock.balanceOf(thisUserAddress));
    console.log("depository_balance_before", await erc20Mock.balanceOf(await depository.getAddress()));

    const packedToken = await depository.packTokenReference(0, await erc20Mock.getAddress(), 0);
    //console.log(packedToken);
    //console.log(await depository.unpackTokenReference(packedToken));
    //console.log(await erc20Mock.getAddress());
          
    await depository.externalTokenToReserve(
      { packedToken, internalTokenId: 0n, amount: 10n }
    );
    
    console.log("user1_balance_after", await erc20Mock.balanceOf(thisUserAddress))
    console.log("depository_balance_after", await erc20Mock.balanceOf(await depository.getAddress()))
    console.log("reserveTest1", await depository._reserves(thisUserAddress, 0));
  }

  async reserveToCollateral(otherUserOfChannelAddress: string, tokenId: number, amount: BigNumberish): Promise<void>
  {
    let depository = this.context.depository;
    let thisUserAddress = this.context.getAddress();

    await depository.reserveToCollateral({
      tokenId: tokenId,
      receiver: thisUserAddress,
      pairs: [{ addr: otherUserOfChannelAddress, amount: amount }]
    });
  
    const collateralTest = await depository._collaterals(
      await depository.channelKey(thisUserAddress, otherUserOfChannelAddress), tokenId
      );
    const reserveTest2 = await depository._reserves(thisUserAddress, tokenId);
  }

  private async openChannel(recipientUserId: string, transport: ITransport): Promise<IChannel> {
    const channel = new Channel(this.makeChannelContext(recipientUserId, transport));
    await channel.initialize();

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    recipientChannelMap?.set(recipientUserId, channel);

    return channel;
  }

  private makeChannelContext(recipientUserId: string, transport: ITransport): IChannelContext {
    return new ChannelContext(this.context, recipientUserId, transport);
  }
}
