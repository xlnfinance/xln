import type { AccountJClaimAccumulatorState, AccountJClaimNode } from '../../../types/finance/account-j-claims';
import type { CertifiedBoardPatriciaNode } from '../../../types/entity-board-registry';
import {
  EMPTY_CERTIFIED_BOARD_ROOT,
  hashCertifiedBoardNode,
} from '../../../jurisdiction/machine/board-registry';
import {
  EMPTY_ACCOUNT_J_CLAIM_ROOT,
  hashAccountJClaimNode,
} from '../../../account/j-claims/j-claim-accumulator';
import { encodeBuffer } from '../../codec/codec';
import {
  keyAccountJClaimPathNode,
  keyCertifiedBoardPathNode,
  type BinaryPatriciaStoragePath,
} from '../../keys';

type BinaryPatriciaNode =
  | Readonly<{ type: 'leaf'; key: string }>
  | Readonly<{ type: 'branch'; bit: number; left: string; right: string }>;

export type PersistedPathNode<T> = Readonly<{
  version: 1;
  hash: string;
  node: T;
}>;

export type AuxiliaryTreeOwner = Readonly<{
  entityId: string;
  certifiedBoardRoot?: string;
  accounts: readonly Readonly<{
    counterpartyId: string;
    leftPendingJClaims: AccountJClaimAccumulatorState;
    rightPendingJClaims: AccountJClaimAccumulatorState;
  }>[];
}>;

export type PathKeyedAuxiliaryRows = Readonly<{
  certifiedBoardNodes: readonly Readonly<{ key: Buffer; value: Buffer }>[];
  accountJClaimNodes: readonly Readonly<{ key: Buffer; value: Buffer }>[];
}>;

const keyBit = (key: string, bit: number): 0 | 1 => {
  const offset = 2 + Math.floor(bit / 8) * 2;
  const byte = Number.parseInt(key.slice(offset, offset + 2), 16);
  return ((byte >> (7 - (bit % 8))) & 1) as 0 | 1;
};

const putUnique = (
  rows: Map<string, Readonly<{ key: Buffer; value: Buffer }>>,
  key: Buffer,
  value: Buffer,
  code: string,
): void => {
  const keyHex = key.toString('hex');
  const previous = rows.get(keyHex);
  if (previous && !previous.value.equals(value)) {
    throw new Error(`${code}_PATH_COLLISION:${keyHex}`);
  }
  rows.set(keyHex, { key, value });
};

const projectTree = <TNode extends BinaryPatriciaNode>(options: {
  root: string;
  store: ReadonlyMap<string, TNode>;
  hashNode: (node: TNode) => string;
  keyForPath: (path: BinaryPatriciaStoragePath) => Buffer;
  rows: Map<string, Readonly<{ key: Buffer; value: Buffer }>>;
  reached: Set<string>;
  code: string;
}): void => {
  const stack = new Set<string>();
  const visit = (hash: string, previousBit: number): string => {
    if (stack.has(hash)) throw new Error(`${options.code}_CYCLE:${hash}`);
    const node = options.store.get(hash);
    if (!node) throw new Error(`${options.code}_MISSING:${hash}`);
    const actual = options.hashNode(node);
    if (actual !== hash) throw new Error(`${options.code}_CORRUPT:${hash}:${actual}`);
    options.reached.add(hash);
    stack.add(hash);
    try {
      if (node.type === 'leaf') {
        const path = { kind: 'leaf' as const, key: node.key };
        putUnique(
          options.rows,
          options.keyForPath(path),
          encodeBuffer({ version: 1, hash, node } satisfies PersistedPathNode<TNode>),
          options.code,
        );
        return node.key;
      }
      if (!Number.isSafeInteger(node.bit) || node.bit <= previousBit || node.bit > 255) {
        throw new Error(`${options.code}_BRANCH_ORDER_INVALID:${previousBit}:${String(node.bit)}`);
      }
      if (node.left === node.right) throw new Error(`${options.code}_BRANCH_UNARY:${node.left}`);
      const leftKey = visit(node.left, node.bit);
      const rightKey = visit(node.right, node.bit);
      if (keyBit(leftKey, node.bit) !== 0 || keyBit(rightKey, node.bit) !== 1) {
        throw new Error(`${options.code}_BRANCH_DIRECTION_INVALID:${node.bit}`);
      }
      const path = {
        kind: 'branch' as const,
        bit: node.bit,
        representativeKey: leftKey,
      };
      putUnique(
        options.rows,
        options.keyForPath(path),
        encodeBuffer({ version: 1, hash, node } satisfies PersistedPathNode<TNode>),
        options.code,
      );
      return leftKey;
    } finally {
      stack.delete(hash);
    }
  };
  visit(options.root, -1);
};

