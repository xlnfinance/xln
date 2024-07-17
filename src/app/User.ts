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

import StorageContext from './StorageContext';
import CreateSubchannelTransition from '../types/Transitions/CreateSubchannelTransition';
import AddCollateralTransition from '../types/Transitions/AddCollateralTransition';
import { MoneyValue } from '../types/SubChannel';
import SetCreditLimitTransition from '../types/Transitions/SetCreditLimitTransition';
import UnsafePaymentTransition from '../types/Transitions/UnsafePaymentTransition';


import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import Transport from './Transport';


import {encode, decode} from '../utils/Codec';


const TEMP_ENV = {
  hubAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  firstUserAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  secondUserAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  depositoryContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  erc20Address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  rpcNodeUrl: 'http://127.0.0.1:8545',
};

export default class User implements ITransportListener  {
  // Hub-specific properties
  private _server!: WebSocket.Server<typeof WebSocket, typeof import('http').IncomingMessage>;
  private _channels: Map<string, Channel> = new Map();
  
  private _transports: Map<string, ITransport> = new Map();
  private _channelRecipientMapping: Map<ITransport, Map<string, IChannel>> = new Map();
  private _hubInfoMap: Map<string, IHubConnectionData> = new Map();

  thisUserAddress: string;
  opt: IUserOptions;

  storageContext: StorageContext;

  provider!: JsonRpcProvider;
  signer!: Signer;
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;

  sectionQueue: any = {};


  constructor(address: string, opt: IUserOptions) {    
    this.thisUserAddress = address;
    this.opt = opt;
    this.storageContext = new StorageContext();

    if (address == opt.hubConnectionDataList[0].address) {
      console.log("we are hub",this.opt.hub)
    }
  }

