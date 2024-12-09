import { createHash } from 'crypto';
import MerkleTree from 'merkletreejs';
import { Buffer } from 'buffer';

// Utility functions
const generateRandomBuffer = (): Buffer => {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
};

const hashValue = (value: Buffer): Buffer => {
    return createHash('sha256').update(value).digest();
};

// Custom Implementation
class CustomMerkleTree {
    private storage: Map<string, Buffer>;
    private batchSize: number;
    private levels: Buffer[][];

    constructor(batchSize: number) {
        this.storage = new Map();
        this.batchSize = batchSize;
        this.levels = [];
    }

    private hashNodes(nodes: Buffer[]): Buffer {
        const concatenated = Buffer.concat(nodes);
        return hashValue(concatenated);
    }

    build(values: Buffer[]) {
        // Reset storage and levels
        this.storage = new Map();
        this.levels = [];

        // Store leaf nodes
        const leaves = values.map(value => {
            const hash = hashValue(value);
            this.storage.set(hash.toString('hex'), value);
            return hash;
        });
        this.levels.push(leaves);

        // Build tree levels
        let currentLevel = leaves;
        while (currentLevel.length > 1) {
            const nextLevel: Buffer[] = [];
            
            for (let i = 0; i < currentLevel.length; i += this.batchSize) {
                const batch = currentLevel.slice(i, i + this.batchSize);
                if (batch.length < this.batchSize) {
                    // Pad with the last element if batch is incomplete
                    while (batch.length < this.batchSize) {
                        batch.push(batch[batch.length - 1]);
                    }
                }
                const parent = this.hashNodes(batch);
                nextLevel.push(parent);
            }
            
            this.levels.push(nextLevel);
            currentLevel = nextLevel;
        }
    }

    getRoot(): Buffer {
        return this.levels[this.levels.length - 1][0];
    }

    getValue(hash: Buffer): Buffer | undefined {
        return this.storage.get(hash.toString('hex'));
    }
}

// Implementation using merkletreejs library
class LibMerkleTree {
    private tree: MerkleTree;
    private storage: Map<string, Buffer>;
    private batchSize: number;

    constructor(batchSize: number) {
        this.storage = new Map();
        this.batchSize = batchSize;
        this.tree = new MerkleTree([], hashValue, {
            hashLeaves: false,
            sortPairs: false,
            sortLeaves: false,
            fillDefaultHash: undefined,
            duplicateOdd: true,
        });
    }

    build(values: Buffer[]) {
        // Reset storage
        this.storage = new Map();
        
        // Store values and prepare leaves
        const leaves = values.map(value => {
            const hash = hashValue(value);
            this.storage.set(hash.toString('hex'), value);
            return hash;
        });

        // Build tree
        this.tree = new MerkleTree(leaves, hashValue, {
            hashLeaves: false,
            sortPairs: false,
            sortLeaves: false,
            fillDefaultHash: undefined,
            duplicateOdd: true,
        });
    }

    getRoot(): Buffer {
        return Buffer.from(this.tree.getRoot());
    }

    getValue(hash: Buffer): Buffer | undefined {
        return this.storage.get(hash.toString('hex'));
    }
}

// Test both implementations
async function runTest() {
    console.time('Generate Values');
    const values: Buffer[] = Array(3_000_000).fill(null).map(() => generateRandomBuffer());
    console.timeEnd('Generate Values');

    const batchSizes = [10, 16, 32];
    
    for (const batchSize of batchSizes) {
        console.log(`\nTesting with batch size: ${batchSize}`);
        
        // Test custom implementation
        console.time('Custom Implementation');
        const customTree = new CustomMerkleTree(batchSize);
        customTree.build(values);
        const customRoot = customTree.getRoot();
        console.timeEnd('Custom Implementation');
        console.log('Custom Root:', customRoot.toString('hex'));

        // Test library implementation
        console.time('Library Implementation');
        const libTree = new LibMerkleTree(batchSize);
        libTree.build(values);
        const libRoot = libTree.getRoot();
        console.timeEnd('Library Implementation');
        console.log('Library Root:', libRoot.toString('hex'));
    }
}

// Run the test
runTest().catch(console.error);