import { encode, decode } from 'cbor';
import { keccak256 } from 'js-sha3';

// Message System
interface BaseMessage {
    path: string[];
    type: string;
    timestamp: number;
}

interface StateUpdateMessage extends BaseMessage {
    type: 'STATE_UPDATE';
    payload: {
        counter?: number;
        data?: any;
    };
}

interface ConfigUpdateMessage extends BaseMessage {
    type: 'CONFIG_UPDATE';
    payload: {
        minBlockTime?: number;
        maxBlockTime?: number;
        blockLimit?: number;
    };
}

type Message = StateUpdateMessage | ConfigUpdateMessage;

// Core Types
interface StateData {
    counter: number;
    blockTimeConfig: {
        minBlockTime: number;
        maxBlockTime: number;
    };
    blockLimit: number;
    mempool: Map<string, Message[]>;
    children: Map<string, Buffer>;
    data: any;
}

interface BlockHeader {
    prevHash: Buffer;
    timestamp: number;
    inbox: Map<string, Message[]>;
    signatureHash: Buffer;
    stateHash: Buffer;
    childrenStateHash: Buffer;
}

interface State {
    headHash: Buffer;
    data: StateData;
}

interface Context {
    dag: Map<Buffer, Buffer>;
}

// Serialization helpers
function serializeMap<K, V>(map: Map<K, V>): [K, V][] {
    return Array.from(map.entries());
}

function deserializeMap<K, V>(entries: [K, V][]): Map<K, V> {
    return new Map(entries);
}

function serializeState(state: State): Buffer {
    const serializable = {
        headHash: state.headHash,
        data: {
            ...state.data,
            mempool: serializeMap(state.data.mempool),
            children: serializeMap(state.data.children),
        },
    };
    return encode(serializable);
}

function deserializeState(buffer: Buffer): State {
    const data = decode(buffer);
    return {
        headHash: data.headHash,
        data: {
            ...data.data,
            mempool: deserializeMap(data.data.mempool),
            children: deserializeMap(data.data.children),
        },
    };
}

// Core functions
function createInitialState(): State {
    return {
        headHash: Buffer.alloc(32),
        data: {
            counter: 0,
            blockTimeConfig: {
                minBlockTime: 1000,  // 1 second
                maxBlockTime: 5000,  // 5 seconds
            },
            blockLimit: 1024 * 1024, // 1MB
            mempool: new Map(),
            children: new Map(),
            data: {},
        },
    };
}

function receive(context: Context, message: Message): Context {
    const rootState = getState(context, []);
    const newContext = forwardMessage(context, message, [], rootState);
    return processBlock(newContext, Buffer.alloc(32));
}

function createBlock(context: Context, address: Buffer): Context {
    const state = getState(context, [address.toString('hex')]);
    const newState = {
        ...state,
        headHash: calculateStateHash(state.data),
    };

    const blockHeader: BlockHeader = {
        prevHash: state.headHash,
        timestamp: Date.now(),
        inbox: state.data.mempool,
        signatureHash: Buffer.alloc(32), // In practice, would be actual signature
        stateHash: newState.headHash,
        childrenStateHash: calculateChildrenHash(state.data.children),
    };

    // Clear mempool after block creation
    newState.data.mempool = new Map();

    const newContext = { ...context };
    newContext.dag.set(newState.headHash, serializeState(newState));
    newContext.dag.set(
        calculateBlockHash(blockHeader),
        encode(blockHeader)
    );

    return newContext;
}

function getState(context: Context, path: string[]): State {
    if (path.length === 0) {
        const rootHash = Buffer.alloc(32);
        const serializedState = context.dag.get(rootHash);
        return serializedState ? deserializeState(serializedState) : createInitialState();
    }

    // Traverse path to find state
    let currentState = getState(context, path.slice(0, -1));
    const childHash = currentState.data.children.get(path[path.length - 1]);
    
    if (!childHash) {
        return createInitialState();
    }

    const serializedState = context.dag.get(childHash);
    return serializedState ? deserializeState(serializedState) : createInitialState();
}

