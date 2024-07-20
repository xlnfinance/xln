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
import Transition from './Transition';




import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import Transport from './Transport';


import {encode, decode} from '../utils/Codec';
import { AsciiUI } from '../utils/AsciiUI';

import { performance } from 'perf_hooks';


type Job<T> = () => Promise<T>;
type QueueItem<T> = [Job<T>, (value: T | PromiseLike<T>) => void];

import ENV from '../../test/env';

export default class User implements ITransportListener  {
  // Hub-specific properties
  private _server: WebSocket.Server | null = null; // cannot be readonly because it is assigned in start()
  public _channels: Map<string, Channel> = new Map();
  private readonly _transports: Map<string, ITransport> = new Map();
  private readonly _channelRecipientMapping: Map<ITransport, Map<string, Channel>> = new Map();

  private readonly sectionQueue: Record<string, QueueItem<any>[]> = {};

  public readonly thisUserAddress: string;
  public readonly opt: Readonly<IUserOptions>;
  public readonly storageContext: StorageContext;

  private provider: JsonRpcProvider | null = null;
  public signer: Signer | null = null;

  public logger: Logger;

  
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;


  
  constructor(address: string, opt: IUserOptions) {    
    this.logger = new Logger(address);
    this.thisUserAddress = address;
    this.opt = Object.freeze({ ...opt });
    this.storageContext = new StorageContext();
    this.logger.log('new User() constructed '+address);

  }

  // Combined onClose method
  onClose(transport: ITransport, id: string): void {
    this._transports.delete(id);

    this.criticalSection(id, async () => {
      if (this._channels.get(id)) {
        await this._channels.get(id)?.save();
        console.log("Freeing up channel slot "+id)
        this._channels.delete(id);
      }

    })

    this.logger.info(`Client disconnected ${id}`);
  }



  get isHub(): boolean {
    return this.opt.hub !== undefined;
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    this.logger.log(`Received message from ${message.header.from} to ${message.header.to}`, message.body);
    //try {
      if (this.isHub && message.header.to !== this.thisUserAddress) {
        await this.handleProxyMessage(message);
      } else if (message.body.type === BodyTypes.kFlushMessage) {
        await this.handleFlushMessage(transport, message as IMessage & { body: FlushMessage });
      } else {
        throw new Error('Unhandled message type');
      }
    // } catch (error) {
     // this.logger.error('Unexpected error:', error);
      // Implement general error recovery
      
    //}
  }
  

  private async handleFlushMessage(transport: ITransport, message: IMessage & { body: FlushMessage }): Promise<void> {
    const addr = message.header.from;
    await this.criticalSection(addr, async () => {
      const channel = await this.getChannel(addr);

      if (channel.getState().blockNumber === 0) {
        this.logger.info(`Channel ${addr} is not initialized yet`);
      } 
      
      

      //try {
        await channel.receive(message.body);
      //} catch (e) {
       // this.logger.error('Error processing block message', e);
      //}
    
    });
  }
  
  private async handleProxyMessage(message: IMessage): Promise<void> {
    const recipientTransport = this._transports.get(message.header.to);
    if (recipientTransport) {
      await recipientTransport.send(message);
    } else {
      throw new Error(`No transport found for recipient: ${message.header.to}`);
    }
  }

  public async getChannel(userId: string): Promise<Channel> {
    let channel = this._channels.get(userId);
    if (!channel) {
      channel = new Channel(new ChannelContext(this, userId));
      await channel.load();
      this._channels.set(userId, channel);
    }
    return channel;
  }
 

  async addHub(data: IHubConnectionData) {
    if (this._transports.has(data.address)) {
      return this._transports.get(data.address);
    }

    const transport = new Transport({
        id: data.address,
        receiver: this,
        connectionData: data,
        userId: this.thisUserAddress
    });

    this._transports.set(data.address, transport);
    this.logger.log("Adding hub", data)


    await transport.open();
  }

  public async send(addr: string, message: IMessage): Promise<void> {
    let transport = this._transports.get(this._transports.has(addr) ? addr : ENV.hubAddress);
    if (!transport) {
      this.logger.error(`Transport not found for ${addr}`);
      return;
    }

    return transport.send(message);
  }

  
  async start() {
    const signer = await this.getSigner();
    if (signer == null) {
      this.logger.error(`Cannot get user information from RPC server with id ${this.thisUserAddress}`);
      return;
    }
    await this.storageContext.initialize(this.thisUserAddress);

    // Start hub if this is a hub

    if (this.isHub) {
      await this.startHub();
    } else {
      if (this.opt.hubConnectionDataList && this.opt.hubConnectionDataList.length > 0) {
        await Promise.all(this.opt.hubConnectionDataList.map(opt => this.addHub(opt)));
      }    
    }
  }

