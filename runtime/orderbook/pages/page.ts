import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import {
  PersistentRadixValueMap,
  type PersistentRadixNodeRecord,
} from '../../protocol/state/persistent-radix-value-map';
import {
  decodeBookPricePageKey,
  encodeBookPricePageKey,
  encodeBookPricePrefix,
  MAX_BOOK_PRICE_PAGE_SEQUENCE,
  type BookPricePageKey,
} from './key';

export const BOOK_PRICE_PAGE_CAPACITY = 16;
const MAX_BOOK_PAGE_ORDER_ID_BYTES = 323;
const MAX_BOOK_PAGE_OWNER_ID_BYTES = 66;
export const MAX_BOOK_PAGE_QTY_LOTS = 10n ** 24n;

export type BookPricePageEntry = Readonly<{
  orderId: string;
  ownerId: string;
  qtyLots: bigint;
  seq: number;
}>;

export type BookPricePage = Readonly<{
  headSlot: number;
  nextSlot: number;
  liveCount: number;
  totalQtyLots: bigint;
  slots: readonly (BookPricePageEntry | null)[];
}>;

export type BookPricePageTree = PersistentRadixValueMap<BookPricePageKey, BookPricePage>;

export type BookPricePageLocation = Readonly<{
  key: BookPricePageKey;
  slot: number;
}>;

const UTF8 = new TextEncoder();

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const uint16 = (value: number): Uint8Array => Uint8Array.of(value >>> 8, value);

const framed = (bytes: Uint8Array): Uint8Array => concat([uint16(bytes.byteLength), bytes]);

const positiveBigint = (value: bigint): Uint8Array => {
  const hex = value.toString(16);
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  return Uint8Array.from(normalized.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? []);
};

const entryBytes = (entry: BookPricePageEntry | null): Uint8Array => entry === null
  ? Uint8Array.of(0)
  : concat([
      Uint8Array.of(1),
      framed(UTF8.encode(entry.orderId)),
      framed(UTF8.encode(entry.ownerId)),
      framed(positiveBigint(entry.qtyLots)),
      framed(positiveBigint(BigInt(entry.seq))),
    ]);

const pageHash = (page: BookPricePage): string => {
  return computeIntegrityDigest(concat([
    uint16(page.headSlot),
    uint16(page.nextSlot),
    uint16(page.liveCount),
    framed(positiveBigint(page.totalQtyLots)),
    ...page.slots.map(entryBytes),
  ]));
};

const sealEntry = (entry: BookPricePageEntry): BookPricePageEntry => Object.freeze({ ...entry });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireExactKeys = (record: Record<string, unknown>, keys: readonly string[], code: string): void => {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const decodePageEntry = (value: unknown, slot: number): BookPricePageEntry | null => {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`BOOK_PAGE_ENTRY_INVALID:${slot}`);
  requireExactKeys(value, ['orderId', 'ownerId', 'qtyLots', 'seq'], `BOOK_PAGE_ENTRY_${slot}`);
  const orderId = value['orderId'];
  const ownerId = value['ownerId'];
  const qtyLots = value['qtyLots'];
  const seq = value['seq'];
  if (
    typeof orderId !== 'string' || typeof ownerId !== 'string' ||
    typeof qtyLots !== 'bigint' || !Number.isSafeInteger(seq)
  ) {
    throw new Error(`BOOK_PAGE_ENTRY_TYPE_INVALID:${slot}`);
  }
  const entry = { orderId, ownerId, qtyLots, seq: Number(seq) };
  requireEntry(entry);
  return entry;
};

const decodePageInteger = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > BOOK_PRICE_PAGE_CAPACITY) {
    throw new Error(code);
  }
  return Number(value);
};

const validatePageAggregate = (page: BookPricePage): void => {
  const live = page.slots.filter(entry => entry !== null);
  const total = live.reduce((sum, entry) => sum + entry.qtyLots, 0n);
  const first = page.slots.findIndex(entry => entry !== null);
  if (
    page.liveCount === 0 || page.liveCount !== live.length ||
    page.totalQtyLots !== total || first !== page.headSlot ||
    page.nextSlot <= page.headSlot ||
    page.slots.slice(page.nextSlot).some(entry => entry !== null)
  ) throw new Error('BOOK_PAGE_AGGREGATE_INVALID');
  const ids = new Set(live.map(entry => entry.orderId));
  if (ids.size !== live.length) throw new Error('BOOK_PAGE_DUPLICATE_ORDER_ID');
};

