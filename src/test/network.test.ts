import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Network Operations', () => {
  let globalHub: User, alice: User, bob: User, charlie: User, dave: User;
  let channels: Map<string, Channel> = new Map();
  let offdeltas: { [key: string]: bigint } = {};

  before(async () => {
    globalHub = await setupGlobalHub(10002);
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

  async function setupChannel(user1: User, user2: User) {
    const channel = await user1.createChannel(user2.thisUserAddress);
    await channel.push(new Transition.AddSubchannel(1));
    await channel.push(new Transition.AddDelta(1, 1));
    const creditLimit = ethers.parseEther('10');
    await channel.push(new Transition.SetCreditLimit(1, 1, creditLimit));
    await channel.flush();
    await sleep(500);
    channels.set(`${user1.thisUserAddress}-${user2.thisUserAddress}`, channel);
    offdeltas[`${user1.thisUserAddress}-${user2.thisUserAddress}`] = 0n;
    console.log(`Channel setup: ${user1.thisUserAddress}-${user2.thisUserAddress}`);
  }

  async function setupNetwork() {
    await setupChannel(alice, bob);
    await setupChannel(bob, charlie);
    await setupChannel(charlie, dave);
  }

  async function verifyOffdeltas() {
    for (const [key, expectedOffdelta] of Object.entries(offdeltas)) {
      const [user1Address, user2Address] = key.split('-');
      const channel = channels.get(key);
      if (!channel) throw new Error(`Channel not found: ${key}`);
      const delta = channel.getDelta(1, 1);
      if (!delta) throw new Error(`Delta not found for channel: ${key}`);
      console.log(`Channel ${key} - Expected: ${expectedOffdelta}, Actual: ${delta.offdelta}`);
      expect(delta.offdelta).to.equal(expectedOffdelta, `Mismatch in channel ${key}`);
    }
  }

  async function makePayment(from: User, to: User, amount: bigint, route: string[]) {
    const paymentTransition = await from.createOnionEncryptedPayment(
      to.thisUserAddress,
      amount,
      1,
      1,
      route
    );

    const firstHopChannel = channels.get(`${from.thisUserAddress}-${route[0]}`)!;
    await firstHopChannel.push(paymentTransition);
    await firstHopChannel.flush();

    console.log(`Payment initiated: ${from.thisUserAddress} -> ${to.thisUserAddress}, Amount: ${amount}`);

    // Update expected offdeltas
    for (let i = 0; i < route.length; i++) {
      const fromAddress = i === 0 ? from.thisUserAddress : route[i-1];
      const toAddress = route[i];
      const channelKey = `${fromAddress}-${toAddress}`;

      offdeltas[channelKey] -= (channels.get(channelKey)!.isLeft ? -amount : amount);;
      console.log(`Updated offdelta for ${channelKey}: ${offdeltas[channelKey]}`);
    }
    const channelKey = `${route[route.length-1]}-${to.thisUserAddress}`;

    offdeltas[channelKey] +=  (channels.get(channelKey)!.isLeft ? -amount : amount);;;
    console.log(`Updated offdelta for ${route[route.length-1]}-${to.thisUserAddress}: ${offdeltas[`${route[route.length-1]}-${to.thisUserAddress}`]}`);

    // Wait for the payment to propagate
    await sleep(5000);
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
    this.timeout(25000);
    await setupChannel(dave, alice);
    const paymentAmount = ethers.parseEther('1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress, dave.thisUserAddress];
    
    await makePayment(alice, alice, paymentAmount, route);

    await verifyOffdeltas();
  });

  it('should handle multiple concurrent payments', async function() {
    this.timeout(30000);
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
    this.timeout(60000);
    const paymentAmount = ethers.parseEther('0.1');
    const route = [bob.thisUserAddress, charlie.thisUserAddress];

    // Simulate network congestion by sending many payments in quick succession
    const paymentPromises = [];
    for (let i = 0; i < 50; i++) {
      paymentPromises.push(makePayment(alice, dave, paymentAmount, route));
    }

    await Promise.all(paymentPromises);

    await verifyOffdeltas();
  });

  it('should handle node failures and recovery', async function() {
    this.timeout(40000);
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