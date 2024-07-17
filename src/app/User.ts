import IChannel from '../types/IChannel';
import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportListener from '../types/ITransportListener';
import FlushMessage from '../types/Messages/FlushMessage';
import Logger from '../utils/Logger';
import Channel from './Channel';
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





import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import Transport from './Transport';


import {encode, decode} from '../utils/Codec';


import { performance } from 'perf_hooks';


type Job<T> = () => Promise<T>;
type QueueItem<T> = [Job<T>, (value: T | PromiseLike<T>) => void];

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
  private _server: WebSocket.Server | null = null; // cannot be readonly because it is assigned in start()
  private readonly _channels: Map<string, Channel> = new Map();
  private readonly _transports: Map<string, ITransport> = new Map();
  private readonly _channelRecipientMapping: Map<ITransport, Map<string, IChannel>> = new Map();
  private readonly _hubInfoMap: Map<string, IHubConnectionData> = new Map();
  private readonly sectionQueue: Record<string, QueueItem<any>[]> = {};

  public readonly thisUserAddress: string;
  public readonly opt: Readonly<IUserOptions>;
  public readonly storageContext: StorageContext;

  private provider: JsonRpcProvider | null = null;
  private signer: Signer | null = null;


  
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;


  
  constructor(address: string, opt: IUserOptions) {    
    this.thisUserAddress = address;
    this.opt = Object.freeze({ ...opt });
    this.storageContext = new StorageContext();

    if (address == opt.hubConnectionDataList[0].address) {
      console.log("we are hub",this.opt.hub)
    }
  }

  // Combined onClose method
  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);
    this._channelRecipientMapping.delete(transport);

    Logger.info(`Client disconnected ${id}`);
  }



  get isHub(): boolean {
    return this.thisUserAddress === this.opt.hubConnectionDataList[0].address;
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    console.log(`Received message from ${message.header.from} to ${message.header.to}`, message.body);
    //try {
      if (message.body.type === BodyTypes.kFlushMessage) {
        await this.handleFlushMessage(transport, message as IMessage & { body: FlushMessage });
      } else if (message.header.to !== this.opt.hub?.address) {
        await this.handleProxyMessage(message);
      } else {
        throw new Error('Unhandled message type');
      }
    // } catch (error) {
     // Logger.error('Unexpected error:', error);
      // Implement general error recovery
      
    //}
  }
  

  private async handleFlushMessage(transport: ITransport, message: IMessage & { body: FlushMessage }): Promise<void> {
    const addr = message.header.from;
    await this.criticalSection(addr, async () => {
      const channel = await this.getChannel(addr);

      if (channel.getState().blockNumber === 0) {
        Logger.info(`Channel ${addr} is not initialized yet`);

      } 
      
      

      try {
        await channel.receive(message.body);
      } catch (e) {
        Logger.error('Error processing block message', e);
      }
    
    });
  }
  
  private async handleProxyMessage(message: IMessage): Promise<void> {
    const recipientTransport = this._transports.get(message.header.to);
    if (recipientTransport) {
      await recipientTransport.send(message);
    } else {
      Logger.warn(`No transport found for recipient: ${message.header.to}`);
    }
  }

  public async getChannel(userId: string): Promise<IChannel> {
    let channel = this._channels.get(userId);
    if (!channel) {
      channel = new Channel(new ChannelContext(this, userId));
      await channel.load();
    }
    return channel;
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
    console.log("Adding hub", data)


    await transport.open();
  }

  public async send(addr: string, message: IMessage): Promise<void> {
    const transport = this._transports.get(addr);
    if (!transport) {
      throw new Error('Transport not found');
      return;
    }

    return transport.send(message);
  }

  
  async start() {
    const signer = await this.getSigner();
    if (signer == null) {
      Logger.error(`Cannot get user information from RPC server with id ${this.thisUserAddress}`);
      return;
    }
    await this.storageContext.initialize(this.thisUserAddress);

    // Start hub if this is a hub

    if (this.isHub) {
      await this.startHub();
    } else {
      await Promise.all(this.opt.hubConnectionDataList.map(opt => this.addHub(opt)));
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


  
  /*

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


    await depository.externalTokenToReserve(
      { packedToken, internalTokenId: 0n, amount: 10n }
    );

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
  async test_reserveToCollateral(userId: string, chainId: number, tokenId: number, collateral: bigint): Promise<void> {
    const channel = await this.getChannel(userId);

    //TODO это должно быть внутри канала, функцией. 
    const t: AddCollateralTransition = new AddCollateralTransition(chainId, tokenId, channel.isLeft(), collateral);
    await channel.push(t);
  }


  
  async unsafePayment(toUserId: string, routeFirstHopId: string, chainId: number, tokenId: number, amount: bigint): Promise<void> {
    const channel = await this.getChannel(routeFirstHopId);

    const t = Object.assign(new UnsafePaymentTransition(), {
      toUserId: toUserId,
      fromUserId: this.thisUserAddress,
      chainId: chainId,
      tokenId: tokenId,
      isLeft: channel.isLeft(), //TODO это может вычисляться на лету, кроме того наверно лучше сделать isLeft(userId), так понятнее?
      offdelta: amount,
    });
    await channel.push(t);
    await channel.flush();
  }

  */



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
    return true //ethersVerifyMessage(message, signature) === senderAddress;
  }

  /**
   * https://en.wikipedia.org/wiki/Critical_section
   * Executes a job in a critical section, ensuring mutual exclusion.
   * @param key - The unique identifier for the critical section.
   * @param job - The asynchronous job to be executed.
   * @returns A promise that resolves with the result of the job.
   */
  async criticalSection<T>(key: string, job: Job<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.sectionQueue[key]) {
        if (this.sectionQueue[key].length >= 10) {
          reject(new Error(`Queue overflow for: ${key}`));
          return;
        }
        this.sectionQueue[key].push([job, resolve]);
      } else {
        this.sectionQueue[key] = [[job, resolve]];
        this.processQueue(key).catch(reject);
      }
    });
  }

  private async processQueue(key: string): Promise<void> {
    while (this.sectionQueue[key]?.length > 0) {
      const [job, resolve] = this.sectionQueue[key].shift()!;
      const start = performance.now();

      try {
        const result = await Promise.race([
          job(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Job timeout')), 20000))
        ]);
        resolve(result);
      } catch (error) {
        Logger.error(`Error in critical criticalSection ${key}:`, error);
        resolve(Promise.reject(error));
      }

      Logger.debug(`Section ${key} took ${performance.now() - start} ms`);
    }

    delete this.sectionQueue[key];
  }



  
}