export const decodeBookPricePage = (value: unknown): BookPricePage => {
  if (!isRecord(value)) throw new Error('BOOK_PAGE_INVALID');
  requireExactKeys(value, ['headSlot', 'nextSlot', 'liveCount', 'totalQtyLots', 'slots'], 'BOOK_PAGE');
  if (!Array.isArray(value['slots']) || value['slots'].length !== BOOK_PRICE_PAGE_CAPACITY) {
    throw new Error('BOOK_PAGE_SLOTS_INVALID');
  }
  const page: BookPricePage = {
    headSlot: decodePageInteger(value['headSlot'], 'BOOK_PAGE_HEAD_INVALID'),
    nextSlot: decodePageInteger(value['nextSlot'], 'BOOK_PAGE_NEXT_INVALID'),
    liveCount: decodePageInteger(value['liveCount'], 'BOOK_PAGE_LIVE_INVALID'),
    totalQtyLots: typeof value['totalQtyLots'] === 'bigint'
      ? value['totalQtyLots']
      : (() => { throw new Error('BOOK_PAGE_TOTAL_INVALID'); })(),
    slots: value['slots'].map(decodePageEntry),
  };
  validatePageAggregate(page);
  return page;
};

const sealPage = (page: BookPricePage): BookPricePage => {
  const decoded = decodeBookPricePage(page);
  return Object.freeze({
    ...decoded,
    slots: Object.freeze(decoded.slots.map(entry => entry === null ? null : sealEntry(entry))),
  });
};

/** One options identity is shared by creation, hydration and path-copy diffs. */
const BOOK_PRICE_PAGE_MAP_OPTIONS = Object.freeze({
  radix: 16 as const,
  sealKey: (key: BookPricePageKey): BookPricePageKey => Object.freeze({ ...key }),
  keyBytes: encodeBookPricePageKey,
  valueHash: pageHash,
  sealValue: sealPage,
});

const emptyPage = (): BookPricePage => ({
  headSlot: 0,
  nextSlot: 0,
  liveCount: 0,
  totalQtyLots: 0n,
  slots: Array<BookPricePageEntry | null>(BOOK_PRICE_PAGE_CAPACITY).fill(null),
});

export const createBookPricePageTree = (): BookPricePageTree =>
  PersistentRadixValueMap.empty(BOOK_PRICE_PAGE_MAP_OPTIONS);

/** Cold storage hydration relinks persisted Patricia nodes without rebuilding from a flat Map. */
export const hydrateBookPricePageTree = (
  records: Iterable<PersistentRadixNodeRecord<BookPricePageKey, BookPricePage>>,
): BookPricePageTree => PersistentRadixValueMap.fromNodeRecords(records, BOOK_PRICE_PAGE_MAP_OPTIONS);

const pageKeyHex = (key: BookPricePageKey): string =>
  `0x${Array.from(encodeBookPricePageKey(key), byte => byte.toString(16).padStart(2, '0')).join('')}`;

/** Disk/network projection. Values remain bounded independently to <10 KiB. */
export const projectBookPricePageTree = (
  tree: BookPricePageTree,
): ReadonlyMap<string, BookPricePage> => new Map(
  Array.from(tree.entries(), ([key, page]) => [pageKeyHex(key), page]),
);

/** Exact boundary reconstruction; no class/private-field bytes cross storage. */
export const decodeBookPricePageTree = (value: unknown, code: string): BookPricePageTree => {
  if (!(value instanceof Map)) throw new Error(`${code}_MAP_INVALID`);
  const entries: Array<readonly [BookPricePageKey, BookPricePage]> = [];
  for (const [rawKey, rawPage] of value.entries()) {
    if (typeof rawKey !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(rawKey)) {
      throw new Error(`${code}_KEY_INVALID`);
    }
    const bytes = Uint8Array.from(rawKey.slice(2).match(/../g)!.map(hex => Number.parseInt(hex, 16)));
    const key = decodeBookPricePageKey(bytes);
    if (pageKeyHex(key) !== rawKey) throw new Error(`${code}_KEY_NON_CANONICAL`);
    entries.push([key, decodeBookPricePage(rawPage)]);
  }
  return PersistentRadixValueMap.fromMap(entries, BOOK_PRICE_PAGE_MAP_OPTIONS);
};

const requireBoundedText = (value: string, maximum: number, code: string): void => {
  const length = UTF8.encode(value).byteLength;
  if (length === 0 || length > maximum) throw new Error(`${code}:${length}`);
};

