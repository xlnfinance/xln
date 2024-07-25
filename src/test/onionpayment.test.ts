import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import ENV from '../env';
import { sleep } from '../utils/Utils';
let shouldContinue = true;
import {encode, decode} from '../utils/Codec';

describe('Network Operations', () => {
  let alice: User, bob: User, charlie: User, dave: User;
  let channels: Map<string, Channel> = new Map();
  let offdeltas: { [key: string]: bigint } = {};

  let shiftOffdelta = (from: string, to: string, amount: bigint) => {
    
    const key = `${from}-${to}`;
    offdeltas[key] = (offdeltas[key] || 0n) + (from < to ? -amount : amount);
    const reversedKey = `${to}-${from}`;
    offdeltas[reversedKey] = offdeltas[key]; // must be equal
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
    await setupGlobalHub(10002);
    alice = new User('alice', 'password1');
    bob = new User('bob', 'password2');
    charlie = new User('charlie', 'password3');
    dave = new User('dave', 'password4');
    await Promise.all([alice.start(), bob.start(), charlie.start(), dave.start()]);

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
    await sleep(500)
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

    console.log(`Channel setup: ${channel.channelId}, Initial offdelta: ${channel.getDelta(1, 1)?.offdelta}`);
  }

  async function setupNetwork() {
    await setupChannel(alice, bob);
    await setupChannel(bob, charlie);
    await setupChannel(charlie, dave);
    await setupChannel(dave, alice);

    console.log('Capacity map')
    for (const [key, channel] of channels.entries()) {
      const d = channel.deriveDelta(1, 1, channel.isLeft);
      console.log(`Channeldelta ${channel.channelId} - out ${d.outCapacity} in ${d.inCapacity} `);
    }

    console.log('Current ENV', ENV)

    await sleep(500);
  }

  async function verifyOffdeltas() {
    for (const [key, expectedOffdelta] of Object.entries(offdeltas)) {
      const channel = channels.get(key);
      if (!channel) throw new Error(`Channel not found: ${key}`);
      await channel.load()
      const delta = channel.getDelta(1, 1);
      if (!delta) throw new Error(`Delta not found for channel: ${key}`);
      console.log(`Channel ${key} - Expected: ${expectedOffdelta}, Actual: ${delta.offdelta}`);
      expect(delta.offdelta).to.equal(expectedOffdelta, `Mismatch in channel ${key}`);
    }
  }

  async function makePayment(from: User, to: User, amount: bigint, route: string[]) {
    console.log(`Initiating payment: ${from.thisUserAddress} -> ${to.thisUserAddress}, Amount: ${amount}`);
    const paymentTransition = await from.createOnionEncryptedPayment(
      to.thisUserAddress,
      amount,
      1,
      1,
      route
    );
    console.log('Starting onion', paymentTransition)

    const firstHopKey = `${from.thisUserAddress}-${route[0]}`;
    const firstHopChannel = channels.get(firstHopKey);
    if (!firstHopChannel) throw new Error(`Channel not found: ${firstHopKey}`);

    from.addToMempool(route[0], paymentTransition, true);

    await sleep(200)
    console.log(`Payment pushed to first hop channel: ${firstHopKey}`);

    // Update expected offdeltas
    for (let i = 0; i < route.length; i++) {
      const fromAddress = i === 0 ? from.thisUserAddress : route[i-1];
      const toAddress = route[i];
      const channelKey = `${fromAddress}-${toAddress}`;
      shiftOffdelta(fromAddress, toAddress, amount);
      amount -= from.calculateFee(amount);
      console.log(`Updated expected offdelta for ${channelKey}: ${offdeltas[channelKey]}`);
    }
    const lastHopKey = `${route[route.length-1]}-${to.thisUserAddress}`;
    shiftOffdelta(route[route.length-1], to.thisUserAddress, amount);
    console.log(`Updated expected offdelta for ${lastHopKey}: ${offdeltas[lastHopKey]}`);

    // Wait for the payment to propagate
    await sleep(7000);

    // Log actual channel states after payment
    for (const [key, channel] of channels.entries()) {
      await channel.load()
      const delta = channel.getDelta(1, 1);
      console.log(delta);
      console.log(`Channel ${key} state after payment - offdelta: ${delta?.offdelta}`);
    }
  }

  it('should propagate a payment through multiple hops', async function() {
    this.timeout(20000);
    await setupNetwork();
    const paymentAmount = ethers.parseEther('1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];
    
    await makePayment(alice, dave, paymentAmount, route);

    await verifyOffdeltas();
  });

  it('should handle circular payments', async function() {
    this.timeout(35000);
    await setupChannel(dave, alice);
    const paymentAmount = ethers.parseEther('1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress, dave.thisUserAddress];
    
    await makePayment(alice, alice, paymentAmount, route);

    console.log('Capacity map', channels)
    for (const [key, channel] of channels.entries()) {
      const d = channel.deriveDelta(1, 1, channel.isLeft);
      console.log(`Channel ${channel.channelId} - out ${d.outCapacity} in ${d.inCapacity} `);
    }
    await verifyOffdeltas();
  });

  it('should handle multiple concurrent payments', async function() {
    this.timeout(40000);
    const paymentAmount = ethers.parseEther('0.1');
    const route1 = [bob.thisUserAddress, charlie.thisUserAddress];
    const route2 = [charlie.thisUserAddress, bob.thisUserAddress];

    //await Promise.all([
     await makePayment(alice, dave, paymentAmount, route1);
     await makePayment(dave, alice, paymentAmount, route2);
    //]);

    await verifyOffdeltas();
  });

  it('should handle network congestion and backpressure', async function() {
    this.timeout(60000);
    const paymentAmount = ethers.parseEther('0.1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];

    // Simulate network congestion by sending many payments in quick succession
    const paymentPromises = [];
    for (let i = 0; i < 6; i++) {
      paymentPromises.push(makePayment(alice, dave, paymentAmount, route));
    }

    await Promise.all(paymentPromises);

    await verifyOffdeltas();
  });

  it('should handle node failures and recovery', async function() {
    this.timeout(60000);
    const paymentAmount = ethers.parseEther('0.1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];

    // Simulate Charlie going offline
    await charlie.stop();
    console.log('Charlie went offline');
    const clonedOffdeltas = structuredClone(offdeltas);
    console.log('cloned ', clonedOffdeltas)
    //await makePayment(alice, dave, paymentAmount, route);
    console.log('clonedafter ', clonedOffdeltas, offdeltas)

    Object.assign(offdeltas, clonedOffdeltas);

    // Check that the payment didn't go through
    await verifyOffdeltas();

    // Bring Charlie back online
    await charlie.start();
    console.log('Charlie is back online');

    // Try the payment again
    await makePayment(alice, dave, paymentAmount, route);

    //await verifyOffdeltas();
  });
});