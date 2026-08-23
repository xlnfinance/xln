/**
 * Durable Runtime outputs are immutable content-addressed records. A WAL frame
 * commits only their ordered hashes, so retries survive crashes without copying
 * large consensus envelopes into every frame. The frame batch writes new
 * payloads before publishing HEAD; hash verification makes exact reuse safe.
 */
import type { RoutedEntityInput } from '../../runtime/types';
import { decodeRoutedEntityInput } from '../../runtime/delivery/topology/routing-validation';
import { validateEntityTx } from '../../entity/tx-validation';
import type { EntityTx } from '../../types/entity-tx';
import { decodeAccountTx } from '../../account/tx-validation';
import type { AccountTx } from '../../types/account';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import {
  toRuntimeOutputPayloadHash,
  type RuntimeOutputPayloadHash,
} from '../../protocol/hashes';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { keyRuntimeOutputPayload } from '../keys';
import type {
  RuntimeDbLike,
} from '../types';

export const MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES = 10_000;

export type RuntimeOutputPayloadRow = Readonly<{
  hash: RuntimeOutputPayloadHash;
  key: Buffer;
  value: Buffer;
}>;

const hashPayload = (value: Uint8Array): RuntimeOutputPayloadHash =>
  toRuntimeOutputPayloadHash(computeIntegrityDigest(value).toLowerCase());

type StoredOutputManifest = Readonly<{
  kind: 'output';
  version: 1;
  header: Record<string, unknown>;
  hasEntityTxs: boolean;
  entityTxPageRefs: RuntimeOutputPayloadHash[];
}>;

type StoredEntityTx = Readonly<{
  kind: 'entityTx';
  version: 1;
  entityTxPath: NestedEntityTxPath;
  accountTxPath: NestedAccountTxPath;
  header: Record<string, unknown>;
  entityTxPageRefs: RuntimeOutputPayloadHash[];
  accountTxPageRefs: RuntimeOutputPayloadHash[];
}>;

type StoredAccountTx = Readonly<{
  kind: 'accountTx';
  version: 1;
  tx: AccountTx;
}>;

type StoredReferencePage = Readonly<{
  kind: 'referencePage';
  version: 1;
  childKind: 'entityTx' | 'accountTx';
  refs: RuntimeOutputPayloadHash[];
}>;

const REFERENCE_PAGE_SIZE = 64;

type NestedEntityTxPath =
  | 'none'
  | 'data.entityTxs'
  | 'data.txs'
  | 'data.action.data.txs';

type NestedAccountTxPath =
  | 'none'
  | 'data.proposal.frame.accountTxs';

type SplitEntityTx = Readonly<{
  entityTxPath: NestedEntityTxPath;
  accountTxPath: NestedAccountTxPath;
  header: Record<string, unknown>;
  entityTxs: EntityTx[];
  accountTxs: AccountTx[];
}>;

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const payloadBudgetLabel = (
  payload: StoredOutputManifest | StoredEntityTx | StoredAccountTx | StoredReferencePage,
): string => {
  if (payload.kind === 'output') {
    return `output:entityTxPages=${payload.entityTxPageRefs.length}:headerKeys=${Object.keys(payload.header).sort().join(',')}`;
  }
  if (payload.kind === 'accountTx') return `accountTx:type=${payload.tx.type}`;
  if (payload.kind === 'referencePage') {
    return `referencePage:childKind=${payload.childKind}:refs=${payload.refs.length}`;
  }
  const type = typeof payload.header['type'] === 'string' ? payload.header['type'] : 'unknown';
  return `entityTx:type=${type}:entityPath=${payload.entityTxPath}:` +
    `accountPath=${payload.accountTxPath}:entityPages=${payload.entityTxPageRefs.length}:` +
    `accountPages=${payload.accountTxPageRefs.length}`;
};