const requireEntry = (entry: BookPricePageEntry): void => {
  requireBoundedText(entry.orderId, MAX_BOOK_PAGE_ORDER_ID_BYTES, 'BOOK_PAGE_ORDER_ID_BYTES_INVALID');
  requireBoundedText(entry.ownerId, MAX_BOOK_PAGE_OWNER_ID_BYTES, 'BOOK_PAGE_OWNER_ID_BYTES_INVALID');
  if (entry.qtyLots <= 0n || entry.qtyLots > MAX_BOOK_PAGE_QTY_LOTS) {
    throw new Error('BOOK_PAGE_ORDER_QTY_INVALID');
  }
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 0) throw new Error('BOOK_PAGE_ORDER_SEQ_INVALID');
};

const appendToPage = (
  page: BookPricePage,
  entry: BookPricePageEntry,
): Readonly<{ page: BookPricePage; slot: number }> => {
  if (page.nextSlot >= BOOK_PRICE_PAGE_CAPACITY) throw new Error('BOOK_PAGE_FULL');
  const slot = page.nextSlot;
  const slots = [...page.slots];
  slots[slot] = entry;
  return {
    slot,
    page: {
      headSlot: page.liveCount === 0 ? slot : page.headSlot,
      nextSlot: slot + 1,
      liveCount: page.liveCount + 1,
      totalQtyLots: page.totalQtyLots + entry.qtyLots,
      slots,
    },
  };
};

export const appendBookPricePageOrder = (
  tree: BookPricePageTree,
  priceTicks: bigint,
  entry: BookPricePageEntry,
): Readonly<{ tree: BookPricePageTree; location: BookPricePageLocation }> => {
  requireEntry(entry);
  const tail = tree.lastEntryWithPrefix(encodeBookPricePrefix(priceTicks));
  const sequence = tail?.[1].nextSlot === BOOK_PRICE_PAGE_CAPACITY
    ? tail[0].pageSequence + 1
    : tail?.[0].pageSequence ?? 0;
  if (sequence > MAX_BOOK_PRICE_PAGE_SEQUENCE) throw new Error('BOOK_PAGE_SEQUENCE_EXHAUSTED');
  const key = { priceTicks, pageSequence: sequence };
  const appended = appendToPage(tail?.[0].pageSequence === sequence ? tail[1] : emptyPage(), entry);
  return {
    tree: tree.updated(key, appended.page),
    location: { key, slot: appended.slot },
  };
};

const nextHead = (slots: readonly (BookPricePageEntry | null)[], start: number): number => {
  let slot = start;
  while (slot < slots.length && slots[slot] === null) slot += 1;
  return slot;
};

export const removeBookPricePageOrder = (
  tree: BookPricePageTree,
  location: BookPricePageLocation,
  orderId: string,
): BookPricePageTree => {
  const page = tree.get(location.key);
  const entry = page?.slots[location.slot];
  if (!page || !entry || entry.orderId !== orderId) throw new Error('BOOK_PAGE_LOCATION_MISMATCH');
  const slots = [...page.slots];
  slots[location.slot] = null;
  const liveCount = page.liveCount - 1;
  if (liveCount === 0) return tree.removed(location.key);
  return tree.updated(location.key, {
    ...page,
    headSlot: location.slot === page.headSlot ? nextHead(slots, location.slot + 1) : page.headSlot,
    liveCount,
    totalQtyLots: page.totalQtyLots - entry.qtyLots,
    slots,
  });
};

export const reduceBookPricePageOrder = (
  tree: BookPricePageTree,
  location: BookPricePageLocation,
  orderId: string,
  nextQtyLots: bigint,
): BookPricePageTree => {
  if (nextQtyLots <= 0n || nextQtyLots > MAX_BOOK_PAGE_QTY_LOTS) {
    throw new Error('BOOK_PAGE_ORDER_QTY_INVALID');
  }
  const page = tree.get(location.key);
  const entry = page?.slots[location.slot];
  if (!page || !entry || entry.orderId !== orderId) throw new Error('BOOK_PAGE_LOCATION_MISMATCH');
  if (nextQtyLots >= entry.qtyLots) throw new Error('BOOK_PAGE_REDUCTION_INVALID');
  const slots = [...page.slots];
  slots[location.slot] = { ...entry, qtyLots: nextQtyLots };
  return tree.updated(location.key, {
    ...page,
    totalQtyLots: page.totalQtyLots - entry.qtyLots + nextQtyLots,
    slots,
  });
};

export const getBestBookPricePage = (
  tree: BookPricePageTree,
  direction: 'lowest' | 'highest',
): readonly [BookPricePageKey, BookPricePage] | undefined => {
  const extreme = direction === 'lowest' ? tree.firstEntry() : tree.lastEntry();
  if (!extreme) return undefined;
  return tree.firstEntryWithPrefix(encodeBookPricePrefix(extreme[0].priceTicks));
};
