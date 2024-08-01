// XLNTerminal.ts

import * as readline from 'readline';
import { createInterface } from 'readline';
import User from './User';
import Channel from './Channel';
import { Transition } from './Transition';
import { ethers } from 'ethers';
import colors from './colors';
import ENV from '../env';
import { sleep } from '../utils/Utils';
import { Subchannel, Delta } from '../types/Subchannel';
import * as repl from 'repl';

const LOGO = [

  "██╗  ██╗ ██╗     ███╗   ██╗",
  "╚██╗██╔╝ ██║     ████╗  ██║",
  " ╚███╔╝  ██║     ██╔██╗ ██║",
  " ██╔██╗  ██║     ██║╚██╗██║",
  "██╔╝ ██╗ ███████╗██║ ╚████║",
  "╚═╝  ╚═╝ ╚══════╝╚═╝  ╚═══╝"
];

const pageSize = 20;


export class XLNTerminal {
  private rl: readline.Interface;
  private currentUser: User | null = null;
  private currentChannel: Channel | null = null;
  private commandHistory: string[] = [];
  private historyIndex: number = 0;
  private currentPage: number = 0;

  private tokenNames: { [key: number]: string } = {
    1: 'ETH', 2: 'USDC', 3: 'USDT', 4: 'WBTC', 5: 'DAI',
    6: 'LINK', 7: 'UNI', 8: 'AAVE', 9: 'MKR', 10: 'SNX'
  };

  private chainNames: { [key: number]: string } = {
    1: 'Ethereum', 56: 'Binance Smart Chain', 137: 'Polygon',
    10: 'Optimism', 42161: 'Arbitrum', 43114: 'Avalanche',
    250: 'Fantom', 100: 'Gnosis', 42220: 'Celo', 1284: 'Moonbeam'
  };