  // Combined onClose method
  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);
    //this._channelRecipientMapping.delete(transport);

    Logger.info(`Client disconnected ${id}`);
  }



  
  // Combined onReceive method
  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    console.log('onReceive', this.thisUserAddress, message)

    if (message.body.type == BodyTypes.kBlockMessage) {
      const blockMessage: BlockMessage = message.body as BlockMessage;

      const recipientChannelMap = this._channelRecipientMapping.get(transport);
      const addr = message.header.from;

      await this.section(addr, async () => {
        let channel = recipientChannelMap?.get(addr);
        if (!channel) {
          if (this.opt.hub ||
            this.opt.onExternalChannelRequestCallback && this.opt.onExternalChannelRequestCallback!(addr)) {
            channel = await this.openChannel(addr, transport);
          } else {
            throw new Error("External channel request");
          }
        }

        if (channel) {
          try {
            await channel.receive(blockMessage);
          } catch (e) {
            Logger.error(e);
          }
        }
      });

    } else if (message.header.to !== this.opt.hub?.address) {
      const recipientUserId = message.header.to;
      if (this._transports.has(recipientUserId)) {
        const transport = this._transports.get(recipientUserId);
        await transport!.send(message);
      } else {
        //TODO send error
      }

    } else {
      throw new Error('Not implemented section');


  
    }
  }



 

  async addHub(data: IHubConnectionData) {
    if (this._transports.has(data.address)) {
      return;
    }

    this._hubInfoMap.set(data.address, data);
    const transport = new Transport({
        id: data.address,
        receiver: this,
        connectionData: data,
        userId: this.thisUserAddress
    });
      

    this._transports.set(data.address, transport);

    this._channelRecipientMapping.set(transport, new Map());

    await transport.open();
  }

  
  async start() {
    const signer = await this.getSigner();
    if (signer == null) {
      Logger.error(`Cannot get user information from RPC server with id ${this.thisUserAddress}`);
      return;
    }
    await this.storageContext.initialize(this.thisUserAddress);

    // Start hub if this is a hub
    if (this.opt.hub) {
      console.log("Starting hub");
      await this.startHub();
    } else {
      for (const opt of this.opt.hubConnectionDataList) {
        await this.addHub(opt);
      }
  
    }


  }

  // Hub-specific startHub method
  async startHub(): Promise<void> {
    if (!this.opt.hub) {
      throw new Error("This user is not configured as a hub");
    }

    Logger.info(`Start listen ${this.opt.hub.host}:${this.opt.hub.port}`);

    this._server = new WebSocket.Server({ port: this.opt.hub.port, host: this.opt.hub.host || '127.0.0.1' });

    this._server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const userId = req.headers.authorization;
      if (!userId) {
        Logger.error('Try connect user without identification information');
        ws.close();
        return;
      }

      Logger.info(`New user connection with id ${userId}`);
        
      const transport = new Transport({
        id: userId,
        receiver: this,
        ws: ws
      });
      this._transports.set(userId, transport);
      
    });
  }

  // Modified getChannel method to work for both user and hub
  async getChannel(userId: string): Promise<IChannel> {
    Logger.info(`Open channel to <user/hub> ${userId}`);

    let transport = this._transports.get(userId);
    let channel: IChannel | undefined;

    if (!transport) {
      // Check if this is a hub and the channel is for a connected user
      if (this.opt.hub && this._transports.has(userId)) {
        transport = this._transports.get(userId)!;
      } else {
        throw new Error(`Not found connection for hub/user with name ${userId}`);
      }
    }

    const recipientChannelMap = this._channelRecipientMapping.get(transport);
    channel = recipientChannelMap?.get(userId) || this._channels.get(userId);

    if (!channel) {
      channel = await this.openChannel(userId, transport);
      if (this.opt.hub) {
        this._channels.set(userId, channel as Channel);
      }
    }

    return channel;
  }
  // TODO думаю надо две разные функции getChannel и openChannel. Наверно лучше явно открывать канал, если необходимо
  async getChannel2(userId: string): Promise<IChannel> {
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
    console.log("Working state ", channel.getState());

    // send notification to the other party to create the same subchannel on the other side
    // TODO: should we await here for flush to be completed?
    // если сначала создать саб-канал, а затем отправить сообщение, то мы снимем хеш с состояния, где есть один сабканал
    // а на другой стороне revious state hash будет без этого сабканала и не сработает
    const t: CreateSubchannelTransition = new CreateSubchannelTransition(chainId);
    channel.push(t);
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

    //TODO это должно быть внутри канала, функцией. 
    const t: AddCollateralTransition = new AddCollateralTransition(chainId, tokenId, channel.isLeft(), collateral);
    await channel.push(t);
  }
  async setCreditLimit(userId: string, chainId: number, tokenId: number, creditLimit: MoneyValue): Promise<void> {
    const channel = await this.getChannel(userId);

    //TODO это должно быть внутри канала, функцией. 
    const t: SetCreditLimitTransition = new SetCreditLimitTransition(chainId, tokenId, channel.isLeft(), creditLimit);
    await channel.push(t);
    channel.flush();
  }

  async unsafePayment(toUserId: string, routeFirstHopId: string, chainId: number, tokenId: number, amount: MoneyValue): Promise<void> {
    const channel = await this.getChannel(routeFirstHopId);

    const t = Object.assign(new UnsafePaymentTransition(), {
      toUserId: toUserId,
      fromUserId: this.thisUserAddress,
      chainId: chainId,
      tokenId: tokenId,
      isLeft: channel.isLeft(), //TODO это может вычисляться на лету, кроме того наверно лучше сделать isLeft(userId), так понятнее?
      offdelta: amount,
    });
    channel.push(t);
    channel.flush();
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

  


  // https://en.wikipedia.org/wiki/Critical_section
  async section(key: string, job: any): Promise<void> {
    return new Promise(async (resolve) => {
      //key = encode(key)

      if (this.sectionQueue[key]) {
        if (this.sectionQueue[key].length > 10) {
          throw new Error ('Queue overflow for: ' + key)
        }

        this.sectionQueue[key].push([job, resolve])
      } else {
        this.sectionQueue[key] = [[job, resolve]]

        while (this.sectionQueue[key].length > 0) {
          try {
            const [got_job, got_resolve] = this.sectionQueue[key].shift()
            //const started = performance.now()

            //let deadlock = setTimeout(function() {
            //  this.fatal('Deadlock in q ' + key)
            //}, 20000)

            got_resolve(await got_job())

            //clearTimeout(deadlock)
            //l('Section took: ' + (performance.now() - started))
          } catch (e) {
            console.log('Error in critical section: ', e)
            setTimeout(() => {
              throw new Error(e as any);
            }, 100)
          }
        }
        delete this.sectionQueue[key]
      }
    })
  }
}






