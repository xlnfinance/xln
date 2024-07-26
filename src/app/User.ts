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
import { sleep } from '../utils/Utils';
import { StoredSubcontract } from '../types/ChannelState';


type Job<T> = () => Promise<T>;
type QueueItem<T> = [Job<T>, string, (value: T | PromiseLike<T>) => void, (value: T | PromiseLike<T>) => void];



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

  
  public hashlockMap: Map<string, {
    inAddress?: string,
    outAddress?: string
    inTransitionId?: number,
    outTransitionId?: number,
    resolve?: (data: any) => void,
    reject?: (data: any) => void,
    secret?: string,
  }> = new Map();

  
  public mempoolMap: Map<string, Array<Transition.Any>> = new Map();

  addToMempool(address: string, transition: Transition.Any, flushNow: boolean = false) {
    if (!this.mempoolMap.has(address)) {
      this.mempoolMap.set(address, []);
    }
    this.mempoolMap.get(address)?.push(transition);
    
    if (flushNow) {
      return this.flushChannel(address);
    }
  }


  depository!: Depository;
  erc20Mock!: ERC20Mock;
  erc721Mock!: ERC721Mock;
  erc1155Mock!: ERC1155Mock;

  public profiles: Map<string, any> = new Map();

  
  constructor(public username: string, public password: string) {    
    this.storageContext = new StorageContext();
    const seed = ethers.keccak256(ethers.toUtf8Bytes(username + password));
    this.username = username;

    this.signer = new ethers.Wallet(seed);
    this.encryptionKey = new PrivateKey(Buffer.from(seed.slice('0x'.length), 'hex'));

    this.thisUserAddress = this.signer.address;
    ENV.nameToAddress[username] = this.thisUserAddress;

    this.logger = new Logger(username);
    this.logger.log(`new User() constructed ${this.thisUserAddress} ${this.encryptionKey.publicKey.toHex()} ${this.encryptionKey.secret.toString('hex')}`);

    ENV.users[this.thisUserAddress] = this;
    const profile = {
      name: this.username,
      address: this.thisUserAddress,
      publicKey: this.encryptionKey.publicKey.toHex(),
      hubs: ENV.hubDataList.map(hub => hub.address),
    };
    this.logger.log("Broadcasting profile", profile)
    ENV.profiles[profile.address] = profile;

    //this.periodicFlush();
  }

  async broadcastProfile() {
    const profile = ENV.profiles[this.thisUserAddress];
    const encodedProfile = encode(profile).toString('hex');    
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
    /*
    this.criticalSection(id, "onclose", async () => {
      if (this._channels.get(id)) {
        await this._channels.get(id)?.save();
        console.log("Freeing up channel slot "+id)
        this._channels.delete(id);
      }

    })
    */

    this.logger.info(`Client disconnected ${id}`);
  }


  getHub(): HubData | undefined {
    const hub = ENV.hubDataList.find(hub => hub.address === this.thisUserAddress);
    return hub;
  }

  async onReceive(transport: ITransport, message: IMessage): Promise<void> {
    this.logger.info(`Receive from ${this.toTag(message.header.from)}`, message);
    try {
      if (message.body.type === BodyTypes.kBroadcastProfile) {
        await this.handleBroadcastProfile(message);
      } else if (message.body.type === BodyTypes.kGetProfile) {
        await this.handleGetProfile(message);
      } else if (message.header.from == this.thisUserAddress) {
        this.logger.error("Proxy send failed")
        
        //await this.handleProxyMessage(message);
      } else if (this.getHub() && message.header.to !== this.thisUserAddress) {
        await this.handleProxyMessage(message);
      } else if (message.body.type === BodyTypes.kFlushMessage) {
        await this.handleFlushMessage(transport, message as IMessage & { body: FlushMessage });
      } else {
        this.logger.error('Unhandled message type', message.body);
      }
     } catch (error) {
      console.log('fatal onreceive', error)
      this.logger.error(`Fatal onreceive ${encode(error)}`, );
      throw(error)
      //process.exit(0)

      //this.logger.error('Unexpected error:', error);
      
     }
  }

  toTag(addr: string = this.thisUserAddress): string {
    
    
    return ENV.profiles[addr].name+" "+addr.substring(2,6) ;
  }
  

  private async handleBroadcastProfile(message: IMessage) {
    const profile = decode(Buffer.from(message.body.profile, 'hex'));
    this.profiles.set(profile.address, profile);
    this.logger.log('Received profile broadcast:', profile);
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
          type: BodyTypes.kBroadcastProfile,
          profile: encode(profile).toString('hex'),
        },
      });
    }
  }
  public flushable: string[]  = [];
  public addToFlushable(addr: string) {
    this.flushable.push(addr)
  }

  private async handleFlushMessage(transport: ITransport, message: IMessage & { body: FlushMessage }): Promise<void> {
    const addr = message.header.from;

    const originalKeys = Array.from(this.mempoolMap.keys())


    await this.criticalSection(addr, "handleFlushMessage", async () => {
      const channel = await this.getChannel(addr);

      if (message.body.counter != ++channel.data.receiveCounter) {
        console.log(`fatal counter mismatch ${message.body.counter} ${channel.data.receiveCounter}`);
        return;
      }

      if (channel.getState().blockId === 0) {
        this.logger.info(`Channel ${addr} is not initialized yet`);
      } 
      
      /*
      if (channel.data.pendingBlock) {
        if (channel.isLeft) {
          // Left user should ignore the incoming flush if they have a pending block
          this.logger.log(`Left user ignoring incoming flush due to pending block`);
          return;
        } else {
          // Right user should reset and process the incoming block
          channel.data.sentTransitions = 0;
          channel.data.pendingBlock = null;
          channel.data.pendingSignatures = [];
          this.logger.info(`Right user resetting due to concurrent flush`);
        }
      }*/

      //try {
        await channel.receive(message.body);
        
      //} catch (e) {
       // this.logger.error('Error processing block message', e);
      //}
    
    });
    await this.flushAll();
  }

  public async flushAll() {
    if (this.flushable.length == 0) {
      console.log('nothing flushable')
      return
    }
    try {
      const uniqueFlushable = [...new Set(this.flushable)];
      this.flushable = [];
      this.logger.log("flushable",uniqueFlushable)
      await Promise.all(uniqueFlushable.map(addr => this.flushChannel(addr)));

    } catch (e) {
      console.log(e)
      this.logger.error('fatal flushAll: ', e);
      throw(e);
      process.exit(1 )
    }
    
  }

  public async flushChannel(addr: string): Promise<void> {
    return this.criticalSection(addr, "flushChannel", async ()=> {
      const channel = await this.getChannel(addr);
      const identical = encode(channel.state)

      this.logger.debug(`${this.toTag(addr)}, blockId: ${channel.state.blockId}`);
      await channel.flush();
      this.logger.debug(`${this.toTag(addr)}, fin blockId: ${channel.state.blockId}`);
      if (Buffer.compare(identical, encode(channel.state)) != 0) {
        console.log(decode(identical), channel.state);
        throw new Error(`fatal 2Channel state changed during flush ${addr}`);
        
      }
        
      return 
    })
  }
  
  private async handleProxyMessage(message: IMessage): Promise<void> {
    const recipientTransport = this._transports.get(message.header.to);
    if (recipientTransport ) {
      console.log(`Proxy message ${this.toTag(message.header.from)}===>${this.toTag(message.header.to)}`+recipientTransport._ws.readyState)
      await recipientTransport.send(message);
    } else {
      // return it back to the sender

      const senderTransport = this._transports.get(message.header.from)!;
      await senderTransport.send(message);
      this.logger.error(`No transport found for recipient: ${message.header.to}`)
      //throw new Error();
    }
  }

  public async getChannel(userId: string): Promise<Channel> {
    let channel = this._channels.get(userId);
    if (!channel) {
      channel = new Channel(new ChannelContext(this, userId));
      this._channels.set(userId, channel);
      await channel.load();
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
        logger: this.logger,
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
    this.logger.info(`Send to ${this.toTag(addr)}`, message);
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

    if (this.getHub()) {
      await this.startHub();
    } else {
      if (ENV.hubDataList && ENV.hubDataList.length > 0) {
        await Promise.all(ENV.hubDataList.map(opt => this.addHub(opt)));
      }    
    }
    this.broadcastProfile();


  }
  async periodicFlush(interval: number = 2000) {
    while (true) {
      // Flush all channels with non-empty mempools
      const flushPromises = Array.from(this.mempoolMap.keys())
        .filter(key => this.mempoolMap.get(key)!.length > 0)
        .map(key => this.flushChannel(key));

      // Wait for all flush operations to complete
      await Promise.all(flushPromises);

      // Log the flush operation
      if (flushPromises.length > 0)
      this.logger.info(`Periodic flush completed for ${flushPromises.length} channels`);

      // Wait for the specified interval before the next flush
      await sleep(interval);
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
        logger: this.logger,
        ws: ws
      });
      this._transports.set(userId, transport);      
    });
  }

  public async stop() {
    // disconnect all sockets
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



  async encryptMessage(recipientAddress: string, message: string): Promise<string> {
    const recipient = await this.getProfile(recipientAddress);
    return encrypt(recipient.publicKey, Buffer.from(message)).toString('hex');
  }

  async decryptMessage(senderAddress: string, encryptedMessage: string): Promise<string> {
    const decrypted = await decrypt(this.encryptionKey.secret, Buffer.from(encryptedMessage, 'hex'));
    return decrypted.toString();
  }

  async getProfile(address: string): Promise<any> {
    if (ENV.profiles[address]) {
      return ENV.profiles[address];
    }

    await this.send(ENV.hubAddress, {
      header: {
        from: this.thisUserAddress,
        to: address,
      },
      body: {
        type: BodyTypes.kGetProfile,
        address: address,
      },
    });

    for (let i=0; i<10; i++) {
      await sleep(300);
      if (ENV.profiles[address]) {
        return ENV.profiles;
      }
    }

    return false;
  }


  
  
  /*

  // TODO save fromblockId to the storage
  startDepositoryEventsListener(fromblockId: number): void {
    //const fromblockId = 3; // Replace with the desired starting block number

    const eventFilter = this.depository.filters.TransferReserveToCollateral();
    this.depository.queryFilter(eventFilter, fromblockId).then((pastEvents) => {
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



  public async createOnionEncryptedPayment(chainId: number, tokenId: number, amount: bigint, route: string[]): Promise<{ paymentTransition: Transition.AddPayment, completionPromise: Promise<any> }> {
    const secret = crypto.getRandomValues(Buffer.alloc(32)).toString('hex');
    const hashlock = ethers.keccak256(ethers.toUtf8Bytes(secret));
    if (route.length === 0) {
      throw new Error('fatal No route provided');
    }
    const routeTag = ([this.thisUserAddress].concat(route)).map(this.toTag).join('->');
    const recipient = route.pop() as string;

    const completionPromise = new Promise((resolve, reject) => {
      console.log("Setting promise resolve", Date.now() )
      const timeout = setTimeout(()=>{
        console.log("Timeout for payment ", amount, route)
        return reject('Timeout')
      }, 60000);
        //secret: secret,

      this.hashlockMap.set(hashlock, {
        outAddress: route.length > 0 ? route[0] : recipient,
        resolve: (...args)=>{
          clearTimeout(timeout)
          console.log('rezolvv ', Date.now(), args);
          resolve(...args)
        },
        reject: reject
      });
    });

    this.logger.info(`Creating onion payment ${routeTag} ${hashlock} (${secret}): ${amount}`);
    const timelock = Math.floor(Date.now() / 1000) + 3600; // 1 hour timelock

    // final peel of the onion
    let encryptedPackage = await this.encryptForRecipient(recipient, {
      amount,
      tokenId,
      secret,
      finalRecipient: recipient
    });
    // wrapping in onion layers, if it's not direct peer
    for (let i = route.length - 1; i >= 0; i--) {
      console.log("Encrypted for "+route[i]);
      encryptedPackage = await this.encryptForRecipient(route[i], {
        amount,
        tokenId,
        nextHop: i === route.length - 1 ? recipient : route[i + 1],
        encryptedPackage
      });
    }
    const paymentTransition = new Transition.AddPayment(
      chainId,
      tokenId,
      amount,
      hashlock,
      timelock,
      encryptedPackage
    );
    return { paymentTransition, completionPromise };

  }

  public async encryptForRecipient(recipient: string, data: any): Promise<string> {
    const recipientProfile = await this.getProfile(recipient);
    this.logger.log('Retrieved profile', recipientProfile)
    const encoded = encode(data);
    const encrypted = await encrypt(recipientProfile.publicKey, Buffer.from(encoded));
    return encrypted.toString('hex');
  }

  public async decryptPackage(encryptedPackage: string): Promise<any> {
    const decrypted = await decrypt(this.encryptionKey.secret, Buffer.from(encryptedPackage, 'hex'));
    return decode(decrypted);
  }

  public async processAddPayment(channel: Channel, storedSubcontract: StoredSubcontract, isSender: boolean): Promise<void> {
    const payment = storedSubcontract.originalTransition as Transition.AddPayment;
    let hashlockData = this.hashlockMap.get(payment.hashlock);

    if (isSender) {
      if (hashlockData) {
        hashlockData.outTransitionId=storedSubcontract.transitionId;
        if (hashlockData.outAddress != channel.otherUserAddress) {
          console.log(`fatal outAddress mismatch ${hashlockData.outAddress} ${channel.otherUserAddress}`)
        }
        //hashlockData.outAddress=channel.otherUserAddress            
      } else {
        this.hashlockMap.set(payment.hashlock, {
          outTransitionId: storedSubcontract.transitionId,
          outAddress: channel.otherUserAddress
        }); 
      }  
      return;    
    }
    // the rest isReceiver
  
    // try {
      const derivedDelta = channel.deriveDelta(payment.chainId, payment.tokenId, channel.isLeft);
      this.logger.debug(`capacityin${channel.isLeft} ${derivedDelta.inCapacity} channel ${channel.channelId}`, 
        channel.getDelta(payment.chainId, payment.tokenId, false), derivedDelta);
      if (derivedDelta.inCapacity < payment.amount) {
        throw new Error(`fatal Insufficient capacity ${derivedDelta.inCapacity} for payment ${payment.amount}  ${channel.channelId}`);
      }

      this.logger.debug(`Decrypting package ${payment.encryptedPackage}`)
      let decryptedPackage;
      try{
        decryptedPackage = await this.decryptPackage(payment.encryptedPackage);
      } catch (e: any) {
        console.log('fatal decrypt', e, payment,  this.encryptionKey.secret.toString('hex'))
        throw(e);
      }
      this.logger.debug(`Processing payment in ${this.thisUserAddress}: ${payment.amount}`);

    
      if (hashlockData) {
        hashlockData.inTransitionId=storedSubcontract.transitionId;
        hashlockData.inAddress=channel.otherUserAddress
      
        this.logger.log('circulating hashlock', payment.hashlock, hashlockData)

      }else {
        hashlockData = {
          inTransitionId: storedSubcontract.transitionId,
          inAddress: channel.otherUserAddress
        }
        
        this.hashlockMap.set(payment.hashlock, hashlockData); 
      }
    
      //this.hashlockMap.set(payment.hashlock, hashlock);  

      if (decryptedPackage.finalRecipient === this.thisUserAddress) {
        this.logger.info("horay Final recipient ");
        await this.processSettlePayment(channel, storedSubcontract, decryptedPackage.secret);
      } else {
        // Intermediate node
        const fee = this.calculateFee(payment.amount);
        const forwardAmount = payment.amount - fee;
        const nextChannel = await this.getChannel(decryptedPackage.nextHop);
        //todo cancel if no capacity
        const forwardPayment = new Transition.AddPayment(
          payment.chainId,
          payment.tokenId,
          forwardAmount,
          payment.hashlock,
          payment.timelock,
          decryptedPackage.encryptedPackage
        );
        hashlockData.outAddress = decryptedPackage.nextHop
        await this.addToMempool(decryptedPackage.nextHop, forwardPayment);
        await this.addToFlushable(decryptedPackage.nextHop);
      }
    //} catch (error: any) {
     // console.log('fatal',error)
      //await this.cancelPayment(channel, payment, error.message);
     // throw new Error(error);
    //}
  }

  public async processSettlePayment(channel: Channel, storedSubcontract: StoredSubcontract, secret: string): Promise<void> {
    const paymentInfo = this.hashlockMap.get((storedSubcontract.originalTransition as Transition.AddPayment).hashlock);
    if (paymentInfo) {
      if (paymentInfo.inTransitionId && paymentInfo.inAddress) {
        paymentInfo.secret = secret;
        this.logger.debug('Settling payment to previous hop', paymentInfo)
        // should we double check payment?
        await this.addToMempool(paymentInfo.inAddress, new Transition.SettlePayment(
          paymentInfo.inTransitionId,
          paymentInfo.secret
        ));
        this.addToFlushable(paymentInfo.inAddress);
      } else {
        //f (paymentInfo.secret == secret) {
        paymentInfo.secret = secret;
          this.logger.info(`Payment is now settled ${channel.channelId}`, paymentInfo)
          if (paymentInfo.resolve) {
            this.logger.info('reddsolve payment callback', paymentInfo)
            paymentInfo.resolve({success: true, paymentInfo});
          } else {
            this.logger.info('no callback', paymentInfo)
          }
        //} else {
        //  throw new Error('fatal No such paymentinfo or bad secret');
        //}
      }
    } else {
      throw new Error('fatal No such paymentinfo');
    }
  }

  public calculateFee(amount: bigint): bigint {
    const FEE_RATE = 0.001; // 0.1% fee
    return amount * BigInt(Math.floor(FEE_RATE * 10000)) / 10000n;
  }

  public async waitForPaymentSettlement(channel: Channel, hashlock: string): Promise<void> {
    // Implementation depends on how you're notifying about payment settlements
    // This is a placeholder
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.hashlockMap.get(hashlock)?.secret) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 300);
    });
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
 * @param description - A description of the job for logging purposes.
 * @param job - The asynchronous job to be executed.
 * @returns A promise that resolves with the result of the job.
 */
async criticalSection<T>(key: string, description: string, job: Job<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queueItem: QueueItem<T> = [job, description, resolve, reject];

    if (!this.sectionQueue[key]) {
      this.sectionQueue[key] = [];
    }

    const queueLength = this.sectionQueue[key].push(queueItem);

    if (queueLength > 10000) {
      this.logger.error(`Queue overflow for: ${key} ${description}`);
      process.exit(1)
      reject(new Error(`Queue overflow for: ${key} ${description}`));
      return;
    }

    if (queueLength === 1) {
      // If this is the first item, start processing the queue
      this.processQueue(key).catch(error => {
        console.log(key, error)
        this.logger.error(`Error processing queue ${key}: ${error}`);
      });
    }
  });
}
public perfs: Record<string, Array<number>> = {};