const prepareRow = (
  payload: StoredOutputManifest | StoredEntityTx | StoredAccountTx | StoredReferencePage,
): RuntimeOutputPayloadRow => {
  let value: Buffer;
  try {
    value = encodeBuffer(payload, { omitSymbolKeys: true });
  } catch (error) {
    throw new Error(
      `STORAGE_RUNTIME_OUTPUT_PAYLOAD_ENCODE_FAILED:${payloadBudgetLabel(payload)}:` +
      `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (value.byteLength >= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES) {
    throw new Error(
      `STORAGE_RUNTIME_OUTPUT_PAYLOAD_TOO_LARGE:${value.byteLength}:` +
      `max=${MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES}:${payloadBudgetLabel(payload)}`,
    );
  }
  const hash = hashPayload(value);
  return { hash, key: keyRuntimeOutputPayload(hash), value };
};

const prepareReferencePages = (
  refs: readonly RuntimeOutputPayloadHash[],
  childKind: StoredReferencePage['childKind'],
  rowsByHash: Map<RuntimeOutputPayloadHash, RuntimeOutputPayloadRow>,
): RuntimeOutputPayloadHash[] => {
  const pageRefs: RuntimeOutputPayloadHash[] = [];
  for (let offset = 0; offset < refs.length; offset += REFERENCE_PAGE_SIZE) {
    const row = prepareRow({
      kind: 'referencePage',
      version: 1,
      childKind,
      refs: refs.slice(offset, offset + REFERENCE_PAGE_SIZE),
    });
    rowsByHash.set(row.hash, row);
    pageRefs.push(row.hash);
  }
  return pageRefs;
};

const splitEntityTx = (tx: EntityTx): SplitEntityTx => {
  if (tx.type === 'consensusOutput' || tx.type === 'runtimeOutput' || tx.type === 'reissueCertifiedOutput') {
    const { entityTxs, ...data } = tx.data;
    return {
      entityTxPath: 'data.entityTxs', accountTxPath: 'none',
      header: { ...tx, data }, entityTxs, accountTxs: [],
    };
  }
  if (tx.type === 'entityCommand') {
    const { txs, ...data } = tx.data;
    return {
      entityTxPath: 'data.txs', accountTxPath: 'none',
      header: { ...tx, data }, entityTxs: txs, accountTxs: [],
    };
  }
  if (tx.type === 'propose' && tx.data.action.type === 'entity_transaction') {
    const { txs, ...actionData } = tx.data.action.data;
    return {
      entityTxPath: 'data.action.data.txs',
      accountTxPath: 'none',
      header: {
        ...tx,
        data: {
          ...tx.data,
          action: { ...tx.data.action, data: actionData },
        },
      },
      entityTxs: txs,
      accountTxs: [],
    };
  }
  if (tx.type === 'accountInput'
    && (tx.data.kind === 'frame' || tx.data.kind === 'frame_ack')) {
    const { accountTxs, ...frame } = tx.data.proposal.frame;
    return {
      entityTxPath: 'none',
      accountTxPath: 'data.proposal.frame.accountTxs',
      header: {
        ...tx,
        data: { ...tx.data, proposal: { ...tx.data.proposal, frame } },
      },
      entityTxs: [],
      accountTxs,
    };
  }
  return {
    entityTxPath: 'none', accountTxPath: 'none', header: tx,
    entityTxs: [], accountTxs: [],
  };
};

const prepareAccountTxRow = (
  tx: AccountTx,
  rowsByHash: Map<RuntimeOutputPayloadHash, RuntimeOutputPayloadRow>,
): RuntimeOutputPayloadHash => {
  const row = prepareRow({ kind: 'accountTx', version: 1, tx });
  rowsByHash.set(row.hash, row);
  return row.hash;
};

// Splitting an Account frame into header + per-tx rows keeps every row under
// the bound and lets resent frames share tx rows. A small frame (one or two
// HTLC legs, the bulk of Hub traffic) fits one row; five content-addressed
// rows per output was most of the outbox encode cost.
const WHOLE_ROW_MAX_BYTES = Math.floor(MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES / 2);

const prepareEntityTxRow = (
  tx: EntityTx,
  rowsByHash: Map<RuntimeOutputPayloadHash, RuntimeOutputPayloadRow>,
  depth = 0,
): RuntimeOutputPayloadHash => {
  if (depth > 16) throw new Error('STORAGE_RUNTIME_OUTPUT_TX_NESTING_LIMIT');
  if (
    tx.type === 'accountInput'
    && (tx.data.kind === 'frame' || tx.data.kind === 'frame_ack')
    && tx.data.proposal.frame.accountTxs.length <= 2
  ) {
    const whole = encodeBuffer({
      kind: 'entityTx', version: 1, entityTxPath: 'none', accountTxPath: 'none',
      header: tx, entityTxPageRefs: [], accountTxPageRefs: [],
    } satisfies StoredEntityTx, { omitSymbolKeys: true });
    if (whole.byteLength < WHOLE_ROW_MAX_BYTES) {
      const hash = hashPayload(whole);
      rowsByHash.set(hash, { hash, key: keyRuntimeOutputPayload(hash), value: whole });
      return hash;
    }
  }
  const split = splitEntityTx(tx);
  const entityTxRefs = split.entityTxs.map(child =>
    prepareEntityTxRow(child, rowsByHash, depth + 1));
  const accountTxRefs = split.accountTxs.map(child =>
    prepareAccountTxRow(child, rowsByHash));
  const row = prepareRow({
    kind: 'entityTx',
    version: 1,
    entityTxPath: split.entityTxPath,
    accountTxPath: split.accountTxPath,
    header: split.header,
    entityTxPageRefs: prepareReferencePages(entityTxRefs, 'entityTx', rowsByHash),
    accountTxPageRefs: prepareReferencePages(accountTxRefs, 'accountTx', rowsByHash),
  });
  rowsByHash.set(row.hash, row);
  return row.hash;
};

export const prepareRuntimeOutputPayloadRows = (
  outputs: readonly RoutedEntityInput[],
): Readonly<{
  refs: RuntimeOutputPayloadHash[];
  rows: RuntimeOutputPayloadRow[];
}> => {
  const rowsByHash = new Map<RuntimeOutputPayloadHash, RuntimeOutputPayloadRow>();
  const refs = outputs.map(output => {
    const { entityTxs, ...header } = output;
    const entityTxRefs = (entityTxs ?? []).map(tx => prepareEntityTxRow(tx, rowsByHash));
    const manifest = prepareRow({
      kind: 'output',
      version: 1,
      header,
      hasEntityTxs: entityTxs !== undefined,
      entityTxPageRefs: prepareReferencePages(entityTxRefs, 'entityTx', rowsByHash),
    });
    rowsByHash.set(manifest.hash, manifest);
    return manifest.hash;
  });
  return { refs, rows: [...rowsByHash.values()] };
};

export const decodeRuntimeOutputPayloadRefs = (
  value: unknown,
  code: string,
): RuntimeOutputPayloadHash[] => {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(code);
  return value.map((raw, index) => {
    if (typeof raw !== 'string') throw new Error(`${code}:${index}:TYPE`);
    return toRuntimeOutputPayloadHash(raw.toLowerCase());
  });
};

const decodeStoredEntityTx = (value: unknown): StoredEntityTx => {
  const payload = record(value, 'STORAGE_RUNTIME_OUTPUT_TX_INVALID');
  exactKeys(payload, [
    'kind', 'version', 'entityTxPath', 'accountTxPath', 'header',
    'entityTxPageRefs', 'accountTxPageRefs',
  ], 'STORAGE_RUNTIME_OUTPUT_TX');
  if (payload['kind'] !== 'entityTx' || payload['version'] !== 1) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_TX_VERSION');
  }
  const entityTxPath = payload['entityTxPath'];
  if (
    entityTxPath !== 'none'
    && entityTxPath !== 'data.entityTxs'
    && entityTxPath !== 'data.txs'
    && entityTxPath !== 'data.action.data.txs'
  ) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_TX_PATH');
  }
  const accountTxPath = payload['accountTxPath'];
  if (accountTxPath !== 'none' && accountTxPath !== 'data.proposal.frame.accountTxs') {
    throw new Error('STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX_PATH');
  }
  if (entityTxPath !== 'none' && accountTxPath !== 'none') {
    throw new Error('STORAGE_RUNTIME_OUTPUT_TX_MULTIPLE_CHILD_KINDS');
  }
  return {
    kind: 'entityTx',
    version: 1,
    entityTxPath,
    accountTxPath,
    header: record(payload['header'], 'STORAGE_RUNTIME_OUTPUT_TX_HEADER'),
    entityTxPageRefs: decodeRuntimeOutputPayloadRefs(
      payload['entityTxPageRefs'],
      'STORAGE_RUNTIME_OUTPUT_ENTITY_TX_PAGE_REFS',
    ),
    accountTxPageRefs: decodeRuntimeOutputPayloadRefs(
      payload['accountTxPageRefs'],
      'STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX_PAGE_REFS',
    ),
  };
};

const decodeStoredAccountTx = (value: unknown): StoredAccountTx => {
  const payload = record(value, 'STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX_INVALID');
  exactKeys(payload, ['kind', 'version', 'tx'], 'STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX');
  if (payload['kind'] !== 'accountTx' || payload['version'] !== 1) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX_VERSION');
  }
  return {
    kind: 'accountTx',
    version: 1,
    tx: decodeAccountTx(payload['tx'], 'STORAGE_RUNTIME_OUTPUT_ACCOUNT_TX'),
  };
};

const decodeStoredReferencePage = (value: unknown): StoredReferencePage => {
  const payload = record(value, 'STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_INVALID');
  exactKeys(payload, ['kind', 'version', 'childKind', 'refs'], 'STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE');
  if (payload['kind'] !== 'referencePage' || payload['version'] !== 1) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_VERSION');
  }
  const childKind = payload['childKind'];
  if (childKind !== 'entityTx' && childKind !== 'accountTx') {
    throw new Error('STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_CHILD_KIND');
  }
  const refs = decodeRuntimeOutputPayloadRefs(
    payload['refs'],
    'STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_REFS',
  );
  if (refs.length === 0 || refs.length > REFERENCE_PAGE_SIZE) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_SIZE');
  }
  return { kind: 'referencePage', version: 1, childKind, refs };
};

const decodeStoredOutputManifest = (value: unknown): StoredOutputManifest => {
  const payload = record(value, 'STORAGE_RUNTIME_OUTPUT_MANIFEST_INVALID');
  exactKeys(
    payload,
    ['kind', 'version', 'header', 'hasEntityTxs', 'entityTxPageRefs'],
    'STORAGE_RUNTIME_OUTPUT_MANIFEST',
  );
  if (payload['kind'] !== 'output' || payload['version'] !== 1) {
    throw new Error('STORAGE_RUNTIME_OUTPUT_MANIFEST_VERSION');
  }
  if (typeof payload['hasEntityTxs'] !== 'boolean') {
    throw new Error('STORAGE_RUNTIME_OUTPUT_MANIFEST_ENTITY_TXS_FLAG');
  }
  return {
    kind: 'output',
    version: 1,
    header: record(payload['header'], 'STORAGE_RUNTIME_OUTPUT_MANIFEST_HEADER'),
    hasEntityTxs: payload['hasEntityTxs'],
    entityTxPageRefs: decodeRuntimeOutputPayloadRefs(
      payload['entityTxPageRefs'],
      'STORAGE_RUNTIME_OUTPUT_MANIFEST_TX_PAGE_REFS',
    ),
  };
};

const readPayloadBytes = async (
  db: Pick<RuntimeDbLike, 'get'>,
  ref: RuntimeOutputPayloadHash,
  index: string,
): Promise<Buffer> => {
  let value: Buffer;
  try {
    value = await db.get(keyRuntimeOutputPayload(ref));
  } catch (error) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_PAYLOAD_MISSING:${index}:${ref}`, { cause: error });
  }
  if (value.byteLength >= MAX_RUNTIME_OUTPUT_PAYLOAD_BYTES) {
    throw new Error(`STORAGE_RUNTIME_OUTPUT_PAYLOAD_TOO_LARGE:${value.byteLength}`);
  }
  const actual = hashPayload(value);
  if (actual !== ref) {
    throw new Error(
      `STORAGE_RUNTIME_OUTPUT_PAYLOAD_HASH_MISMATCH:${index}:` +
      `expected=${ref}:actual=${actual}`,
    );
  }
  return value;
};

