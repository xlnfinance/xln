import { encode, decode } from 'cbor';
const ZERO = Buffer.alloc(32);

import * as repl from 'repl';

const crypto = require("crypto");



const dag = new Map<Buffer, any>();
const overlay = new Map<Buffer, any>();

let context: Context = {
  dag: dag,
  overlay: overlay
};

function hash(inputBuffer: Buffer) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError("Input must be a Buffer");
  }

  // Compute the Keccak256 hash
  const hashBuffer = crypto.createHash("sha3-256").update(inputBuffer).digest();
  return hashBuffer;
}



// Message System
interface Message {
  path: string[];
  type: string;
  data: any;
}
  

interface BlockHeader {
  signatureHash: Buffer;

  prev: Buffer;

  inbox: Message[];
  state: Buffer;

  inboxMap: Map<string, Message[]>;
  subroots: Buffer;
}



interface Context {
  dag: Map<Buffer, Buffer>;
  overlay: Map<Buffer, Buffer>;
}

// Serialization helpers
function serializeMap<K, V>(map: Map<K, V>): [K, V][] {
    return Array.from(map.entries());
}

function deserializeMap<K, V>(entries: [K, V][]): Map<K, V> {
    return new Map(entries);
}



// Core functions
function createInitialState(): any {
  return {
    headHash: Buffer.alloc(32),
    counter: 0,
    minBlockTime: 1000,  // 1 second
    maxBlockTime: 5000,  // 5 seconds

    blockLimit: 1024 * 1024, // 1MB
    mempool: new Map(),
    children: new Map(),
    
    rollbacks: 0,
    sentTransitions: 0,
    pendingBlock: null,
    pendingSignatures: [],

    sendCounter: 0,
    receiveCounter: 0
  
  };
}

 
 
 


function apply(context: Context, message: Message) {
  if (message.path.length === 0) {
    const newNode = createInitialState();

    context.overlay.set(ZERO, newNode);
  }



  

}



async function main() { 
  let server = repl.start({
    prompt: 'xln> ',
    useColors: true,
    ignoreUndefined: true
  })

  Object.assign(server.context, {
    dag,
    ZERO,
    hash,
    encode,
    decode,
    apply,
    createInitialState,
    serializeMap,
    deserializeMap,
    context
  })

}

main().catch(console.error);