
// Entity inputs
type EntityInput =
  | { type: 'AddEntityTx', tx: Buffer }
  | { type: 'AddChannelInput', channelId: string, input: ChannelInput }
  | { type: 'Flush' }
  | { type: 'Sync', blocks: Buffer[], signature: Buffer }
  | { type: 'Consensus', 
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      proposerSig?: Buffer 
    }

// Channel inputs
type ChannelInput = 
  | { type: 'AddChannelTx', tx: Buffer }
  | { type: 'Consensus',
      signature: Buffer,
      blockNumber: number,
      consensusBlock?: Buffer,
      counterpartySig?: Buffer
    }

// Block structures
type EntityBlock = {
  blockNumber: number
  stateRoot: Buffer           // Entity state hash
  channelRoot: Buffer         // Hash of channelMap
  channelMap: Map<string, Buffer>  // counterpartyId -> channelHash
  inbox: Buffer[]             // Both entityTx and channelInputs
  validatorSet?: Buffer[]     // Optional validator set update
}

// Root states
type EntityRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: EntityBlock
  consensusBlock?: EntityBlock
  mempool: Map<string, Buffer>  // txHash -> tx (both entity and channel)
  nonce?: number
}

type ChannelRoot = {
  status: 'idle' | 'precommit' | 'commit'
  finalBlock?: Buffer
  consensusBlock?: Buffer
  mempool: Map<string, Buffer>  // txHash -> channelTx
}


// Export everything at once
export type {
    EntityInput,
    ChannelInput,
    EntityBlock,
    EntityRoot,
    ChannelRoot
    }