const installNestedEntityTxs = (
  stored: StoredEntityTx,
  entityTxs: EntityTx[],
  accountTxs: AccountTx[],
): EntityTx => {
  if (stored.entityTxPath === 'none' && stored.accountTxPath === 'none') {
    if (entityTxs.length !== 0 || accountTxs.length !== 0) {
      throw new Error('STORAGE_RUNTIME_OUTPUT_TX_UNEXPECTED_CHILDREN');
    }
    return validateEntityTx(stored.header, 'STORAGE_RUNTIME_OUTPUT_TX');
  }
  const data = record(stored.header['data'], 'STORAGE_RUNTIME_OUTPUT_TX_DATA');
  if (stored.entityTxPath === 'data.entityTxs') {
    if (Object.hasOwn(data, 'entityTxs')) throw new Error('STORAGE_RUNTIME_OUTPUT_TX_CHILDREN_DUPLICATE');
    return validateEntityTx(
      { ...stored.header, data: { ...data, entityTxs } },
      'STORAGE_RUNTIME_OUTPUT_TX',
    );
  }
  if (stored.entityTxPath === 'data.txs') {
    if (Object.hasOwn(data, 'txs')) throw new Error('STORAGE_RUNTIME_OUTPUT_TX_CHILDREN_DUPLICATE');
    return validateEntityTx(
      { ...stored.header, data: { ...data, txs: entityTxs } },
      'STORAGE_RUNTIME_OUTPUT_TX',
    );
  }
  if (stored.accountTxPath === 'data.proposal.frame.accountTxs') {
    const proposal = record(data['proposal'], 'STORAGE_RUNTIME_OUTPUT_TX_PROPOSAL');
    const frame = record(proposal['frame'], 'STORAGE_RUNTIME_OUTPUT_TX_FRAME');
    if (Object.hasOwn(frame, 'accountTxs')) {
      throw new Error('STORAGE_RUNTIME_OUTPUT_ACCOUNT_TXS_DUPLICATE');
    }
    return validateEntityTx({
      ...stored.header,
      data: { ...data, proposal: { ...proposal, frame: { ...frame, accountTxs } } },
    }, 'STORAGE_RUNTIME_OUTPUT_TX');
  }
  const action = record(data['action'], 'STORAGE_RUNTIME_OUTPUT_TX_ACTION');
  const actionData = record(action['data'], 'STORAGE_RUNTIME_OUTPUT_TX_ACTION_DATA');
  if (Object.hasOwn(actionData, 'txs')) throw new Error('STORAGE_RUNTIME_OUTPUT_TX_CHILDREN_DUPLICATE');
  return validateEntityTx({
    ...stored.header,
    data: { ...data, action: { ...action, data: { ...actionData, txs: entityTxs } } },
  }, 'STORAGE_RUNTIME_OUTPUT_TX');
};