  constructor(
    public users: { [key: string]: User },
    private ENV: any
  ) {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string) => this.completer(line),
    });
  }

  public async start() {
    this.showWelcomeScreen();
    await this.showSystemTree();
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
      case 'directpayment':
        await this.makePayment(args[0], args[1]);
        break;
      case 'balance':
        await this.showBalance();
        break;
      case 'topology':
        await this.showNetworkTopology();
        break;
      case 'send':
        await this.sendOnionRoutedPayment(args[0], args.slice(1));
        break;
      case 'addsubchannel':
        await this.addSubchannel(parseInt(args[0]));
        break;
      case 'adddelta':
        await this.addDelta(parseInt(args[0]), parseInt(args[1]));
        break;
      case 'credit':
        await this.setCreditLimit(parseInt(args[0]), parseInt(args[1]), ethers.parseEther(args[2]));
        break;
      case 'tree':
        this.showSystemTree();
        break;
      case 'exit':
        this.exit();
        break;
      case 'next':
        this.currentPage = Math.min(this.currentPage + 1, Math.ceil(Object.keys(this.users).length / pageSize) - 1);
        break;
      case 'prev':
        this.currentPage = Math.max(this.currentPage - 1, 0);
        break;
      case 'chat':
        await this.chat(args[0], args.slice(1).join(' '));
        break;
      case 'lookup':
        await this.lookupUser(args[0]);
        break;
      case 'repl':
        this.startREPL();
        break;
      default:
        console.log(colors.red('Unknown command. Type "help" for a list of commands.'));
    }

    // Show the system tree after every command
    //await this.showSystemTree(this.currentPage);
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
    console.log(colors.green('  directpayment <amount> <token>') + ' - Make hashlock-free payment in the current channel');
    console.log(colors.green('  balance') + ' - Show the balance of the current channel');
    console.log(colors.green('  topology') + ' - Show the network topology');
    console.log(colors.green('  send <amount> <hop1> <hop2> ... <hop-destination>') + ' - Send an onion routed payment');
    console.log(colors.green('  addsubchannel <chainId>') + ' - Add a subchannel');
    console.log(colors.green('  adddelta <chainId> <tokenId>') + ' - Add a delta');
    console.log(colors.green('  credit <chainId> <tokenId> <amount>') + ' - Set credit limit');
    console.log(colors.green('  tree') + ' - Show the current state tree');
    console.log(colors.green('  exit') + ' - Exit the terminal');
    console.log(colors.green('  chat <recipient> <message>') + ' - Send a message to a user');
    console.log(colors.green('  lookup <nameOrAddress>') + ' - Look up a user by name or address');
    console.log(colors.green('  repl') + ' - Enter REPL mode');
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

  private async openChannel(nameOrAddress: string) {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    const targetUser = this.getUserByNameOrAddress(nameOrAddress);
    if (!targetUser) {
      console.log(colors.red(`User ${nameOrAddress} not found`));
      return;
    }
    try {
      this.currentChannel = await this.currentUser.getChannel(targetUser.thisUserAddress);
      console.log(colors.green(`Opened channel with ${targetUser.username} (${targetUser.thisUserAddress})`));
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

  private async sendOnionRoutedPayment(amount: string, hops: string[]) {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    hops = hops.map(hop => {
      return hop.length == 42 ? hop : ENV.nameToAddress[hop.toLowerCase()]
    });

    console.log(amount, hops);

    try {
      const paymentAmount = ethers.parseEther(amount);
      const {paymentTransition, completionPromise} = await this.currentUser.createOnionEncryptedPayment(
        1,
        1,
        paymentAmount,
        hops
      );
      //await completionPromise;

      await this.currentUser.addToMempool(hops[0], paymentTransition, true);
      console.log(colors.green(`Onion routed payment of ${amount} ETH sent to ${hops[hops.length - 1]}`));
    } catch (error) {
      console.log(colors.red(`Error sending onion routed payment: ${(error as Error).message}`), error);
    }
  }

  private async addSubchannel(chainId: number) {
    if (!this.currentUser || !this.currentChannel) {
      console.log(colors.red('Please login and open a channel first'));
      return;
    }
    await this.currentUser.addToMempool(this.currentChannel.otherUserAddress, new Transition.AddSubchannel(chainId), true);
    console.log(colors.green(`Added subchannel with chain ID ${chainId}`));
  }

  private async addDelta(chainId: number, tokenId: number) {
    if (!this.currentUser || !this.currentChannel) {
      console.log(colors.red('Please login and open a channel first'));
      return;
    }
    await this.currentUser.addToMempool(this.currentChannel.otherUserAddress, new Transition.AddDelta(chainId, tokenId), true);
    console.log(colors.green(`Added delta for chain ID ${chainId} and token ID ${tokenId}`));
  }

  private async setCreditLimit(chainId: number, tokenId: number, amount: bigint) {
    if (!this.currentUser || !this.currentChannel) {
      console.log(colors.red('Please login and open a channel first'));
      return;
    }
    await this.currentUser.addToMempool(this.currentChannel.otherUserAddress, new Transition.SetCreditLimit(chainId, tokenId, amount), true);
    console.log(colors.green(`Set credit limit to ${ethers.formatEther(amount)} for chain ID ${chainId} and token ID ${tokenId}`));
  }

  private showStateTree() {
    console.log(colors.yellow('\nCurrent State Tree:'));
    this.printTreeNode('ENV', ENV, 0);
  }

  private async printTreeNode(key: string, value: any, depth: number, isLast: boolean = false, prefix: string = '') {
    const currentPrefix = `${prefix}${isLast ? '└─ ' : '├─ '}`;
    const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
    
    if (typeof value === 'object' && value !== null) {
      if (depth === 0) {
        console.log(`${colors.cyan(key)}`);
      } else if (value.username) {
        console.log(`${currentPrefix}${colors.green(`${value.username} (${key})`)}`);
        await this.printChannels(value.channels, childPrefix);
        return;
      } else {
        console.log(`${currentPrefix}${colors.cyan(key)}`);
      }
      const entries = Object.entries(value);
      for (let i = 0; i < entries.length; i++) {
        const [k, v] = entries[i];
        await this.printTreeNode(k, v, depth + 1, i === entries.length - 1, childPrefix);
      }
    } else {
      console.log(`${currentPrefix}${colors.cyan(key)}: ${colors.green(value)}`);
    }
  }

  private async printChannels(channels: Channel[], prefix: string) {
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      const isLastChannel = i === channels.length - 1;
      const currentPrefix = `${prefix}${isLastChannel ? '└─ ' : '├─ '}`;
      const childPrefix = `${prefix}${isLastChannel ? '   ' : '│  '}`;
      const otherUser = this.users[channel.otherUserAddress] || { username: 'Unknown' };
      console.log(`${currentPrefix}Channel: ${otherUser.username} (${channel.otherUserAddress})`);
      
      await this.printSubchannels(channel, childPrefix);
    }
  }

  private async printSubchannels(channel: Channel, prefix: string) {
    const subchannels = channel.state.subchannels;
    for (let i = 0; i < subchannels.length; i++) {
      const subchannel = subchannels[i];
      const isLastSubchannel = i === subchannels.length - 1;
      const currentPrefix = `${prefix}${isLastSubchannel ? '└─ ' : '├─ '}`;
      const childPrefix = `${prefix}${isLastSubchannel ? '   ' : '│  '}`;
      const chainName = this.chainNames[subchannel.chainId] || `Chain ${subchannel.chainId}`;
      console.log(`${currentPrefix}Subchannel: ${chainName} (${subchannel.chainId})`);
      
      await this.printDeltas(channel, subchannel, childPrefix);
    }
  }

  private async printDeltas(channel: Channel, subchannel: Subchannel, prefix: string) {
    const deltas = subchannel.deltas;
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      const isLastDelta = i === deltas.length - 1;
      const currentPrefix = `${prefix}${isLastDelta ? '└─ ' : '├─ '}`;
      const childPrefix = `${prefix}${isLastDelta ? '   ' : '│  '}`;
      const tokenName = this.tokenNames[delta.tokenId] || `Token ${delta.tokenId}`;
      const derived = channel.deriveDelta(subchannel.chainId, delta.tokenId, channel.isLeft);
      console.log(`${currentPrefix}${tokenName} (${delta.tokenId}), in: ${this.formatAmount(derived.inCapacity)}, out: ${this.formatAmount(derived.outCapacity)}`);
      
      // Print ASCII representation
      const asciiLine = derived.ascii.replace(/-/g, colors.red('-')).replace(/=/g, colors.green('='));
      console.log(`${childPrefix}${asciiLine}`);
    }
  }

  private formatAmount(amount: bigint): string {
    return ethers.formatEther(amount);
  }

  private exit() {
    console.log(colors.yellow('Exiting XLN Terminal. Goodbye!'));
    this.rl.close();
    process.exit(0);
  }

  private completer(line: string): [string[], string] {
    const completions = [
      'help', 'users', 'create', 'login', 'logout', 'list', 'open', 'close',
      'directpayment', 'balance', 'topology', 'send', 'exit', 'addsubchannel', 'adddelta', 'credit', 'tree',
      'chat', 'lookup', 'next', 'prev', 'repl'
    ];
    const hits = completions.filter((c) => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  }

  private async showSystemTree(page: number = 0) {
    console.log(colors.yellow('\nCurrent System State:'));
    const allUsers = Object.values(this.users);
    const startIndex = page * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedUsers = allUsers.slice(startIndex, endIndex);

    const usersData = await Promise.all(paginatedUsers.map(async user => {
      const channels = await user.getChannels();
      return [user.thisUserAddress, {
        username: user.username,
        channels: channels,
      }];
    }));

    await this.printTreeNode('ENV', {
      users: Object.fromEntries(usersData),
    }, 0);

    console.log(colors.yellow(`\nPage ${page + 1} of ${Math.ceil(allUsers.length / pageSize)}`));
    console.log(colors.yellow('Use "next" or "prev" to navigate pages'));
  }

  private async chat(recipient: string, message: string) {
    if (!this.currentUser) {
      console.log(colors.red('Please login first'));
      return;
    }
    const recipientUser = this.getUserByNameOrAddress(recipient);
    if (!recipientUser) {
      console.log(colors.red(`User ${recipient} not found`));
      return;
    }
    const channel = await this.currentUser.getChannel(recipientUser.thisUserAddress);
    const encryptedMessage = await this.currentUser.encryptMessage(recipientUser.thisUserAddress, message);
    await this.currentUser.addToMempool(recipientUser.thisUserAddress, new Transition.TextMessage(encryptedMessage), true);
    console.log(colors.green(`Message sent to ${recipientUser.username}`));
  }

  private async lookupUser(nameOrAddress: string) {
    const user = this.getUserByNameOrAddress(nameOrAddress);
    if (!user) {
      console.log(colors.red(`User ${nameOrAddress} not found`));
      return;
    }
    console.log(colors.yellow(`\nUser Profile:`));
    console.log(colors.green(`Username: ${user.username}`));
    console.log(colors.green(`Address: ${user.thisUserAddress}`));
    const channels = await user.getChannels();
    console.log(colors.green(`Channels: ${channels.length}`));
    channels.forEach((channel, index) => {
      console.log(colors.blue(`  Channel ${index + 1}: ${channel.otherUserAddress}`));
    });
  }

  private getUserByNameOrAddress(nameOrAddress: string): User | undefined {
    return Object.values(this.users).find(user => 
      user.username.toLowerCase() === nameOrAddress.toLowerCase() || user.thisUserAddress === nameOrAddress
    );
  }

  private startREPL() {
    console.log(colors.yellow('Entering REPL mode. Type .exit to return to the terminal.'));
    const replServer = repl.start({
      prompt: 'XLN> ',
      useColors: true,
      ignoreUndefined: true,
    });

    // Make users, channels, and other relevant objects available in the REPL context
    replServer.context.users = this.users;
    replServer.context.currentUser = this.currentUser;
    replServer.context.currentChannel = this.currentChannel;
    replServer.context.ENV = ENV;

    // Add helper functions
    replServer.context.getUser = (nameOrAddress: string) => this.getUserByNameOrAddress(nameOrAddress);
    replServer.context.getChannel = (user1: User, user2: User) => user1.getChannel(user2.thisUserAddress);

    // Add a command to exit REPL mode and return to the terminal
    replServer.defineCommand('terminal', {
      help: 'Exit REPL mode and return to the terminal',
      action: () => {
        replServer.close();
        this.showPrompt();
      },
    });

    // When REPL is exited, return to the terminal prompt
    replServer.on('exit', () => {
      console.log(colors.yellow('Exiting REPL mode. Returning to terminal.'));
      this.showPrompt();
    });
  }
}
