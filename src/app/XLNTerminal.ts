import * as readline from 'readline';
import User from './User';
import Channel from './Channel';
import { Transition } from './Transition';
import { ethers } from 'ethers';

export class XLNTerminal {
  private rl: readline.Interface;

  constructor(private users: Map<string, User>) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  public async start() {
    while (true) {
      await this.showHomeScreen();
      const command = await this.prompt('Enter command: ');
      await this.handleCommand(command);
    }
  }

  private async showHomeScreen() {
    console.clear();
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                     XLN Terminal - Home Screen                 ║');
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log('║ Current Users:                                                 ║');
    for (const [address, user] of this.users) {
      console.log(`║ - ${address.padEnd(66)} ║`);
    }
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log('║ Commands:                                                      ║');
    console.log('║   login <address> - Log into a user                            ║');
    console.log('║   logout <address> - Log out a user                            ║');
    console.log('║   exit - Exit the terminal                                     ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
  }

  private async handleCommand(command: string) {
    const [action, address] = command.split(' ');
    switch (action) {
      case 'login':
        await this.loginUser(address);
        break;
      case 'logout':
        await this.logoutUser(address);
        break;
      case 'exit':
        this.rl.close();
        process.exit(0);
      default:
        console.log('Unknown command');
    }
  }

  private async loginUser(address: string) {
    if (!this.users.has(address)) {
      const user = new User(address, 'password'); // You might want to handle password differently
      await user.start();
      this.users.set(address, user);
    }
    await this.showUserScreen(address);
  }

  private async logoutUser(address: string) {
    const user = this.users.get(address);
    if (user) {
      await user.stop();
      this.users.delete(address);
      console.log(`Logged out user: ${address}`);
    } else {
      console.log(`User not found: ${address}`);
    }
  }

  private async showUserScreen(address: string) {
    const user = this.users.get(address)!;
    while (true) {
      console.clear();
      console.log(`╔════════════════════════════════════════════════════════════════╗`);
      console.log(`║ User Screen - ${address.padEnd(55)} ║`);
      console.log(`╠════════════════════════════════════════════════════════════════╣`);
      console.log(`║ Channels:                                                      ║`);
      const channels = await user.getChannels();
      for (const channel of channels) {
        console.log(`║ - ${channel.getId().padEnd(66)} ║`);
      }
      console.log(`╠════════════════════════════════════════════════════════════════╣`);
      console.log(`║ Commands:                                                      ║`);
      console.log(`║   channel <destination> - Open or create a channel             ║`);
      console.log(`║   back - Return to home screen                                 ║`);
      console.log(`╚════════════════════════════════════════════════════════════════╝`);
      
      const command = await this.prompt('Enter command: ');
      if (command === 'back') break;
      if (command.startsWith('channel ')) {
        const destination = command.split(' ')[1];
        await this.showChannelScreen(user, destination);
      }
    }
  }

  private async showChannelScreen(user: User, destination: string) {
    const channel = await user.getChannel(destination);
    while (true) {
      console.clear();
      console.log(`╔════════════════════════════════════════════════════════════════╗`);
      console.log(`║ Channel Screen - ${channel.getId().padEnd(54)} ║`);
      console.log(`╠════════════════════════════════════════════════════════════════╣`);
      this.displayChannelInfo(channel);
      console.log(`╠════════════════════════════════════════════════════════════════╣`);
      console.log(`║ Commands:                                                      ║`);
      console.log(`║   pay <amount> - Make a payment                                ║`);
      console.log(`║   swap <amount> <fromToken> <toToken> - Perform a swap         ║`);
      console.log(`║   /message - Send a text message                               ║`);
      console.log(`║   back - Return to user screen                                 ║`);
      console.log(`╚════════════════════════════════════════════════════════════════╝`);
      
      const command = await this.prompt('Enter command: ');
      if (command === 'back') break;
      if (command.startsWith('/')) {
        await this.sendMessage(channel, command.slice(1));
      } else {
        await this.handleChannelCommand(channel, command);
      }
    }
  }

  private displayChannelInfo(channel: Channel) {
    const state = channel.getState();
    console.log(`║ Subchannels:                                                   ║`);
    for (const subchannel of state.subchannels) {
      console.log(`║   Chain ID: ${subchannel.chainId.toString().padEnd(58)} ║`);
      for (const delta of subchannel.deltas) {
        const derived = channel.deriveDelta(subchannel.chainId, delta.tokenId, channel.isLeft);
        console.log(`║     Token ID: ${delta.tokenId.toString().padEnd(56)} ║`);
        console.log(`║     Collateral: ${delta.collateral.toString().padEnd(54)} ║`);
        console.log(`║     On-chain Delta: ${delta.ondelta.toString().padEnd(50)} ║`);
        console.log(`║     Off-chain Delta: ${delta.offdelta.toString().padEnd(49)} ║`);
        console.log(`║     Credit Layout: ${derived.ascii.padEnd(50)} ║`);
      }
    }
    console.log(`║                                                                ║`);
    console.log(`║ Recent Blocks:                                                 ║`);
    // TODO: Implement logic to display recent blocks and transitions
  }

  private async handleChannelCommand(channel: Channel, command: string) {
    const [action, ...args] = command.split(' ');
    switch (action) {
      case 'pay':
        await this.makePayment(channel, args[0]);
        break;
      case 'swap':
        await this.performSwap(channel, args[0], args[1], args[2]);
        break;
      default:
        console.log('Unknown command');
    }
  }

  private async makePayment(channel: Channel, amountStr: string) {
    const amount = ethers.parseEther(amountStr);
    const transition = new Transition.DirectPayment(1, 1, amount);
    await channel.push(transition);
    await channel.flush();
    console.log(`Payment of ${amountStr} ETH sent successfully.`);
  }

  private async performSwap(channel: Channel, amountStr: string, fromToken: string, toToken: string) {
    const amount = ethers.parseEther(amountStr);
    // TODO: Implement swap logic
    console.log(`Swap of ${amountStr} from ${fromToken} to ${toToken} initiated.`);
  }

  private async sendMessage(channel: Channel, message: string) {
    const transition = new Transition.TextMessage(message);
    await channel.push(transition);
    await channel.flush();
    console.log('Message sent successfully.');
  }

  private async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }
}