private async processQueue(key: string): Promise<void> {
  while (this.sectionQueue[key] && this.sectionQueue[key].length > 0) {
    const [job, description, resolve, reject] = this.sectionQueue[key][0];
    const start = performance.now();

    try {
      const result = await Promise.race([
        job(),
        new Promise((_, rejectTimeout) => setTimeout(() => {
          reject(new Error(`Timeout: ${key}:${description}`));
        }, 30000))
      ]);

      resolve(result);
    } catch (error: any) {
      this.logger.error(`Error in critical section ${key}: ${description}`, error);
      reject(error);
    } finally {
      this.sectionQueue[key].shift(); // Remove the job after completion or failure
      this.updatePerformanceMetrics(key, description, performance.now() - start);
    }
  }

  // Remove the queue if it's empty
  if (this.sectionQueue[key] && this.sectionQueue[key].length === 0) {
    delete this.sectionQueue[key];
  }
}

private updatePerformanceMetrics(key: string, description: string, duration: number): void {
  const perfKey = `${key}:${description}`;
  if (!this.perfs[perfKey]) {
    this.perfs[perfKey] = [];
  }
  this.perfs[perfKey].push(duration);

  // Limit the size of the performance array to prevent memory issues
  if (this.perfs[perfKey].length > 100) {
    this.perfs[perfKey].shift();
  }

  const values = this.perfs[perfKey];
  const avg = values.reduce((acc, val) => acc + val, 0) / values.length;
  const queueKey = key.split(':')[0];

  this.logger.debug(`Performance ${this.toTag(ENV.nameToAddress[queueKey])} ${perfKey} Total: ${values.length}, Queue: ${this.sectionQueue[queueKey]?.length || 0}, Avg: ${avg.toFixed(2)}ms`);
}



  
}