// Internal utilities
function updateState(state: State, message: Message): State {
    const newState = { ...state };

    switch (message.type) {
        case 'STATE_UPDATE':
            if (message.payload.counter !== undefined) {
                newState.data.counter = message.payload.counter;
            }
            if (message.payload.data !== undefined) {
                newState.data.data = message.payload.data;
            }
            break;

        case 'CONFIG_UPDATE':
            if (message.payload.minBlockTime !== undefined) {
                newState.data.blockTimeConfig.minBlockTime = message.payload.minBlockTime;
            }
            if (message.payload.maxBlockTime !== undefined) {
                newState.data.blockTimeConfig.maxBlockTime = message.payload.maxBlockTime;
            }
            if (message.payload.blockLimit !== undefined) {
                newState.data.blockLimit = message.payload.blockLimit;
            }
            break;
    }

    return newState;
}

function forwardMessage(
    context: Context,
    message: Message,
    currentPath: string[],
    currentState: State
): Context {
    // Add message to current mempool
    const mempoolKey = message.path.slice(currentPath.length + 1).join('/');
    const currentMempool = currentState.data.mempool.get(mempoolKey) || [];
    currentState.data.mempool.set(mempoolKey, [...currentMempool, message]);

    // Update context with new state
    const newContext = { ...context };
    newContext.dag.set(currentState.headHash, serializeState(currentState));

    // If we've reached the destination, update the state
    if (currentPath.length === message.path.length) {
        const updatedState = updateState(currentState, message);
        newContext.dag.set(updatedState.headHash, serializeState(updatedState));
        return newContext;
    }

    // Otherwise, forward to next level
    const nextPath = message.path[currentPath.length];
    const childState = getState(context, [...currentPath, nextPath]);
    return forwardMessage(newContext, message, [...currentPath, nextPath], childState);
}

function calculateStateHash(state: StateData): Buffer {
    return Buffer.from(keccak256(encode(state)), 'hex');
}

function calculateChildrenHash(children: Map<string, Buffer>): Buffer {
    return Buffer.from(keccak256(encode(serializeMap(children))), 'hex');
}

function calculateBlockHash(header: BlockHeader): Buffer {
    return Buffer.from(keccak256(encode(header)), 'hex');
}

function processBlock(context: Context, address: Buffer): Context {
    const state = getState(context, [address.toString('hex')]);
    const now = Date.now();
    const lastBlockTime = state.data.blockTimeConfig.minBlockTime;

    if (
        state.data.mempool.size > 0 &&
        now >= lastBlockTime + state.data.blockTimeConfig.minBlockTime
    ) {
        return createBlock(context, address);
    }

    return context;
}

export {
    Message,
    State,
    Context,
    receive,
    getState,
    createInitialState,
};

import { ethers, keccak256 as hash } from 'ethers';
const dag = new Map<Buffer, any>();
const ZERO = Buffer.alloc(32, 0);

import * as repl from 'repl';


async function main() {
  /*const env = new Environment({ wsPort: 10010 });

  const alice = env.addUser('alice', 'password1');
  const bob = env.addUser('bob', 'password2');

  const aliceEntity = alice.entity;
  const bobEntity = bob.entity;

  const aliceBobChannel = aliceEntity.addChannel(bob.address);
  const bobAliceChannel = bobEntity.addChannel(alice.address);

  // Setup channels and perform operations using the new structure

  // Set Alice's entity as a hub
  aliceEntity.setAsHub(true);

  // Perform other operations...*/
  let server = repl.start({
    prompt: 'xln> ',
    useColors: true,
    ignoreUndefined: true
  })
  Object.assign(server.context, {
    dag,
    ZERO,
    hash
  })

}

main().catch(console.error);