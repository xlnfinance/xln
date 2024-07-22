import IMessage from '../types/IMessage';
import ITransport from '../types/ITransport';
import ITransportListener from '../types/ITransportListener';
import FlushMessage from '../types/Messages/FlushMessage';
import Logger from '../utils/Logger';
import Channel from './Channel';
import IChannelContext from '../types/IChannelContext';
import ChannelContext from './ChannelContext';

import { BodyTypes } from '../types/IBody';
import { TransferReserveToCollateralEvent } from '../../contracts/typechain-types/contracts/Depository.sol/Depository';
import { ethers, Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider, BigNumberish } from 'ethers';
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

import StorageContext from './StorageContext';
import Transition from './Transition';

import ENV, {HubData} from '../env';


import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import Transport from './Transport';

import { encrypt,decrypt, PrivateKey } from 'eciesjs';

import {encode, decode} from '../utils/Codec';
import { AsciiUI } from '../utils/AsciiUI';

import { performance } from 'perf_hooks';


type Job<T> = () => Promise<T>;
type QueueItem<T> = [Job<T>, (value: T | PromiseLike<T>) => void];



export default class User implements ITransportListener  {
  // Hub-specific properties
  public _server: WebSocket.Server | null = null; // cannot be readonly because it is assigned in start()
  public _channels: Map<string, Channel> = new Map();
  public readonly _transports: Map<string, ITransport> = new Map();
  public channels: Map<string, Channel> = new Map();

  public readonly sectionQueue: Record<string, QueueItem<any>[]> = {};

  public readonly thisUserAddress: string;

  public readonly storageContext: StorageContext;

  public provider: JsonRpcProvider | null = null;
  public signer: ethers.Wallet | null = null;

  public logger: Logger;

  public encryptionKey: PrivateKey;

  
  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;

  public profiles: Map<string, any> = new Map();

  
  constructor(public username: string, public password: string) {    
    this.storageContext = new StorageContext();
    const seed = ethers.keccak256(ethers.toUtf8Bytes(username + password));
    this.signer = new ethers.Wallet(seed);
    this.encryptionKey = new PrivateKey(Buffer.from(seed.slice('0x'.length), 'hex'));

    this.thisUserAddress = this.signer.address;
    this.logger = new Logger(this.thisUserAddress);
    this.logger.log(`new User() constructed ${this.thisUserAddress} ${this.encryptionKey.publicKey.toHex()} ${this.encryptionKey.secret.toString('hex')}`);

  }

