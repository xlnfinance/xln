import User from './User';
import { XLNTerminal } from './XLNTerminal';
import { Transition } from './Transition';
import { ethers } from 'ethers';
import ENV from '../env';
import { sleep } from '../utils/Utils';
import { setupGlobalHub } from '../test/hub';

const userNames = [
  "alice", "bob", "charlie" 
];

async function initializeUsers(): Promise<{ [key: string]: User }> {
  const users: { [key: string]: User } = {};
  for (const name of userNames) {
    const user = new User(name, `password_${name}`);
    await user.start();
    users[user.thisUserAddress] = user;
    ENV.users[user.thisUserAddress] = user;
  }
  return users;
}

async function setupChannel(user1: User, user2: User) {
  try {
    const subchannels = [1, 56]; // Ethereum, BSC, Polygon
    const tokens = [1, 2]; // ETH, USDC, USDT

    for (const chainId of subchannels) {
      await user1.addToMempool(user2.thisUserAddress, new Transition.AddSubchannel(chainId));
      //await sleep(100); // Add a small delay to ensure the subchannel is created
      
      for (const tokenId of tokens) {
        await user1.addToMempool(user2.thisUserAddress, new Transition.AddDelta(chainId, tokenId));
        //await sleep(100); // Add a small delay to ensure the delta is created
        
        const creditLimit = ethers.parseEther('1000');
        await user1.addToMempool(user2.thisUserAddress, new Transition.SetCreditLimit(chainId, tokenId, creditLimit));

        await user2.addToMempool(user1.thisUserAddress, new Transition.SetCreditLimit(chainId, tokenId, creditLimit));

        //await sleep(100); // Add a small delay between credit limit settings
        //await sleep(100); // Add a small delay after setting credit limits
      }
    }
    await user1.flushChannel(user2.thisUserAddress);
    
    console.log(`Channel setup completed between ${user1.username} and ${user2.username}`);
  } catch (error) {
    console.error(`Error setting up channel between ${user1.username} and ${user2.username}:`, error);
    throw error;
  }
}

async function setupFullMeshNetwork(users: { [key: string]: User }) {
  const userList = Object.values(users);
  for (let i = 0; i < userList.length; i++) {
    for (let j = i + 1; j < userList.length; j++) {
      await setupChannel(userList[i], userList[j]);
    }
  }
  await sleep(3000)

  console.log('Full mesh network setup completed');
}

async function main() {
  console.log("Setting up global hub...");
  const hub = await setupGlobalHub(10010);
  await sleep(100);
  console.log("Global hub set up");

  console.log("Initializing users...");
  const users = await initializeUsers();
  
  console.log("Setting up full mesh network...");
  users[hub.thisUserAddress] = hub
  await setupFullMeshNetwork(users);
  
  console.log("Network setup complete. Starting terminal...");
  const terminal = new XLNTerminal(users, ENV);
  await terminal.start();
}

main().catch(console.error);