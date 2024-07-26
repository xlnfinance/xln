// XLNTerminal.ts

import * as readline from 'readline';
import { createInterface } from 'readline';
import User from './User';
import Channel from './Channel';
import { Transition } from './Transition';
import { ethers } from 'ethers';

import colors from './colors';
import ENV from '../env';


const LOGO = [

  "██╗  ██╗ ██╗     ███╗   ██╗",
  "╚██╗██╔╝ ██║     ████╗  ██║",
  " ╚███╔╝  ██║     ██╔██╗ ██║",
  " ██╔██╗  ██║     ██║╚██╗██║",
  "██╔╝ ██╗ ███████╗██║ ╚████║",
  "╚═╝  ╚═╝ ╚══════╝╚═╝  ╚═══╝"
];

export class XLNTerminal {
  private rl: any;
  private currentUser: User | null = null;
  private currentChannel: Channel | null = null;
  private commandHistory: string[] = [];
  private historyIndex: number = 0;

  constructor(public users: any) {
    this.rl = 0
    //setTimeout(() => {
      this.rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: (line: string) => this.completer(line),
      });
    //},100)

  }

  public async start() {
    this.showWelcomeScreen();
    while (true) {
      await this.showPrompt();
      const command = await this.getUserInput();
      await this.handleCommand(command);
    }
  }

  private showWelcomeScreen() {
    console.clear();
    console.log(colors.cyan(LOGO.join('\n')));
    console.log(colors.yellow('\nWelcome to the XLN Terminal!\n'));
    console.log(colors.green('Type "help" for a list of commands.'));
  }

  private async showPrompt() {
    const breadcrumbs = this.getBreadcrumbs();
    process.stdout.write(colors.blue(`\n${breadcrumbs} > `));
  }

  private getBreadcrumbs(): string {
    let breadcrumbs = 'XLN';
    if (this.currentUser) {
      breadcrumbs += ` > ${this.currentUser.username} (${this.currentUser.thisUserAddress.slice(0, 6)})`;
      if (this.currentChannel) {
        const otherUser = this.currentChannel.otherUserAddress;
        breadcrumbs += ` > ${otherUser.slice(0, 6)}`;
      }
    }
    return breadcrumbs;
  }

  private async getUserInput(): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question('', (answer: any) => {
        this.commandHistory.push(answer);
        this.historyIndex = this.commandHistory.length;
        resolve(answer);
      });
    });
  }

  private async handleCommand(command: string) {
    const [action, ...args] = command.split(' ');
    switch (action) {
      case 'help':
        this.showHelp();
        break;
      case 'create':
        await this.createUser(args[0], args[1]);
        break;
      case 'login':
        await this.loginUser(args[0]);
        break;
      case 'logout':
        this.logoutUser();
        break;
      case 'users':
        this.listUsers();
        break;
      case 'list':
        await this.listChannels();
        break;
      case 'open':
        await this.openChannel(args[0]);
        break;
      case 'close':
        this.closeChannel();
        break;
      case 'pay':
        await this.makePayment(args[0], args[1]);
        break;
      case 'balance':
        await this.showBalance();
        break;
      case 'topology':
        await this.showNetworkTopology();
        break;
      case 'send':
        await this.sendOnionRoutedPayment(args[0], args[1], args.slice(2));
        break;
      case 'exit':
        this.exit();
        break;
      default:
        console.log(colors.red('Unknown command. Type "help" for a list of commands.'));
    }
  }

  private showHelp() {
    console.log(colors.yellow('\nAvailable commands:'));
    console.log(colors.green('  create <username> <password>') + ' - Create a new user');
    console.log(colors.green('  users') + ' - List active users');
    console.log(colors.green('  login <username>') + ' - Log into a user account');
    console.log(colors.green('  logout') + ' - Log out of the current user account');
    console.log(colors.green('  list') + ' - List all channels for the current user');
    console.log(colors.green('  open <address>') + ' - Open or switch to a channel');
    console.log(colors.green('  close') + ' - Close the current channel');
    console.log(colors.green('  pay <amount> <token>') + ' - Make a payment in the current channel');
    console.log(colors.green('  balance') + ' - Show the balance of the current channel');
    console.log(colors.green('  topology') + ' - Show the network topology');
    console.log(colors.green('  send <amount> <destination> <hop1> <hop2> ...') + ' - Send an onion routed payment');
    console.log(colors.green('  exit') + ' - Exit the terminal');
  }

  private async createUser(username: string, password: string) {
    if (!username || !password) {
      console.log(colors.yellow('Exiting XLN Terminal. Goodbye!'));
      return;
    }
    const newUser = new User(username, password);
    await newUser.start();
    this.users[newUser.thisUserAddress] = newUser;
    console.log(colors.green(`Created new user ${username} with address: ${newUser.thisUserAddress}`));
  }

  private async loginUser(username: string) {
    for (const [address, user] of Object.entries(this.users)) {
      if ((user as any).username === username) {
        this.currentUser = user as any;
        console.log(colors.green(`Logged in as ${username}`));
        return;
      }
    }
    console.log(colors.red(`User ${username} not found`));
  
  }

  private logoutUser() {
    if (this.currentUser) {
      console.log(colors.green(`Logged out user: ${this.currentUser.username}`));
      this.currentUser = null;
      this.currentChannel = null;
    } else {
      console.log(colors.yellow('No user is currently logged in'));
    }
  }
  private async listUsers() {
    console.log(colors.yellow('\nRegistered Users:'));
    for (const [address, user] of Object.entries((this.users))) {
      console.log(colors.green(`  ${(user as any).username} (${address})`));
    }
  }
  private async listChannels() {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    const channels = await this.currentUser.getChannels();
    console.log(colors.yellow('\nChannels:'));
    channels.forEach((channel, index) => {
      console.log(colors.green(`  ${index + 1}. ${channel.getId()}`));
    });
  }

  private async openChannel(address: string) {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    try {
      this.currentChannel = await this.currentUser.getChannel(address);
      console.log(colors.green(`Opened channel with ${address}`));
    } catch (error) {
      console.log(colors.red(`Error opening channel: ${(error as Error).message}`));
    }
  }

  private closeChannel() {
    if (this.currentChannel) {
      console.log(colors.green(`Closed channel with ${this.currentChannel.otherUserAddress}`));
      this.currentChannel = null;
    } else {
      console.log(colors.yellow('No channel is currently open'));
    }
  }

  private async makePayment(amount: string, token: string) {
    if (!this.currentUser || !this.currentChannel) {
      console.log(colors.red('Please login and open a channel first'));
      return;
    }
    try {
      const paymentAmount = ethers.parseEther(amount);
      const transition = new Transition.DirectPayment(1, parseInt(token), paymentAmount);
      await this.currentUser.addToMempool(this.currentChannel.otherUserAddress, transition, true);
      console.log(colors.green(`Payment of ${amount} ${token} sent successfully`));
    } catch (error) {
      console.log(colors.red(`Error making payment: ${(error as Error).message}`));
    }
  }

  private async showBalance() {
    if (!this.currentUser || !this.currentChannel) {
      console.log(colors.red('Please login and open a channel first'));
      return;
    }
    const balance = await this.currentChannel.getBalance();
    console.log(colors.yellow(`Current channel balance: ${ethers.formatEther(balance)} ETH`));
  }

  private async showNetworkTopology() {
    console.log(colors.yellow('\nNetwork Topology:'));
    for (let [address, u] of Object.entries(this.users)) {
      let user = u as any;
      console.log(colors.green(`  ${user.username} (${address.slice(0, 6)})`));
      const channels = await user.getChannels();
      for (const channel of channels) {
        console.log(colors.blue(`    ├─ ${channel.otherUserAddress.slice(0, 6)}`));
      }
    }
  }

  private async sendOnionRoutedPayment(amount: string, destination: string, hops: string[]) {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    try {
      const paymentAmount = ethers.parseEther(amount);
      const {paymentTransition, completionPromise} = await this.currentUser.createOnionEncryptedPayment(
        1,
        1,
        paymentAmount,
        hops.concat(destination)
      );
      //await completionPromise;

      await this.currentUser.addToMempool(hops[0], paymentTransition, true);
      console.log(colors.green(`Onion routed payment of ${amount} ETH sent to ${destination}`));
    } catch (error) {
      console.log(colors.red(`Error sending onion routed payment: ${(error as Error).message}`), error);
    }
  }

  private exit() {
    console.log(colors.yellow('Exiting XLN Terminal. Goodbye!'));
    this.rl.close();
    process.exit(0);
  }

  private completer(line: string): [string[], string] {
    const completions = [
      'help', 'users', 'create', 'login', 'logout', 'list', 'open', 'close',
      'pay', 'balance', 'topology', 'send', 'exit'
    ];
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  }
}