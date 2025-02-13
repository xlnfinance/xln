import { createHash } from 'crypto';
import { encode, decode } from 'rlp';
import type { EntityRoot } from './types';

// Transaction validation
export type SignedTx = {
  nonce: number,
  to: string,    // entityId
  data: Buffer,  // RLP encoded command
  signature: Buffer
}

function decodeNonce(nonceBuffer: Buffer | number | undefined): number {
  // Handle non-Buffer cases
  if (nonceBuffer === undefined) return 0;
  if (typeof nonceBuffer === 'number') return nonceBuffer;
  
  // Handle Buffer cases
  if (nonceBuffer.length === 1 && nonceBuffer[0] === 0x80) return 0;
  if (nonceBuffer.length === 1) return nonceBuffer[0];
  
  const bn = BigInt('0x' + nonceBuffer.toString('hex'));
  if (bn > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Nonce too large');
  }
  return Number(bn);
}

// TODO: Implement real signature recovery
function recoverSigner(tx: SignedTx): string {
  // For testing, just return first 20 bytes of signature as signer
  return tx.signature.slice(0, 20).toString('hex');
}

export function validateTx(tx: SignedTx | Buffer, state: EntityRoot): boolean {
  // For raw Buffer input
  if (Buffer.isBuffer(tx)) {
    const decoded = decode(tx) as unknown as number[];
    const cmd = Buffer.from(decoded[0] as unknown as number[]);
    
    // Allow Create command
    if (cmd.equals(Buffer.from('Create'))) {
      return true;
    }
    
    // For other commands, check state exists
    if (!state) {
      console.log('Entity not created');
      return false;
    }
    
    // Allow Increment command
    if (cmd.equals(Buffer.from('Increment'))) {
      return true;
    }
    
    return false;
  }

  // Regular signed transactions
  const nonce = decodeNonce(tx.nonce as unknown as Buffer);
  const expectedNonce = state.nonce || 0;
  
  if (nonce !== expectedNonce) {
    console.log(`Invalid nonce: expected ${expectedNonce}, got ${nonce}`);
    return false;
  }

  const signer = recoverSigner(tx);
  if (!state.signers?.has(signer)) {
    console.log(`Invalid signer: ${signer}`);
    return false;
  }

  return true;
} 
