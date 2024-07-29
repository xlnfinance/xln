import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel, {stringify} from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import ENV from '../env';
import { sleep } from '../utils/Utils';
let shouldContinue = true;
import {encode, decode} from '../utils/Codec';
let chaiAsPromised;

describe('Network Operations', () => {
  let alice: User, bob: User, charlie: User, dave: User, eve: User;
  let hub: User;

  let channels: Map<string, Channel> = new Map();
  let offdeltas: { [key: string]: bigint } = {};

  let shiftOffdelta = (from: string, to: string, amount: bigint) => {
    
    const key = `${from}-${to}`;
    offdeltas[key] = (offdeltas[key] || 0n) + (from < to ? -amount : amount);
    const reversedKey = `${to}-${from}`;
    offdeltas[reversedKey] = offdeltas[key]; // must be equal

    console.log(`Updated expected offdelta for ${key}: ${offdeltas[key]}`);

  }
  let shouldSkipRemainingTests = false;
  beforeEach(function() {
    
    if (shouldSkipRemainingTests) {
      // Skip the test by throwing a special error recognized by Mocha
      this.skip();
    }
  });
  
  afterEach(function() {
    // If the current test failed, set the flag to true
    if (this.currentTest!.state === 'failed') {
      shouldSkipRemainingTests = true;
    }
  });

  before(async () => {
    chaiAsPromised = await import('chai-as-promised');
    chai.use(chaiAsPromised.default);
  
    hub = await setupGlobalHub(10002);
    alice = new User('alice', 'password1');
    bob = new User('bob', 'password2');
    charlie = new User('charlie', 'password3');
    dave = new User('dave', 'password4');
    eve = new User('eve', 'password5');
    await Promise.all([alice.start(), bob.start(), charlie.start(), dave.start(), eve.start()]);

  });

  after(async () => {
    await Promise.all([alice.stop(), bob.stop(), charlie.stop(), dave.stop()]);
    await teardownGlobalHub();
  });

  async function extendCredit(user1: User, user2: User, creditLimit: bigint) {
    const channel = await user1.getChannel(user2.thisUserAddress);
    const channelKey = `${user1.thisUserAddress}-${user2.thisUserAddress}`;

    channels.set(channelKey, channel);

    await user1.addToMempool(user2.thisUserAddress, new Transition.SetCreditLimit(1, 1, creditLimit), true);
    await sleep(1000)
    expect(channel.data.sentTransitions).to.equal(0)
  }

  async function setupChannel(user1: User, user2: User) {
    const channel = await user1.getChannel(user2.thisUserAddress);
    const channelRev = await user2.getChannel(user1.thisUserAddress);

    const channelKey = `${user1.thisUserAddress}-${user2.thisUserAddress}`;
    const channelKeyRev = `${user2.thisUserAddress}-${user1.thisUserAddress}`;
    channels.set(channelKey, channel);
    channels.set(channelKeyRev, channelRev);
    offdeltas[channelKey] = 0n;
    offdeltas[channelKeyRev] = 0n;

    user1.addToMempool(user2.thisUserAddress, new Transition.AddSubchannel(1));
    user1.addToMempool(user2.thisUserAddress, new Transition.AddDelta(1, 1));

    const creditLimit = ethers.parseEther('10');

    await extendCredit(user1, user2, creditLimit);

    await extendCredit(user2, user1, creditLimit);

    console.log(`Channel setup: ${channel.channelId}, Initial offdelta: ${channel.getDelta(1, 1, false)?.offdelta}`);
  }

  async function setupNetwork() {
    if (channels.size > 0) return;

    let users = [ alice, bob, charlie, dave, hub];
    let all = []
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        all.push(setupChannel(users[i], users[j]))
      }
    }
    await Promise.all(all)
    await sleep(4000); // Wait for channel setup to complete
  

    console.log('Capacity map')
    for (const [key, channel] of channels.entries()) {
      const d = channel.deriveDelta(1, 1, channel.isLeft);
      console.log(`delta ${channel.channelId} - out ${d.outCapacity} in ${d.inCapacity} `);
    }

    console.log('Current ENV', ENV)

    await sleep(3000);
  }

  async function verifyOffdeltas(ensureAck: boolean = true) {
    for (const [key, expectedOffdelta] of Object.entries(offdeltas)) {
      const channel = channels.get(key);
      if (!channel) throw new Error(`Channel not found: ${key}`);

      if (ensureAck) {
        let attempts = 10;
        while (channel.data.sentTransitions > 0) {
          await sleep(1000);

          if (attempts-- <= 0) throw new Error(`fatal Channel ${key} is stuck`);
        }
      }

      //if (channel.data.sentTransitions > 0) throw new Error(`Channel fatal sent: ${key}`);
      //await channel.load()
      const delta = channel.getDelta(1, 1, false);
      
      if (!delta) throw new Error(`Delta not found for channel: ${key}`);
      
      console.log(`Channel ${key} - Expected: ${expectedOffdelta}, Actual: ${delta.offdelta}`);
      
      expect(delta.offdelta).to.equal(expectedOffdelta, `Mismatch in channel ${key}, sent: ${channel.data.sentTransitions}`);
    }
  }

  async function logChannels() {
    // Log actual channel states after payment
    console.log(Array.from(channels.keys()))
    for (const [key, channel] of channels.entries()) {
      //await channel.load()
      const delta = channel.getDelta(1, 1, false);
      console.log(delta);
      console.log(`Channel ${key} state after payment - offdelta: ${delta?.offdelta}`);
    }
  }

  async function makePayment(routeString: string, amount: bigint) {
    const route: string[] = routeString.split('-').map((name) => {
      if (ENV.nameToAddress[name]) {
        return ENV.nameToAddress[name];
      } else {
        return name;
      }
    });

    console.log(`Initiating payment: ${route.join('-')}, Amount: ${amount}`);
    let amountCopy = amount;
    for (let i = 0; i < route.length-1; i++) {
      shiftOffdelta(route[i], route[i+1], amountCopy);
      amountCopy -= ENV.users[route[i+1]].calculateFee(amountCopy);
    }

    const from = ENV.users[route.shift() as string] as User
    const recepient = route.pop() as string;

    const {paymentTransition, completionPromise} = await from.createOnionEncryptedPayment(
      1,
      1,
      amount,
      route.concat(recepient)
    );
    console.log('Starting onion', paymentTransition)

    const firstHopKey = `${from.thisUserAddress}-${route[0]}`;
    const firstHopChannel = channels.get(firstHopKey);
    if (!firstHopChannel) throw new Error(`Channel not found: ${firstHopKey}`);

    from.addToMempool(route[0], paymentTransition, true);

    console.log(`Payment pushed to first hop channel: ${firstHopKey}`);

    // Update expected offdeltas
    /*
    for (let i = 0; i < route.length; i++) {
      const fromAddress = i === 0 ? from.thisUserAddress : route[i-1];
      const toAddress = route[i];
      const channelKey = `${fromAddress}-${toAddress}`;
      console.log(`before ${offdeltas[channelKey]} ${amount}`);
      shiftOffdelta(fromAddress, toAddress, amount);
      amount -= from.calculateFee(amount);
      console.log(`Updated expected offdelta for ${channelKey}: ${offdeltas[channelKey]}`);
    }
    const lastHop = route[route.length - 1];

    const lastHopKey = `${route.length > 0 ? route[route.length-1] : from.thisUserAddress}-${recepient}`;
    shiftOffdelta(route[route.length-1], recepient, amount);
    console.log(`Updated expected offdelta for ${lastHopKey}: ${offdeltas[lastHopKey]}`);
    */

    return completionPromise;
  }

  it('should propagate a payment through multiple hops', async function() {
    this.timeout(60000);
    await setupNetwork();

    const paymentAmount = ethers.parseEther('1');
    
    const completionPromise = await makePayment('alice-bob-charlie-dave', paymentAmount);
    const {status, paymentInfo} = completionPromise;
    console.log('awaited ',paymentInfo);
    await sleep(3000);
    console.log('awaited ', stringify(Array.from(alice.hashlockMap.entries())));

    console.log(ENV.users[alice.thisUserAddress].mempoolMap[paymentInfo.secret]);


    await logChannels();

    await verifyOffdeltas();
  });

  it('should handle circular payments', async function() {
    this.timeout(35000);
    await setupNetwork();

    const paymentAmount = ethers.parseEther('1');
    
    makePayment('alice-bob-charlie-dave-alice', paymentAmount);
    await sleep(5000);
    await logChannels();
    await sleep(5000);

    console.log('Capacity map', channels)
    for (const [key, channel] of channels.entries()) {
      const d = channel.deriveDelta(1, 1, channel.isLeft);
      console.log(`Channel ${channel.channelId} - out ${d.outCapacity} in ${d.inCapacity} `);
    }
    await verifyOffdeltas();
  });

  it('should handle multiple concurrent payments', async function() {
    this.timeout(40000);
    await setupNetwork();

    const paymentAmount = ethers.parseEther('0.1');
    const route1 = [bob.thisUserAddress, charlie.thisUserAddress];
    const route2 = [charlie.thisUserAddress, bob.thisUserAddress];

    //await Promise.all([
     await makePayment('alice-bob-charlie-dave', paymentAmount);
     await makePayment('dave-charlie-bob-alice', paymentAmount);
     await sleep(6000);
    //]);
    await logChannels();

    await verifyOffdeltas();
  });

  it('should handle network congestion and backpressure', async function() {
    await setupNetwork();

    this.timeout(120000);

    const paymentAmount = ethers.parseEther('0.01');

    // Simulate network congestion by sending many payments in quick succession
    const paymentPromises = [];
    for (let i = 0; i < 30; i++) {
      paymentPromises.push(makePayment('alice-bob-charlie-dave', paymentAmount));
      paymentPromises.push(makePayment('dave-charlie-bob-alice', paymentAmount));
      paymentPromises.push(makePayment('dave-bob-charlie', paymentAmount));
      paymentPromises.push(makePayment('alice-dave-bob', paymentAmount));
      paymentPromises.push(makePayment('charlie-hub-dave', paymentAmount));
      paymentPromises.push(makePayment('dave-hub-charlie-bob', paymentAmount));
    }

    await Promise.all(paymentPromises);
    await sleep(15000);

    await logChannels();

    await verifyOffdeltas();
  });
  /*  how to recover?
  it.skip('should handle node failures and recovery', async function() {
    await setupNetwork();
    this.timeout(60000);
    const paymentAmount = ethers.parseEther('0.1');

    // Simulate Charlie going offline
    await charlie.stop();
    console.log('Charlie went offline');
    const clonedOffdeltas = structuredClone(offdeltas);
    console.log('cloned ', clonedOffdeltas)
    try {
      await makePayment('alice-bob-charlie-dave', paymentAmount);
    } catch (e) {
      //PaymentTimeout
    }
    console.log('clonedafter ', clonedOffdeltas, offdeltas)
    await sleep(5000);

    Object.assign(offdeltas, clonedOffdeltas);

    // Check that the payment didn't go through
    await verifyOffdeltas(false);

    // Bring Charlie back online
    await charlie.start();
    console.log('Charlie is back online');

    // Try the payment again
    await makePayment('alice-bob-charlie-dave', paymentAmount);

    //await verifyOffdeltas(false);
  });*/
});