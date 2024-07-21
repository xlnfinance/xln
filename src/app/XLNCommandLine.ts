import { Command } from 'commander';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import User from './User';
import { Transition } from './Transition';

let chalk: any;
import("chalk").then((chalk) => {
  // Use chalk here
  chalk = chalk;
});

export class XLNCommandLine {
  private program: Command;

  constructor(private user: User) {
    this.program = new Command();
    this.setupCommands();
  }

  start() {
    this.program.parse(process.argv);
  }

  private setupCommands() {
    this.program
      .version('1.0.0')
      .description('XLN Command-line Interface');

    this.program
      .command('dashboard')
      .description('Show the main dashboard')
      .action(() => this.showDashboard());

    this.program
      .command('pay')
      .description('Make a payment')
      .action(() => this.handlePayment());

    this.program
      .command('swap')
      .description('Perform a token swap')
      .action(() => this.handleSwap());

    this.program
      .command('balance')
      .description('Show detailed balance')
      .action(() => this.showDetailedBalance());

    this.program
      .command('channels')
      .description('List open channels')
      .action(() => this.listChannels());

    this.program
      .command('chat <channelId>')
      .description('Open chat for a channel')
      .action((channelId) => this.openChat(channelId));

    this.program
      .command('dispute <channelId>')
      .description('Open a dispute for a channel')
      .action((channelId) => this.openDispute(channelId));
  }

  private async showDashboard() {
    console.log(chalk.bold.blue('XLN Dashboard'));
    console.log(chalk.yellow('Address: ') + this.user.thisUserAddress);
    console.log(chalk.yellow('Balance: ') + chalk.green(ethers.formatEther(await this.user.getBalance())) + ' ETH');
    await this.listChannels();
  }

  private async handlePayment() {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'amount',
        message: 'Enter payment amount:',
      },
      {
        type: 'input',
        name: 'recipient',
        message: 'Enter recipient address:',
      },
    ] as any);

    // Implement payment logic
    console.log(chalk.green('Payment sent successfully!'));
  }

  private async handleSwap() {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'amount',
        message: 'Enter amount to swap:',
      },
      {
        type: 'input',
        name: 'fromToken',
        message: 'Enter token to swap from:',
      },
      {
        type: 'input',
        name: 'toToken',
        message: 'Enter token to swap to:',
      },
    ] as any);

    // Implement swap logic
    console.log(chalk.green('Swap completed successfully!'));
  }

  private async showDetailedBalance() {
    // Implement detailed balance display
    console.log(chalk.blue('Detailed Balance:'));
    // ... display balance for each token
  }

  private async listChannels() {
    const channels = await this.user.getChannels();
    console.log(chalk.blue('Open Channels:'));
    channels.forEach((channel, index) => {
      console.log(chalk.cyan(`${index + 1}. ${channel.getId()} - Balance: ${channel.getBalance()}`));
    });
  }

  private async openChat(channelId: string) {
    console.log(chalk.blue(`Opening chat for channel ${channelId}`));
    const channel = await this.user.getChannel(channelId);

    while (true) {
      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'message',
          message: 'Enter message (or "exit" to leave chat):',
        },
      ] as any);

      if (answer.message.toLowerCase() === 'exit') break;

      const encryptedMessage = await this.user.encryptMessage(channel.otherUserAddress, answer.message);
      const transition = new Transition.TextMessage(encryptedMessage);
      await channel.push(transition);
      await channel.flush();
      console.log(chalk.green('Message sent!'));
    }
  }

  private async openDispute(channelId: string) {
    console.log(chalk.red(`Opening dispute for channel ${channelId}`));
    // Implement dispute logic
  }
}