const readStoredAccountTx = async (
  db: Pick<RuntimeDbLike, 'get'>,
  ref: RuntimeOutputPayloadHash,
  index: string,
): Promise<AccountTx> => decodeStoredAccountTx(
  decodeBuffer(await readPayloadBytes(db, ref, index)),
).tx;

const readReferencePages = async (
  db: Pick<RuntimeDbLike, 'get'>,
  pageRefs: readonly RuntimeOutputPayloadHash[],
  childKind: StoredReferencePage['childKind'],
  index: string,
): Promise<RuntimeOutputPayloadHash[]> => {
  const pages = await Promise.all(pageRefs.map(async (pageRef, pageIndex) => {
    const page = decodeStoredReferencePage(decodeBuffer(
      await readPayloadBytes(db, pageRef, `${index}.page.${pageIndex}`),
    ));
    if (page.childKind !== childKind) {
      throw new Error(`STORAGE_RUNTIME_OUTPUT_REFERENCE_PAGE_KIND_MISMATCH:${index}`);
    }
    return page.refs;
  }));
  return pages.flat();
};

const readStoredEntityTx = async (
  db: Pick<RuntimeDbLike, 'get'>,
  ref: RuntimeOutputPayloadHash,
  index: string,
  depth = 0,
): Promise<EntityTx> => {
  if (depth > 16) throw new Error('STORAGE_RUNTIME_OUTPUT_TX_NESTING_LIMIT');
  const stored = decodeStoredEntityTx(decodeBuffer(await readPayloadBytes(db, ref, index)));
  const entityTxRefs = await readReferencePages(
    db, stored.entityTxPageRefs, 'entityTx', `${index}.entity`,
  );
  const accountTxRefs = await readReferencePages(
    db, stored.accountTxPageRefs, 'accountTx', `${index}.account`,
  );
  const entityTxs = await Promise.all(entityTxRefs.map((childRef, childIndex) =>
    readStoredEntityTx(db, childRef, `${index}.${childIndex}`, depth + 1)));
  const accountTxs = await Promise.all(accountTxRefs.map((childRef, childIndex) =>
    readStoredAccountTx(db, childRef, `${index}.account.${childIndex}`)));
  return installNestedEntityTxs(stored, entityTxs, accountTxs);
};

const readStoredOutput = async (
  db: Pick<RuntimeDbLike, 'get'>,
  ref: RuntimeOutputPayloadHash,
  index: number,
): Promise<RoutedEntityInput> => {
  const manifest = decodeStoredOutputManifest(decodeBuffer(
    await readPayloadBytes(db, ref, String(index)),
  ));
  const entityTxRefs = await readReferencePages(
    db, manifest.entityTxPageRefs, 'entityTx', `${index}.tx`,
  );
  const entityTxs = await Promise.all(entityTxRefs.map((txRef, txIndex) =>
    readStoredEntityTx(db, txRef, `${index}.tx.${txIndex}`)));
  return decodeRoutedEntityInput(manifest.hasEntityTxs
    ? { ...manifest.header, entityTxs }
    : manifest.header);
};

export const readRuntimeOutputPayloads = async (
  db: Pick<RuntimeDbLike, 'get'>,
  refs: readonly RuntimeOutputPayloadHash[],
): Promise<RoutedEntityInput[]> => Promise.all(refs.map((ref, index) =>
  readStoredOutput(db, ref, index)));
