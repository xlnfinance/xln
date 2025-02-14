import { Buffer } from 'buffer';
import { encode, decode } from 'rlp';

export type ChannelInput = 
  | { type: 'AddChannelTx', tx: Buffer }
  | { type: 'Consensus',
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      counterpartySig?: Buffer
    }

export type ChannelRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: Buffer
  consensusBlock?: Buffer
  mempool: Map<string, Buffer>  // txHash -> channelTx
}

export function encodeChannelRoot(root: ChannelRoot): Buffer {
  return encode([
    root.status,
    root.finalBlock || Buffer.from([]),
    root.consensusBlock || Buffer.from([]),
    Array.from(root.mempool.entries())
  ]);
}

export function decodeChannelRoot(data: Buffer): ChannelRoot {
  const [status, finalBlock, consensusBlock, mempoolRlp] = decode(data) as unknown as [Buffer, Buffer, Buffer, Buffer[][]];
  
  return {
    status: Buffer.from(status).toString() as 'idle' | 'precommit' | 'commit',
    finalBlock: finalBlock.length > 0 ? finalBlock : undefined,
    consensusBlock: consensusBlock.length > 0 ? consensusBlock : undefined,
    mempool: new Map(mempoolRlp as [string, Buffer][])
  };
} 