import * as blessed from 'blessed';
import  User  from './User';
import { Transition } from './Transition';

export class XLNInteractiveDashboard {
  private screen: any;
  private channelsBox: any;
  private chatBox: any;
  private inputBox: any;

  constructor(private user: User) {
    this.screen = blessed.screen();
  }

  start() {
    this.renderDashboard();
    this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
    this.screen.render();
  }

  private renderDashboard() {
    // Header
    blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: ' XLN Interactive Dashboard ',
      style: {bg: 'blue', fg: 'white', bold: true},
      align: 'center',
    });

    // Channels
    this.channelsBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: '50%',
      height: '100%-6',
      label: 'Open Channels',
      border: {type: 'line'},
      scrollable: true,
      scrollbar: {ch: ' ', track: {bg: 'cyan'}},
      style: {bg: 'black', fg: 'white'},
    });

    // Chat Box
    this.chatBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: '50%',
      width: '50%',
      height: '100%-6',
      label: 'Chat',
      border: {type: 'line'},
      scrollable: true,
      scrollbar: {ch: ' ', track: {bg: 'cyan'}},
      style: {bg: 'black', fg: 'white'},
    });

    // Command input
    this.inputBox = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      inputOnFocus: true,
      border: {type: 'line'},
      style: {bg: 'black', fg: 'white'},
    });

    this.inputBox.on('submit', async (text: string) => {
      await this.handleCommand(text);
      this.inputBox.clearValue();
      this.screen.render();
    });

    this.inputBox.focus();

    this.updateDashboard();
  }

  private async updateDashboard() {
    const channels = await this.user.getChannels();
    let content = '';
    channels.forEach((channel, index) => {
      content += `${index + 1}. ${channel.getId()}\n`;
      channel.state.subchannels.forEach(({ chainId, deltas }) => {
        deltas.forEach(({ tokenId }) => {
          content += `  - ${channel.deriveDelta(chainId, tokenId, channel.isLeft)}\n`;
        });
      });
    });
    this.channelsBox.setContent(content);
    this.screen.render();
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
      case 'chat':
        await this.openChat(args[0]);
        break;
      case 'dispute':
        await this.openDispute(args[0]);
        break;
      default:
        this.chatBox.pushLine(`Unknown command: ${command}`);
    }
    this.updateDashboard();
  }

  private async handlePayment(amount: string, recipient: string) {
    // Implement payment logic
    this.chatBox.pushLine(`Sending ${amount} to ${recipient}`);
  }

  private async handleSwap(amount: string, fromToken: string, toToken: string) {
    // Implement swap logic
    this.chatBox.pushLine(`Swapping ${amount} ${fromToken} to ${toToken}`);
  }

  private async openChat(channelId: string) {
    this.chatBox.setLabel(`Chat - Channel ${channelId}`);
    this.chatBox.pushLine(`Opening chat for channel ${channelId}`);
    // Implement chat logic
  }

  private async openDispute(channelId: string) {
    this.chatBox.pushLine(`Opening dispute for channel ${channelId}`);
    // Implement dispute logic
  }
}