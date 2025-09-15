// Ultra-fast u32 -> i32 hash map (open addressing, linear probing, tombstones).
// No objects, just TypedArrays. Designed for hot lookups (orderId -> orderIndex).

export interface U32I32Map {
    get(id: number): number;            // -1 if not found
    set(id: number, idx: number): void; // insert or overwrite
    del(id: number): boolean;           // true if removed
    has(id: number): boolean;
    size(): number;
    clear(): void;
  }
  
  function mix32(x: number): number {
    // cheap avalanche (murmur-ish). Works on unsigned 32-bit domain.
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return x ^ (x >>> 16);
  }
  
  export function createU32I32Map(initialCapacityPow2 = 1 << 20): U32I32Map {
    let cap = 1;
    while (cap < initialCapacityPow2) cap <<= 1;
    let mask = cap - 1;
  
    let keys = new Uint32Array(cap);
    let vals = new Int32Array(cap);
    let state = new Uint8Array(cap); // 0=empty, 1=filled, 2=tombstone
  
    let _size = 0;
    let _tombs = 0;
    const MAX_LOAD = 0.75;
  
    function rehash(nextCap: number) {
      nextCap = 1 << Math.ceil(Math.log2(nextCap | 0));
      const nkeys = new Uint32Array(nextCap);
      const nvals = new Int32Array(nextCap);
      const nstate = new Uint8Array(nextCap);
      const nmask = nextCap - 1;
  
      for (let i = 0; i < cap; i++) {
        if (state[i] === 1) {
          const k = keys[i];
          let j = mix32(k) & nmask;
          while (nstate[j] === 1) j = (j + 1) & nmask;
          nstate[j] = 1;
          nkeys[j] = k;
          nvals[j] = vals[i];
        }
      }
      keys = nkeys; vals = nvals; state = nstate;
      cap = nextCap; mask = nmask;
      _tombs = 0;
    }
  
    function maybeGrow() {
      if ((_size + _tombs) / cap > MAX_LOAD) rehash(cap << 1);
    }
  
    function findSlot(k: number): number {
      let j = mix32(k) & mask;
      let firstTomb = -1;
      while (true) {
        const st = state[j];
        if (st === 0) return (firstTomb >= 0) ? firstTomb : j;
        if (st === 1 && keys[j] === k) return j;
        if (st === 2 && firstTomb < 0) firstTomb = j;
        j = (j + 1) & mask;
      }
    }
  
    return {
      get(id: number): number {
        id = id >>> 0;
        if (id === 0) return -1;
        let j = mix32(id) & mask;
        while (true) {
          const st = state[j];
          if (st === 0) return -1;
          if (st === 1 && keys[j] === id) return vals[j];
          j = (j + 1) & mask;
        }
      },
      has(id: number): boolean { return this.get(id) !== -1; },
      set(id: number, idx: number): void {
        id = id >>> 0;
        if (id === 0) throw new Error("orderId 0 is reserved");
        maybeGrow();
        const j = findSlot(id);
        if (state[j] === 1) {
          vals[j] = idx | 0;
        } else {
          state[j] = 1;
          keys[j] = id;
          vals[j] = idx | 0;
          _size++;
        }
      },
      del(id: number): boolean {
        id = id >>> 0;
        if (id === 0) return false;
        let j = mix32(id) & mask;
        while (true) {
          const st = state[j];
          if (st === 0) return false;
          if (st === 1 && keys[j] === id) {
            state[j] = 2;
            _size--; _tombs++;
            if (_tombs > (cap >> 2)) rehash(cap); // soft cleanup
            return true;
          }
          j = (j + 1) & mask;
        }
      },
      size(): number { return _size; },
      clear(): void { keys.fill(0); vals.fill(0); state.fill(0); _size = 0; _tombs = 0; },
    };
  }