const registerRoot = (
  roots: Map<string, string>,
  owner: string,
  root: string,
  code: string,
): void => {
  const previous = roots.get(owner);
  if (previous && previous !== root) {
    throw new Error(`${code}_OWNER_ROOT_CONFLICT:${owner}:${previous}:${root}`);
  }
  roots.set(owner, root);
};

/**
 * Project every live auxiliary Patricia tree into permanent owner/path rows.
 * Digests remain in values so the committed root authenticates bytes, but a
 * digest can never select a physical row or make storage grow by path-copy.
 */
export const preparePathKeyedAuxiliaryRows = (options: {
  owners: readonly AuxiliaryTreeOwner[];
  certifiedBoardStore: ReadonlyMap<string, CertifiedBoardPatriciaNode>;
  accountJClaimStore: ReadonlyMap<string, AccountJClaimNode>;
  rejectUnreachable?: boolean;
}): PathKeyedAuxiliaryRows => {
  const boardRows = new Map<string, Readonly<{ key: Buffer; value: Buffer }>>();
  const accountRows = new Map<string, Readonly<{ key: Buffer; value: Buffer }>>();
  const boardRoots = new Map<string, string>();
  const accountRoots = new Map<string, string>();
  const boardReached = new Set<string>();
  const accountReached = new Set<string>();

  for (const owner of options.owners) {
    const entityId = owner.entityId.toLowerCase();
    if (owner.certifiedBoardRoot && owner.certifiedBoardRoot !== EMPTY_CERTIFIED_BOARD_ROOT) {
      registerRoot(boardRoots, entityId, owner.certifiedBoardRoot, 'CERTIFIED_BOARD_PATH');
    }
    for (const account of owner.accounts) {
      const counterpartyId = account.counterpartyId.toLowerCase();
      for (const [side, state] of [
        [0, account.leftPendingJClaims],
        [1, account.rightPendingJClaims],
      ] as const) {
        if (state.root === EMPTY_ACCOUNT_J_CLAIM_ROOT) continue;
        registerRoot(
          accountRoots,
          `${entityId}:${counterpartyId}:${side}`,
          state.root,
          'ACCOUNT_J_CLAIM_PATH',
        );
      }
    }
  }

  for (const [entityId, root] of boardRoots) {
    projectTree({
      root,
      store: options.certifiedBoardStore,
      hashNode: hashCertifiedBoardNode,
      keyForPath: path => keyCertifiedBoardPathNode(entityId, path),
      rows: boardRows,
      reached: boardReached,
      code: 'CERTIFIED_BOARD_PATH_NODE',
    });
  }
  for (const [owner, root] of accountRoots) {
    const [entityId, counterpartyId, sideText] = owner.split(':');
    if (!entityId || !counterpartyId || (sideText !== '0' && sideText !== '1')) {
      throw new Error(`ACCOUNT_J_CLAIM_PATH_OWNER_INVALID:${owner}`);
    }
    const side = sideText === '0' ? 0 : 1;
    projectTree({
      root,
      store: options.accountJClaimStore,
      hashNode: hashAccountJClaimNode,
      keyForPath: path => keyAccountJClaimPathNode(entityId, counterpartyId, side, path),
      rows: accountRows,
      reached: accountReached,
      code: 'ACCOUNT_J_CLAIM_PATH_NODE',
    });
  }

  if (options.rejectUnreachable) {
    for (const [code, reached, store] of [
      ['CERTIFIED_BOARD_PATH', boardReached, options.certifiedBoardStore],
      ['ACCOUNT_J_CLAIM_PATH', accountReached, options.accountJClaimStore],
    ] as const) {
      const unreachable = [...store.keys()].filter(hash => !reached.has(hash));
      if (unreachable.length > 0) throw new Error(`${code}_UNREACHABLE:${unreachable[0]}`);
    }
  }

  const sorted = (rows: Map<string, Readonly<{ key: Buffer; value: Buffer }>>) =>
    [...rows.values()].sort((left, right) => Buffer.compare(left.key, right.key));
  return {
    certifiedBoardNodes: sorted(boardRows),
    accountJClaimNodes: sorted(accountRows),
  };
};
