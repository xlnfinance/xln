// Two-tier orderId -> orderIndex mapping:
// 1) Dense Int32 array for small ids  [0 .. DENSE_LIMIT-1]
// 2) Sparse hash map for large ids (our U32I32Map)
import { createU32I32Map } from "./fast_u32_map";
const DENSE_LIMIT = 1 << 20; // 1,048,576 (tune as you like)
const dense = new Int32Array(DENSE_LIMIT).fill(-1);
const sparse = createU32I32Map(1 << 20);
export function idGet(id) {
    id = id >>> 0;
    return (id < DENSE_LIMIT) ? dense[id] : sparse.get(id);
}
export function idSet(id, idx) {
    id = id >>> 0;
    if (id < DENSE_LIMIT)
        dense[id] = idx | 0;
    else
        sparse.set(id, idx | 0);
}
export function idDel(id) {
    id = id >>> 0;
    if (id < DENSE_LIMIT)
        dense[id] = -1;
    else
        sparse.del(id);
}
export function idHas(id) { return idGet(id) !== -1; }
export function idClear() { dense.fill(-1); sparse.clear(); }