  async broadcastProfile() {
    const profile = {
      address: this.thisUserAddress,
      publicKey: this.encryptionKey.publicKey.toHex(),
      hubs: ENV.hubDataList.map(hub => hub.address),
    };
    ENV.profiles[profile.address] = profile;

    const encodedProfile = encode(profile);    
    // Assuming the first hub in the list is the coordinator
    const coordinatorHub = ENV.hubDataList[0];
    await this.send(coordinatorHub.address, {
      header: {
        from: this.thisUserAddress,
        to: coordinatorHub.address,
      },
      body: {
        type: BodyTypes.kBroadcastProfile,
        profile: encodedProfile,
      },
    });
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


  getHub(): HubData | undefined {
    const hub = ENV.hubDataList.find(hub => hub.address === this.thisUserAddress);
    return hub;
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    this.logger.log(`Received message from ${message.header.from} to ${message.header.to}`, message.body);
    //try {
      if (message.body.type === BodyTypes.kBroadcastProfile) {
        await this.handleBroadcastProfile(message);
      } else if (message.body.type === BodyTypes.kGetProfile) {
        await this.handleGetProfile(message);
      } if (this.getHub() && message.header.to !== this.thisUserAddress) {
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
  

  private async handleBroadcastProfile(message: IMessage) {
    const profile = decode(message.body.profile);
    this.profiles.set(profile.address, profile);
  }

  private async handleGetProfile(message: IMessage) {
    const profile = this.profiles.get(message.body.address);
    if (profile) {
      await this.send(message.header.from, {
        header: {
          from: this.thisUserAddress,
          to: message.header.from,
        },
        body: {
          type: BodyTypes.kGetProfileResponse,
          profile: encode(profile),
        },
      });
    }
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
 

  async addHub(data: HubData) {
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
      throw new Error(`Transport not found for ${addr}`);
      this.logger.error(`Transport not found for ${addr}`);
      return;
    }

    return transport.send(message);
  }

  
  async start() {
    this.broadcastProfile();

    const signer = await this.getSigner();
    if (signer == null) {
      this.logger.error(`Cannot get user information from RPC server with id ${this.thisUserAddress}`);
      return;
    }

    await this.storageContext.initialize(this.thisUserAddress);

    // Start hub if this is a hub

    if (this.getHub()) {
      await this.startHub();
    } else {
      if (ENV.hubDataList && ENV.hubDataList.length > 0) {
        await Promise.all(ENV.hubDataList.map(opt => this.addHub(opt)));
      }    
    }
  }

  // Hub-specific startHub method
  async startHub(): Promise<void> {
    const hub = this.getHub();
    if (!this.getHub()) {
      throw new Error("This user is not configured as a hub");
    }

    this.logger.info(`Websocket Server started ${hub!.host}:${hub!.port}`);

    this._server = new WebSocket.Server({ port: hub!.port, host: hub!.host || '127.0.0.1' });

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

  public async stop() {
    // disconnect all scokets
    for (const id of this._transports.keys()) {
      const transport = this._transports.get(id);
      if (transport) {
        transport.close();
      }
    }


    // Implementation for stopping the user
    // This might involve closing channels, saving state, etc.
  }
  async renderAsciiUI(): Promise<string> {
    return AsciiUI.renderUser(this);
  }
  
  async getBalance(): Promise<bigint> {
    return 123n;
  }

  async getChannels(): Promise<Channel[]> {
    return Array.from(this._channels.values());
  }


  async createChannel(peerAddress: string): Promise<Channel> {
    const channel = new Channel(new ChannelContext(this, peerAddress));
    await channel.load();
    this._channels.set(peerAddress, channel);

    return channel;
  }

  async encryptMessage(recipientAddress: string, message: string): Promise<string> {
    const recipient = await this.getProfile(recipientAddress);
    return encrypt(recipient.publicKey, Buffer.from(message)).toString('hex');
  }

  async decryptMessage(senderAddress: string, encryptedMessage: string): Promise<string> {
    const decrypted = await decrypt(this.encryptionKey.secret, Buffer.from(encryptedMessage, 'hex'));
    return decrypted.toString();
  }
  async getProfile(address: string): Promise<any> {
    return ENV.profiles[address];
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
 

  */



  public async createOnionEncryptedPayment(recipient: string, amount: bigint, chainId: number, tokenId: number, route: string[]): Promise<Transition.AddPayment> {
    const secret = crypto.getRandomValues(Buffer.alloc(32)).toString('hex');
    console.log(`Creating onion encrypted payment ${secret}: ${amount} from ${this.thisUserAddress} to ${recipient}`);

    const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));
    const timelock = Math.floor(Date.now() / 1000) + 3600; // 1 hour timelock

    let encryptedPackage = await this.encryptForRecipient(recipient, {
      amount,
      tokenId,
      secret,
      finalRecipient: recipient
    });

    for (let i = route.length - 1; i >= 0; i--) {
      encryptedPackage = await this.encryptForRecipient(route[i], {
        amount,
        tokenId,
        nextHop: i === route.length - 1 ? recipient : route[i + 1],
        encryptedPackage
      });
    }

    return new Transition.AddPayment(
      chainId,
      tokenId,
      amount,
      hashlock,
      timelock,
      encryptedPackage
    );
  }

  public async encryptForRecipient(recipient: string, data: any): Promise<string> {
    const recipientProfile = await this.getProfile(recipient);
    const encoded = encode(data);
    const encrypted = await encrypt(recipientProfile.publicKey, Buffer.from(encoded));
    return encrypted.toString('hex');
  }

  public async decryptPackage(encryptedPackage: string): Promise<any> {
    const decrypted = await decrypt(this.encryptionKey.secret, Buffer.from(encryptedPackage, 'hex'));
    return decode(decrypted);
  }

  public async processPayment(channel: Channel, payment: Transition.AddPayment): Promise<void> {
    const derivedDelta = channel.deriveDelta(payment.chainId, payment.tokenId, channel.isLeft);
    if (derivedDelta.outCapacity < payment.amount) {
      throw new Error('Insufficient capacity');
    }

    try {
      const decryptedPackage = await this.decryptPackage(payment.encryptedPackage);
      console.log(`Processing payment in ${this.thisUserAddress}: ${payment.amount}`);
      console.log(`Decrypted package:`, decryptedPackage);

      if (decryptedPackage.finalRecipient === this.thisUserAddress) {
        // Final recipient
        await this.settlePayment(channel, payment, decryptedPackage.secret);
      } else {
        // Intermediate node
        const fee = this.calculateFee(payment.amount);
        const forwardAmount = payment.amount - fee;
        const nextChannel = await this.getChannel(decryptedPackage.nextHop);
        const forwardPayment = new Transition.AddPayment(
          payment.chainId,
          payment.tokenId,
          forwardAmount,
          payment.hashlock,
          payment.timelock,
          decryptedPackage.encryptedPackage
        );

        await this.forwardPayment(nextChannel, forwardPayment);
      }
    } catch (error: any) {
      await this.cancelPayment(channel, payment, error.message);
    }
  }

  public calculateFee(amount: bigint): bigint {
    const FEE_RATE = 0.001; // 0.1% fee
    return amount * BigInt(Math.floor(FEE_RATE * 10000)) / 10000n;
  }

  public async forwardPayment(channel: Channel, payment: Transition.AddPayment): Promise<void> {
    await channel.push(payment);
    await channel.flush();

    const FORWARD_TIMEOUT = 30000; // 30 seconds
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Payment forwarding timeout')), FORWARD_TIMEOUT)
    );

    try {
      await Promise.race([this.waitForPaymentSettlement(channel, payment.hashlock), timeout]);
    } catch (error: any) {
      await this.cancelPayment(channel, payment, error.message);
      throw error;
    }
  }

  public async waitForPaymentSettlement(channel: Channel, hashlock: string): Promise<void> {
    // Implementation depends on how you're notifying about payment settlements
    // This is a placeholder
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.isPaymentSettled(channel, hashlock)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  public isPaymentSettled(channel: Channel, hashlock: string): boolean {
    // Implementation depends on how you're tracking payment settlements
    // This is a placeholder
    return false;
  }

  public async cancelPayment(channel: Channel, payment: Transition.AddPayment, reason: string): Promise<void> {
    const cancelTransition = new Transition.CancelPayment(payment.chainId, payment.tokenId, payment.amount, payment.hashlock);
    await channel.push(cancelTransition);
    await channel.flush();
    this.logger.error(`Payment cancelled: ${reason}`);
  }

  public async settlePayment(channel: Channel, payment: Transition.AddPayment, secret: string): Promise<void> {
    const settleTransition = new Transition.SettlePayment(payment.chainId, payment.tokenId, payment.amount, secret);
    await channel.push(settleTransition);
    await channel.flush();
    this.logger.info(`Payment settled: ${payment.amount} of token ${payment.tokenId} on chain ${payment.chainId}`);
  }
  async getSigner(): Promise<Signer | null> {
    if (!this.signer) {
      try {
        //this.provider = new JsonRpcProvider(ENV.jsonRPCUrl);
        //this.signer = await this.provider.getSigner(this.thisUserAddress);

        //this.depository = Depository__factory.connect(ENV.depositoryContractAddress, this.signer);

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
        this.processQueue(key) //.catch(reject);
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

