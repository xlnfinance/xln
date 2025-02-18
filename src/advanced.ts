type Path = (string | number | Buffer)[];
type Nibbles = number[];

interface StorageNode {
  value?: any;
  hash?: Buffer;
  isDirty?: boolean;
  children?: Map<string, StorageNode>;
}

class AdvancedStorage {
  private data: Map<string, any> = new Map();
  private dirtyPaths: Set<string> = new Set();
  private nodeCache: Map<string, StorageNode> = new Map();
  
  // Smart getter with path traversal and function application
  get<T>(path: Path, apply?: (value: T) => T): T | undefined {
    const key = this.pathToKey(path);
    const node = this.getNode(key);
    
    if (!node?.value) return undefined;
    return apply ? apply(node.value) : node.value;
  }

  // Setter with recursive dirty marking
  set(path: Path, value: any, options: {
    merge?: boolean;    // Merge with existing value
    silent?: boolean;   // Don't mark dirty
  } = {}): void {
    const key = this.pathToKey(path);
    const node = this.getOrCreateNode(key);
    
    if (options.merge && node.value) {
      node.value = { ...node.value, ...value };
    } else {
      node.value = value;
    }

    if (!options.silent) {
      this.markDirty(key);
    }
  }

  // Apply function to value at path
  apply<T>(path: Path, fn: (current: T) => T): void {
    const key = this.pathToKey(path);
    const node = this.getOrCreateNode(key);
    node.value = fn(node.value);
    this.markDirty(key);
  }

  // Batch operations for performance
  batch(operations: { path: Path; value: any; }[]): void {
    for (const { path, value } of operations) {
      this.set(path, value, { silent: true });
    }
    // Mark dirty once for all operations
    this.markDirtyBatch(operations.map(op => this.pathToKey(op.path)));
  }

  // Example usage for orderbook
  private orderBookExample() {
    // Update order
    this.apply(['orderbook', 'ETH-USD', 'orders', orderId], 
      (order: Order) => ({ ...order, status: 'filled' }));
    
    // Update price level atomically
    this.batch([
      { 
        path: ['orderbook', 'ETH-USD', 'asks', '1000'], 
        value: { size: '10.5', orders: 5 } 
      },
      {
        path: ['orderbook', 'ETH-USD', 'summary'],
        value: { lastPrice: '1000' }
      }
    ]);
  }

  // Efficient path handling
  private pathToKey(path: Path): string {
    return path.map(p => 
      Buffer.isBuffer(p) ? p.toString('hex') :
      typeof p === 'number' ? p.toString(16).padStart(2, '0') :
      p
    ).join(':');
  }

  private pathToNibbles(path: Path): Nibbles {
    return Buffer.from(this.pathToKey(path))
      .reduce((nibbles: number[], byte) => {
        nibbles.push((byte >> 4) & 0xf, byte & 0xf);
        return nibbles;
      }, []);
  }

  // Node management with caching
  private getNode(key: string): StorageNode | undefined {
    // Check cache first
    if (this.nodeCache.has(key)) {
      return this.nodeCache.get(key);
    }

    // Create from data if exists
    const value = this.data.get(key);
    if (value) {
      const node: StorageNode = { value };
      this.nodeCache.set(key, node);
      return node;
    }

    return undefined;
  }

  private getOrCreateNode(key: string): StorageNode {
    let node = this.getNode(key);
    if (!node) {
      node = { children: new Map() };
      this.nodeCache.set(key, node);
    }
    return node;
  }

  // Efficient dirty tracking
  private markDirty(key: string) {
    if (this.dirtyPaths.has(key)) return;
    
    this.dirtyPaths.add(key);
    // Mark parents dirty
    const parentKey = key.split(':').slice(0, -1).join(':');
    if (parentKey) this.markDirty(parentKey);
  }

  private markDirtyBatch(keys: string[]) {
    const uniqueParents = new Set<string>();
    
    for (const key of keys) {
      const parts = key.split(':');
      for (let i = parts.length - 1; i > 0; i--) {
        uniqueParents.add(parts.slice(0, i).join(':'));
      }
    }

    this.dirtyPaths = new Set([...this.dirtyPaths, ...keys, ...uniqueParents]);
  }

  // Lazy hash calculation during mempool tick
  async calculateHashes(): Promise<Buffer> {
    const dirtyNodes = Array.from(this.dirtyPaths)
      .sort((a, b) => b.length - a.length); // Bottom-up

    for (const key of dirtyNodes) {
      const node = this.getNode(key)!;
      
      // Calculate hash only for dirty nodes
      if (node.isDirty || !node.hash) {
        node.hash = await this.hashNode(node);
        node.isDirty = false;
      }
    }

    this.dirtyPaths.clear();
    return this.getNode('')!.hash!;
  }

  private async hashNode(node: StorageNode): Promise<Buffer> {
    const toHash = Buffer.concat([
      node.value ? encode(node.value) : Buffer.alloc(0),
      ...Array.from(node.children?.values() || [])
        .map(child => child.hash || Buffer.alloc(32))
    ]);
    
    return createHash('sha256').update(toHash).digest();
  }
}

// Usage example
const storage = new AdvancedStorage();

// Orderbook operations
storage.set(['orderbook', 'ETH-USD'], { bids: {}, asks: {} });
storage.apply(['orderbook', 'ETH-USD', 'bids', '1000'], 
  (level = { size: 0, orders: 0 }) => ({
    size: level.size + 1,
    orders: level.orders + 1
  })
);

// Channel operations
storage.set(['channels', channelId], { 
  balance: 100n,
  nonce: 0
});

// Calculate hashes during mempool tick
await storage.calculateHashes();