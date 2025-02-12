import { encode, decode } from 'cbor';

import * as repl from 'repl';

import crypto from 'crypto';
import { Level } from 'level';
import rlp from 'rlp';


const env = {
  stateDB: new Level<Buffer, Buffer>('./db', { keyEncoding: 'buffer', valueEncoding: 'buffer' }),
  logDB: new Level<Buffer, Buffer>('./log', { keyEncoding: 'buffer', valueEncoding: 'buffer' }),

  map: new Map<Buffer, any>(),
  unsavedSet: new Set<Buffer>(),

  root: Buffer.alloc(0),

  
}




// Utility function to calculate hash of data
function hash(data: Buffer): Buffer {
    return crypto.createHash('sha256').update(data).digest();
}

// Preload entire DAG into memory
async function preloadDAG() {
    for await (const [key, value] of db.iterator()) {
        env.map.set(Buffer.from(key), Buffer.from(value));
    }
    console.log(`Preloaded ${inMemoryDAG.size} nodes into memory.`);
}

// Function to update in-memory DAG and accumulate changes
function updateDAG(data: Buffer): Buffer {
    const newHash = hash(data);
    inMemoryDAG.set(newHash, data);
    overlayChanges.set(newHash, data);
    rootHash = newHash; // Update the root to the latest state
    return newHash;
}

// Periodic flushing of overlay changes to LevelDB
async function flushToDisk() {
    if (overlayChanges.size === 0) return;

    const batch = db.batch();
    for (const [key, value] of overlayChanges) {
        batch.put(key, value);
    }
    await batch.write();
    console.log(`Flushed ${overlayChanges.size} changes to disk.`);
    overlayChanges.clear();
}

// Simulate updates to the DAG
async function simulateUpdates() {
    for (let i = 0; i < 5; i++) {
        const data = Buffer.from(`data-${Date.now()}`);
        const newHash = updateDAG(data);
        console.log(`Updated DAG with new node: ${newHash.toString('hex')}`);
        await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate processing delay
    }
}
// Benchmark DAG read/write performance with large data chunks
async function benchmarkDAG(iterations: number = 100_000) {
    console.log(`Starting benchmark with ${iterations} iterations...`);
    console.log('Each operation writes/reads 10KB of data');
    
    // Create initial random data (10KB)
    let currentData = crypto.randomBytes(10000);
    let totalStorageUsed = 0;
    
    const startTime = process.hrtime.bigint();
    let lastLogTime = startTime;
    let writeTimeTotal = BigInt(0);
    let readTimeTotal = BigInt(0);
    
    for (let i = 0; i < iterations; i++) {
        // Generate unique key for each write
        const key = Buffer.concat([
            Buffer.from(i.toString().padStart(20, '0')),
            hash(currentData)
        ]);

        // Write operation
        const writeStart = process.hrtime.bigint();
        await db.put(key, currentData);
        const writeEnd = process.hrtime.bigint();
        writeTimeTotal += writeEnd - writeStart;

        // Read operation
        const readStart = process.hrtime.bigint();
        const readValue = await db.get(key);
        const readEnd = process.hrtime.bigint();
        readTimeTotal += readEnd - readStart;

        // Generate new data by combining previous data with its hash
        currentData = Buffer.concat([
            hash(Buffer.from(readValue)),
            crypto.randomBytes(9968)  // Add random data to maintain 10KB size (10000 - 32 bytes from hash)
        ]);

        totalStorageUsed += currentData.length;

        // Log progress every 10,000 operations
        if (i > 0 && i % 10_000 === 0) {
            const currentTime = process.hrtime.bigint();
            const elapsedMs = Number(currentTime - lastLogTime) / iterations;
            const opsPerSec = Math.round((10_000 / elapsedMs) * 1000);
            const storageGB = totalStorageUsed / (1024 * 1024 * 1024);
            
            console.log(`Completed ${i.toLocaleString()} operations`);
            console.log(`Current throughput: ${opsPerSec.toLocaleString()} ops/sec`);
            console.log(`Avg write time: ${Number(writeTimeTotal / BigInt(i)) / iterations}ms`);
            console.log(`Avg read time: ${Number(readTimeTotal / BigInt(i)) / iterations}ms`);
            console.log(`Total storage used: ${storageGB.toFixed(2)}GB\n`);
            
            lastLogTime = currentTime;
        }
    }

    const endTime = process.hrtime.bigint();
    const totalTimeMs = Number(endTime - startTime) / iterations;
    const finalStorageGB = totalStorageUsed / (1024 * 1024 * 1024);
    
    console.log('\nBenchmark Complete:');
    console.log(`Total time: ${totalTimeMs.toFixed(2)}ms`);
    console.log(`Average write time: ${Number(writeTimeTotal / BigInt(iterations)) / iterations}ms`);
    console.log(`Average read time: ${Number(readTimeTotal / BigInt(iterations)) / iterations}ms`);
    console.log(`Overall throughput: ${Math.round((iterations / totalTimeMs) * 1000)} ops/sec`);
    console.log(`Final storage size: ${finalStorageGB.toFixed(2)}GB`);
}


// Main function
async function main() {
    await preloadDAG();

    // Periodically flush changes to disk every second
    //setInterval(flushToDisk, 1000);

    // Simulate updates to the DAG
    //await simulateUpdates();
    benchmarkDAG(100000);
    // Wait a bit for final flush
    //setTimeout(() => {
        //console.log('Final root hash:', rootHash?.toString('hex'));
        //process.exit(0);
    //}, 2000);
}

main().catch((err) => {
  let replServer = repl.start({
    prompt: '> ',
    useColors: true,
    ignoreUndefined: true
  })

  Object.assign(replServer.context, env)

  console.error('Error:', err);
  process.exit(1);
});

/*
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
*/