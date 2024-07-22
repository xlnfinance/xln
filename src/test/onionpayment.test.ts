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

describe('Network Operations', () => {
  let alice: User, bob: User, charlie: User, dave: User;
  let channels: Map<string, Channel> = new Map();
  let offdeltas: { [key: string]: bigint } = {};
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

    await channel.push(new Transition.SetCreditLimit(1, 1, creditLimit));
    await channel.flush();
    await sleep()
  }
  async function setupChannel(user1: User, user2: User) {
    const channel = await user1.createChannel(user2.thisUserAddress);
    await channel.push(new Transition.AddSubchannel(1));
    await channel.push(new Transition.AddDelta(1, 1));
    await channel.flush();
    await sleep()

    const creditLimit = ethers.parseEther('10');

    await extendCredit(user1, user2, creditLimit);
    await sleep()
    await extendCredit(user2, user1, creditLimit);


    await sleep();
    const channelKey = `${user1.thisUserAddress}-${user2.thisUserAddress}`;
    channels.set(channelKey, channel);
    offdeltas[channelKey] = 0n;
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
      console.log(`Channel ${channel.channelId} - out ${d.outCapacity} in ${d.inCapacity} `);
    }

    console.log('Current ENV', ENV)
  }

  async function verifyOffdeltas() {
    for (const [key, expectedOffdelta] of Object.entries(offdeltas)) {
      const channel = channels.get(key);
      if (!channel) throw new Error(`Channel not found: ${key}`);
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

    await firstHopChannel.push(paymentTransition);
    await firstHopChannel.flush();
    await sleep()
    console.log(`Payment pushed to first hop channel: ${firstHopKey}`);

    // Update expected offdeltas
    for (let i = 0; i < route.length; i++) {
      const fromAddress = i === 0 ? from.thisUserAddress : route[i-1];
      const toAddress = route[i];
      const channelKey = `${fromAddress}-${toAddress}`;
      
      offdeltas[channelKey] = (offdeltas[channelKey] || 0n) + (channels.get(channelKey)!.isLeft ? -amount : amount);
      console.log(`Updated expected offdelta for ${channelKey}: ${offdeltas[channelKey]}`);
    }
    const lastHopKey = `${route[route.length-1]}-${to.thisUserAddress}`;
    offdeltas[lastHopKey] = (offdeltas[lastHopKey] || 0n) + (channels.get(lastHopKey)!.isLeft ? -amount : amount);;
    console.log(`Updated expected offdelta for ${lastHopKey}: ${offdeltas[lastHopKey]}`);

    // Wait for the payment to propagate
    await sleep(1000);

    // Log actual channel states after payment
    for (const [key, channel] of channels.entries()) {
      const delta = channel.getDelta(1, 1);
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
    //await setupChannel(dave, alice);
    const paymentAmount = ethers.parseEther('1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress, dave.thisUserAddress];
    
    await makePayment(alice, alice, paymentAmount, route);

    await verifyOffdeltas();
  });

  it('should handle multiple concurrent payments', async function() {
    this.timeout(40000);
    const paymentAmount = ethers.parseEther('0.5');
    const route1 = [bob.thisUserAddress, charlie.thisUserAddress];
    const route2 = [charlie.thisUserAddress, bob.thisUserAddress];

    await Promise.all([
      makePayment(alice, dave, paymentAmount, route1),
      makePayment(dave, alice, paymentAmount, route2)
    ]);

    await verifyOffdeltas();
  });

  it('should handle network congestion and backpressure', async function() {
    this.timeout(120000);
    const paymentAmount = ethers.parseEther('0.1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];

    // Simulate network congestion by sending many payments in quick succession
    const paymentPromises = [];
    for (let i = 0; i < 5; i++) {
      paymentPromises.push(makePayment(alice, dave, paymentAmount, route));
    }

    await Promise.all(paymentPromises);

    await verifyOffdeltas();
  });

  it('should handle node failures and recovery', async function() {
    this.timeout(60000);
    const paymentAmount = ethers.parseEther('1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];

    // Simulate Charlie going offline
    await charlie.stop();
    console.log('Charlie went offline');

    await makePayment(alice, dave, paymentAmount, route);

    // Check that the payment didn't go through
    await verifyOffdeltas();

    // Bring Charlie back online
    await charlie.start();
    console.log('Charlie is back online');

    // Try the payment again
    await makePayment(alice, dave, paymentAmount, route);

    await verifyOffdeltas();
  });
});