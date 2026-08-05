export type DaemonRequest =
  | { id: string; op: 'ping' }
  | { id: string; op: 'status' }
  | { id: string; op: 'hubs' }
  | {
      id: string;
      op: 'open';
      hubEntityId: string;
      creditAmount: string;
      tokenId?: number;
    }
  | {
      id: string;
      op: 'pay';
      to: string;
      amount: string;
      tokenId?: number;
      mode?: string;
      hub?: string;
      description?: string;
    }
  | {
      id: string;
      op: 'swap';
      hubEntityId: string;
      giveTokenId: number;
      wantTokenId: number;
      giveAmount: string;
      wantAmount: string;
    }
  | {
      id: string;
      op: 'move';
      kind: 'r2c' | 'r2r' | 'r2e';
      amount: string;
      tokenId?: number;
      counterpartyId?: string;
      to?: string;
    }
  | {
      id: string;
      op: 'lend';
      lendOp: 'offer' | 'borrow' | 'repay';
      hubEntityId: string;
      amount: string;
      tokenId?: number;
    }
  | { id: string; op: 'receive' }
  | { id: string; op: 'shutdown' };

export type DaemonResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export const encodeMessage = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

export const createFrameDecoder = () => {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): unknown[] {
      buffer = Buffer.concat([buffer, chunk]);
      const messages: unknown[] = [];
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < 4 + size) break;
        const body = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        messages.push(JSON.parse(body.toString('utf8')));
      }
      return messages;
    },
  };
};
