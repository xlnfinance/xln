import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import ENV from '../env';
import { sleep } from '../utils/Utils';
let offdeltas: { [key: string]: bigint } = {};

describe('High Load Onion Payment Network Simulation', () => {
  let users: User[];
  let hub: User;
  const userNames = ['alice', 'bob', 'charlie', 'dave', 'eve', 'hub'];
  
  before(async () => {
    try {
      hub = await setupGlobalHub(10003);
      users = await Promise.all(userNames.slice(0, -1).map(name => {
        const user = new User(name, `password_${name}`);
        return user.start().then(() => user);
      }));
      users.push(hub);
      await setupFullMeshNetwork(users);
    } catch (error) {
      console.error('Error in before hook:', error);
      throw error;
    }
  });

  after(async () => {
    await Promise.all(users.map(user => user.stop()));
    await teardownGlobalHub();
  });

  it.only('should handle random onion routed payments in a complex network scenario', async function() {
    this.timeout(300000);

    const config = {
      totalPayments: 20,
      minAmount: ethers.parseEther('0.01'),
      maxAmount: ethers.parseEther('1'),
      minRouteLength: 2,
      maxRouteLength: 4,
      paymentInterval: 100,
      maxConcurrentPayments: 10,
      useHub: false
    };

    const results = await simulateRandomPayments(users, config);

    expect(results.successfulPayments).to.be.greaterThan(0);
    expect(results.failedPayments).to.be.lessThan(config.totalPayments * 0.2);

    await verifyNetworkBalances(users);
  });

  it('should handle payments routed through the hub', async function() {
    this.timeout(300000);

    const config = {
      totalPayments: 50,
      minAmount: ethers.parseEther('0.01'),
      maxAmount: ethers.parseEther('1'),
      minRouteLength: 3,
      maxRouteLength: 3,
      paymentInterval: 100,
      maxConcurrentPayments: 5,
      useHub: true
    };

    const results = await simulateRandomPayments(users, config);

    expect(results.successfulPayments).to.be.greaterThan(0);
    expect(results.failedPayments).to.be.lessThan(config.totalPayments * 0.2);

    await verifyNetworkBalances(users);
  });
});

async function setupFullMeshNetwork(users: User[]) {
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      await setupChannel(users[i], users[j]);
      await sleep(500);
    }
  }
  await sleep(3000);
  console.log('Full mesh network setup completed');
}

async function setupChannel(user1: User, user2: User) {
  try {
    const channelKey = `${user1.thisUserAddress}-${user2.thisUserAddress}`;
    offdeltas[channelKey] = 0n;
    offdeltas[`${user2.thisUserAddress}-${user1.thisUserAddress}`] = 0n;

    await user1.addToMempool(user2.thisUserAddress, new Transition.AddSubchannel(1), true);
    await sleep(100);
    
    await user1.addToMempool(user2.thisUserAddress, new Transition.AddDelta(1, 1), true);
    await sleep(100);
    
    const creditLimit = ethers.parseEther('100');
    await user1.addToMempool(user2.thisUserAddress, new Transition.SetCreditLimit(1, 1, creditLimit), true);
    await sleep(100);
    
    await user2.addToMempool(user1.thisUserAddress, new Transition.SetCreditLimit(1, 1, creditLimit), true);
    await sleep(100);

    console.log(`Channel setup completed between ${user1.username} and ${user2.username}`);
  } catch (error) {
    console.error(`Error setting up channel between ${user1.username} and ${user2.username}:`, error);
    throw error;
  }
}

async function simulateRandomPayments(users: User[], config: any) {
  let successfulPayments = 0;
  let failedPayments = 0;
  let concurrentPayments = 0;
  const paymentPromises = [];

  for (let i = 0; i < config.totalPayments; i++) {
    while (concurrentPayments >= config.maxConcurrentPayments) {
      await sleep(50);
    }

    concurrentPayments++;
    const paymentPromise = makeRandomPayment(users, config)
      .then(() => {
        successfulPayments++;
      })
      .catch((error) => {
        console.error('Payment failed:', error);
        failedPayments++;
      })
      .finally(() => {
        concurrentPayments--;
      });

    paymentPromises.push(paymentPromise);
    await sleep(config.paymentInterval);
  }

  await Promise.all(paymentPromises);
  return { successfulPayments, failedPayments };
}

async function makeRandomPayment(users: User[], config: any) {
  const hub = users.find(user => user.username === 'hub')!;
  const nonHubUsers = users.filter(user => user !== hub);
  
  let sender, recipient;
  do {
    [sender, recipient] = getRandomPair(nonHubUsers);
  } while (sender === recipient);

  const amount = getRandomBigInt(config.minAmount, config.maxAmount);
  const route = config.useHub 
    ? [sender, hub, recipient]
    : generateRandomRoute(users, sender, recipient, config.minRouteLength, config.maxRouteLength);

  const { paymentTransition, completionPromise } = await sender.createOnionEncryptedPayment(
    1,
    1,
    amount,
    route.slice(1).map(user => user.thisUserAddress)
  );

  let amountCopy = amount;
  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i].thisUserAddress;
    const to = route[i + 1].thisUserAddress;
    shiftOffdelta(from, to, amountCopy);
    amountCopy -= ENV.users[to].calculateFee(amountCopy);
  }

  await sender.addToMempool(route[1].thisUserAddress, paymentTransition, true);
  return completionPromise;
}

function shiftOffdelta(from: string, to: string, amount: bigint) {
  const key = `${from}-${to}`;
  offdeltas[key] = (offdeltas[key] || 0n) + (from < to ? -amount : amount);
  const reversedKey = `${to}-${from}`;
  offdeltas[reversedKey] = offdeltas[key];
  console.log(`Updated expected offdelta for ${key}: ${offdeltas[key]}`);
}

  function getRandomPair(users: User[]): [User, User] {
    const shuffled = users.sort(() => 0.5 - Math.random());
    return [shuffled[0], shuffled[1]];
  }
function getRandomBigInt(min: bigint, max: bigint): bigint {
  return min + BigInt(Math.floor(Math.random() * Number(max - min)));
}
function generateRandomRoute(users: User[], sender: User, recipient: User, minLength: number, maxLength: number): User[] {
    const availableUsers = users.filter(user => user !== sender && user !== recipient);
    const routeLength = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
    
    const route = [sender];
    const usedUsers = new Set([sender.username, recipient.username]);
  
    while (route.length < routeLength - 1 && availableUsers.length > 0) {
      const randomIndex = Math.floor(Math.random() * availableUsers.length);
      const intermediary = availableUsers[randomIndex];
      
      if (!usedUsers.has(intermediary.username)) {
        route.push(intermediary);
        usedUsers.add(intermediary.username);
        availableUsers.splice(randomIndex, 1);
      }
    }
  
    route.push(recipient);
    return route;
  }
  
async function verifyNetworkBalances(users: User[]) {
  const initialTotalBalance = ethers.parseEther('100') * BigInt(users.length);
  let finalTotalBalance = 0n;

  for (const participant of users) {
    const channels = await participant.getChannels();
    for (const channel of channels) {
      const delta = channel.getDelta(1, 1, false);
      if (delta) {
        finalTotalBalance += delta.offdelta;
        const channelKey = `${participant.thisUserAddress}-${channel.otherUserAddress}`;
        expect(delta.offdelta).to.equal(offdeltas[channelKey], `Mismatch in channel ${channelKey}`);
      }
    }
  }

  expect(finalTotalBalance).to.equal(initialTotalBalance, "Total network balance should remain constant");
}