import * as readline from 'readline';
import { ethers } from 'ethers';
import User from './User';
import { Transition } from './Transition';
import * as crypto from 'crypto';

export class XLNTerminal {
  private rl: readline.Interface;

  constructor(private user: User) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async start() {
    while (true) {
      await this.renderDashboard();
      const command = await this.prompt('Enter command: ');
      await this.handleCommand(command);
    }
  }

  private async renderDashboard() {
    console.clear();
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                     XLN Terminal Client                        ║
╠════════════════════════════════════════════════════════════════╣
║ Address: ${this.user.thisUserAddress.slice(0, 10)}...                                ║
║ Balance: ${ethers.formatEther(await this.user.getBalance())} ETH                           ║
╠════════════════════════════════════════════════════════════════╣
║ Commands:                                                      ║
║   pay <amount> <recipient> - Make a payment                    ║
║   swap <amount> <fromToken> <toToken> - Perform a swap         ║
║   balance - Show detailed balance                              ║
║   channels - List open channels                                ║
║   chat <channelId> - Open chat for a channel                   ║
║   dispute <channelId> - Open a dispute                         ║
║   exit - Exit the client                                       ║
╚════════════════════════════════════════════════════════════════╝
    `);
    await this.listChannels();
  }

  private async prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  }

  private async handleCommand(command: string) {
    const [action, ...args] = command.split(' ');
    switch (action) {
      case 'pay':
        await this.handlePayment(args[0], args[1]);
        break;
      case 'swap':
        await this.handleSwap(args[0], args[1], args[2]);
        break;
      case 'balance':
        await this.showDetailedBalance();
        break;
      case 'channels':
        await this.listChannels();
        break;
      case 'chat':
        await this.openChat(args[0]);
        break;
      case 'dispute':
        await this.openDispute(args[0]);
        break;
      case 'exit':
        process.exit(0);
      default:
        console.log('Unknown command');
    }
    await this.prompt('Press Enter to continue...');
  }

  private async handlePayment(amount: string, recipient: string) {
    // Implement payment logic
    console.log(`Sending ${amount} to ${recipient}`);
  }

  private async handleSwap(amount: string, fromToken: string, toToken: string) {
    // Implement swap logic
    console.log(`Swapping ${amount} ${fromToken} to ${toToken}`);
  }

  private async showDetailedBalance() {
    // Implement detailed balance display
    console.log('Detailed balance:');
    // ... display balance for each token
  }

  private async listChannels() {
    const channels = await this.user.getChannels();
    console.log('Open Channels:');
    channels.forEach((channel, index) => {
      console.log(`${index + 1}. ${channel.getId()} - Balance: ${channel.getBalance()}`);
    });
  }

  private async openChat(channelId: string) {
    console.log(`Opening chat for channel ${channelId}`);
    while (true) {
      const message = await this.prompt('Enter message (or "exit" to leave chat): ');
      if (message.toLowerCase() === 'exit') break;
      await this.sendEncryptedMessage(channelId, message);
    }
  }

  private async sendEncryptedMessage(channelId: string, message: string) {
    const channel = await this.user.getChannel(channelId);
    const encryptedMessage = await this.user.encryptMessage(channel.otherUserAddress, message);
    const transition = new Transition.TextMessage(encryptedMessage);
    await channel.push(transition);
    await channel.flush();
  }

  private async openDispute(channelId: string) {
    console.log(`Opening dispute for channel ${channelId}`);
    // Implement dispute logic
  }
}