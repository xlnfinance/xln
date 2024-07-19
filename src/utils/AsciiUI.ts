import User from '../app/User';
import Channel from '../app/Channel';
import { Subchannel, Delta } from '../types/Subchannel';

export class AsciiUI {
  private static readonly BOX_WIDTH = 80;

  static async renderUser(user: User): Promise<string> {
    const channels = Array.from(user._channels.values());
    let output = this.createBox(`User: ${user.thisUserAddress}`);

    for (const channel of channels) {
      output += await this.renderChannel(channel);
    }

    return output;
  }

  private static async renderChannel(channel: Channel): Promise<string> {
    const state = channel.getState();
    let output = this.createBox(`Channel with: ${channel.otherUserAddress}`);
    output += `Block Number: ${state.blockNumber}\n`;

    for (const subchannel of state.subchannels) {
      output += this.renderSubchannel(subchannel, channel);
    }

    return output;
  }

  private static renderSubchannel(subchannel: Subchannel, channel: Channel): string {
    let output = this.createBox(`Subchannel: Chain ID ${subchannel.chainId}`);
    output += `Cooperative Nonce: ${subchannel.cooperativeNonce}\n`;
    output += `Dispute Nonce: ${subchannel.disputeNonce}\n\n`;

    for (const delta of subchannel.deltas) {
      output += this.renderDelta(delta, channel, subchannel.chainId);
    }

    return output;
  }

  private static renderDelta(delta: Delta, channel: Channel, chainId: number): string {
    const derived = channel.deriveDelta(chainId, delta.tokenId);
    let output = this.createBox(`Token ID: ${delta.tokenId}`);
    output += `Collateral: ${delta.collateral}\n`;
    output += `On-chain Delta: ${delta.ondelta}\n`;
    output += `Off-chain Delta: ${delta.offdelta}\n`;
    output += `Left Credit Limit: ${delta.leftCreditLimit}\n`;
    output += `Right Credit Limit: ${delta.rightCreditLimit}\n\n`;
    output += `Derived Values:\n`;
    output += `Total Delta: ${derived.delta}\n`;
    output += `In Collateral: ${derived.inCollateral}\n`;
    output += `Out Collateral: ${derived.outCollateral}\n`;
    output += `In Own Credit: ${derived.inOwnCredit}\n`;
    output += `Out Peer Credit: ${derived.outPeerCredit}\n`;
    output += `Total Capacity: ${derived.totalCapacity}\n`;
    output += `In Capacity: ${derived.inCapacity}\n`;
    output += `Out Capacity: ${derived.outCapacity}\n\n`;
    output += `Balance Visualization:\n${derived.ascii}\n`;

    return output;
  }

  private static createBox(title: string): string {
    const paddedTitle = ` ${title} `;
    const sideWidth = Math.floor((this.BOX_WIDTH - paddedTitle.length) / 2);
    const topBottom = '='.repeat(this.BOX_WIDTH);
    const titleLine = '='.repeat(sideWidth) + paddedTitle + '='.repeat(this.BOX_WIDTH - sideWidth - paddedTitle.length);

    return `${topBottom}\n${titleLine}\n${topBottom}\n`;
  }
}