  async connectTo(address: string): Promise<void> {
    await this.addHub({ host: '127.0.0.1', port: 10000, address: address });
  }

  // Hub-specific startHub method
  async startHub(): Promise<void> {
    if (!this.opt.hub) {
      throw new Error("This user is not configured as a hub");
    }

    this.logger.info(`Start listen ${this.opt.hub.host}:${this.opt.hub.port}`);

    this._server = new WebSocket.Server({ port: this.opt.hub.port, host: this.opt.hub.host || '127.0.0.1' });

    this._server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const userId = req.headers.authorization;
      if (!userId) {
        this.logger.error('Try connect user without identification information');
        ws.close();
        return;
      }


      this.logger.info(`New user connection with id ${userId}`);
        
      const transport = new Transport({
        id: userId,
        receiver: this,
        ws: ws
      });
      this._transports.set(userId, transport);
      
    });

  }

  async renderAsciiUI(): Promise<string> {
    return AsciiUI.renderUser(this);
  }
  
  async forwardPayment(payment: Transition.AddPaymentSubcontract, nextHops: string[]): Promise<void> {
    const nextHop = nextHops.pop();
    if (nextHop) {
      const nextChannel = await this.getChannel(nextHop);
      const delta = nextChannel.getDelta(payment.chainId, payment.tokenId);
      if (delta) {
        const outboundCapacity = nextChannel.deriveDelta(payment.chainId, payment.tokenId).outCapacity;
        if (outboundCapacity >= payment.amount) {
          const newPayment = new Transition.AddPaymentSubcontract(
            payment.chainId,
            payment.tokenId,
            payment.amount,
            payment.hash,
            nextHops
          );
          nextChannel.push(newPayment);
          nextChannel.flush();
        } else {
          this.logger.error("Insufficient outbound capacity for forwarding payment");
        }
       }
    } else {
      this.logger.log("Final receiver reached for payment");
     }
  }
  /*

  // TODO save fromBlockNumber to the storage
  startDepositoryEventsListener(fromBlockNumber: number): void {
    //const fromBlockNumber = 3; // Replace with the desired starting block number

    const eventFilter = this.depository.filters.TransferReserveToCollateral();
    this.depository.queryFilter(eventFilter, fromBlockNumber).then((pastEvents) => {
      pastEvents.forEach((event) => {
        const { receiver, addr, collateral, ondelta, tokenId } = event.args;
        this.logger.log(receiver, addr, collateral, ondelta, tokenId, event);
      });
    });

    // Listen for future events starting from the latest block
    this.depository.on<TransferReserveToCollateralEvent.Event>(
      eventFilter,
      (receiver, addr, collateral, ondelta, tokenId, event) => {
        this.logger.log(receiver, addr, collateral, ondelta, tokenId, event);
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

    this.logger.log('user1_balance_before', await erc20Mock.balanceOf(thisUserAddress));
    this.logger.log('depository_balance_before', await erc20Mock.balanceOf(await depository.getAddress()));

    const packedToken = await depository.packTokenReference(0, await erc20Mock.getAddress(), 0);
    //this.logger.log(packedToken);
    //this.logger.log(await depository.unpackTokenReference(packedToken));
    //this.logger.log(await erc20Mock.getAddress());


    await depository.externalTokenToReserve(
      { packedToken, internalTokenId: 0n, amount: 10n }
    );

    this.logger.log('user1_balance_after', await erc20Mock.balanceOf(thisUserAddress));
    this.logger.log('depository_balance_after', await erc20Mock.balanceOf(await depository.getAddress()));
    this.logger.log('reserveTest1', await depository._reserves(thisUserAddress, 0));
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

        this.depository = Depository__factory.connect(ENV.depositoryContractAddress, this.signer);

        //this.depository.queryFilter(TransferReserveToCollateralEvent, 1, 5);
        //const eventsFilter = this.depository.filters.TransferReserveToCollateral();

        //this.depository.on<TransferReserveToCollateralEvent.Event>(
        //    eventsFilter1,
        //    (receiver, addr, collateral, ondelta, tokenId, event) => {
        //      this.logger.log(receiver, addr, collateral, ondelta, tokenId, event);
        //    },
        //);
      } catch (exp: any) {
        //this.signer = null;
        this.logger.error(exp);
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

      // try {
        const result = await Promise.race([
          job(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Job timeout')), 20000))
        ]);
        resolve(result);
      //} catch (error: any) {
      //  this.logger.error(`Error in critical criticalSection ${key}:`, error);
      //  resolve(Promise.reject(error));
      //}

      this.logger.debug(`Section ${key} took ${performance.now() - start} ms`);
    }

    delete this.sectionQueue[key];
  }



  
}






