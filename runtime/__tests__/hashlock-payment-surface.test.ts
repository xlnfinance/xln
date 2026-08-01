import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const productionRoots = [
  'brainvault/', 'custody/', 'debates/', 'frontend/', 'jurisdictions/', 'native/',
  'ops/', 'packages/npm/', 'release/', 'runtime/', 'scripts/', 'tools/', 'types/',
];
const nonProductionPaths = [
  /^brainvault\/.*\.(?:test|spec)\.[^/]+$/u,
  /^debates\/tests\//u,
  /^frontend\/android\/app\/src\/(?:androidTest|test)\//u,
  /^frontend\/(?:\.svelte-kit|build|tests)\//u,
  /^frontend\/static\/(?:contracts|docs-catalog|docs-static)\//u,
  /^frontend\/static\/(?:runtime\.js|hash-wasm-)/u,
  /^jurisdictions\/(?:artifacts|cache|test|typechain-types)\//u,
  /^native\/__tests__\//u,
  /^runtime\/(?:__tests__|scenarios)\//u,
];
const allowedRoles: Record<string, { count: number; fragments: readonly string[] }> = {
  'runtime/api/public/activity-history.ts': {
    count: 1,
    fragments: ["case 'htlcPayment':\n    case 'hashlockPayment':\n      return null;"],
  },
  'runtime/entity/htlc/note-index.ts': {
    count: 1,
    fragments: ["if (tx.type === 'hashlockPayment') {"],
  },
  'runtime/entity/tx-validation/payment-schemas.ts': {
    count: 1,
    fragments: ["hashlockPayment: {\n    required: { targetEntityId: 'string', tokenId: 'integer', amount: 'bigint', hashlock: 'string' },"],
  },
  'runtime/entity/tx/apply.ts': {
    count: 2,
    fragments: [
      'hashlockPayment: (env, state, tx, options) => handleHashlockPaymentEntityTx(',
      "Extract<EntityTx, { type: 'hashlockPayment' }>",
    ],
  },
  'runtime/entity/tx/catalog.ts': {
    count: 1,
    fragments: ["'extendCredit', 'hashlockPayment', 'htlcOnionAdvance'"],
  },
  'runtime/entity/tx/handlers/htlc-direct.ts': {
    count: 1,
    fragments: ["entityTx: EntityTxOf<'hashlockPayment'>,"],
  },
  'runtime/types/entity-tx.ts': {
    count: 1,
    fragments: ["// Direct hashlock-only HTLC. Used for cross-jurisdiction swaps where\n      // the sender must not know the preimage at lock time.\n      type: 'hashlockPayment';"],
  },
};

type TrackedEntry = { mode: string; path: string };
const trackedEntries = (): TrackedEntry[] =>
  execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/u.exec(line);
      if (!match) throw new Error(`HASHLOCK_PAYMENT_TRACKED_ENTRY_INVALID:${line}`);
      return { mode: match[1]!, path: match[2]! };
    });

const rootedOrTopLevelEntries = (): TrackedEntry[] => trackedEntries().filter(entry =>
  !entry.path.includes('/') || productionRoots.some(root => entry.path.startsWith(root))
);

const productionEntries = (entries: readonly TrackedEntry[]): TrackedEntry[] => entries.filter((entry) => {
  if (nonProductionPaths.some(pattern => pattern.test(entry.path))) return false;
  return entry.path.includes('/') || entry.mode === '100755' || entry.path === 'package.json';
});

const countLiteral = (bytes: Buffer, literal: Buffer): number => {
  let count = 0;
  for (let offset = bytes.indexOf(literal); offset >= 0; offset = bytes.indexOf(literal, offset + literal.length)) {
    count += 1;
  }
  return count;
};

test('canonical hashlockPayment stays confined to exact production roles', () => {
  const scopedEntries = rootedOrTopLevelEntries();
  expect(scopedEntries.flatMap(({ mode, path }) => {
    const stat = lstatSync(join(repoRoot, path));
    return mode === '120000' || stat.isSymbolicLink() || !stat.isFile()
      ? [`${mode}:${path}`]
      : [];
  })).toEqual([]);
  const inventory = productionEntries(scopedEntries);
  const paths = inventory.map(entry => entry.path);
  expect(paths).toEqual(expect.arrayContaining([
    'package.json', 'custody/server.ts', 'native/desktop/main.cjs',
    'packages/npm/xlnfinance/lib/api.js', 'frontend/src/routes/scenarios/+page.svelte',
    'frontend/android/app/build.gradle', 'frontend/android/gradlew', 'frontend/android/gradlew.bat',
    'frontend/android/app/src/main/AndroidManifest.xml',
    'frontend/android/app/src/main/java/finance/xln/wallet/MainActivity.java',
    'frontend/ios/App/App/AppDelegate.swift',
  ]));

  const mentions = inventory.flatMap(({ path }) => {
    const bytes = readFileSync(join(repoRoot, path));
    const count = countLiteral(bytes, Buffer.from('hashlockPayment'));
    return count > 0 ? [{ path, source: bytes.toString('utf8'), count }] : [];
  });
  expect(mentions.map(entry => entry.path).sort()).toEqual(Object.keys(allowedRoles).sort());
  for (const mention of mentions) {
    const role = allowedRoles[mention.path]!;
    expect(mention.count).toBe(role.count);
    for (const fragment of role.fragments) expect(mention.source).toContain(fragment);
  }
});
