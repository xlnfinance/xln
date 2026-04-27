#!/usr/bin/env bun

import { createEmptyEnv, getPersistedLatestHeight, readPersistedFrameJournals } from '../runtime';
import { safeStringify } from '../serialization-utils';

type Args = {
  runtimeId?: string;
  runtimeSeed?: string;
  fromHeight: number;
  toHeight?: number;
  tail?: number;
  limit: number;
  entityId?: string;
  eventName?: string;
  includeInputs: boolean;
  json: boolean;
};

const usage = (code = 1): never => {
  console.log(
    [
      'Usage:',
      '  bun runtime/scripts/read-frame-receipts.ts --runtime-id <id> [--from 1] [--to N] [--tail N] [--limit 200]',
      '    [--entity <entityId>] [--event <eventName>] [--inputs] [--json]',
      '',
      'Notes:',
      '  - Reads persisted frame journals through runtime API.',
      '  - Use --runtime-seed when runtimeId is not known and seed-derived namespace should be used.',
    ].join('\n'),
  );
  process.exit(code);
};

const readArgs = (): Args => {
  const args = process.argv.slice(2);
  const out: Args = {
    fromHeight: 1,
    limit: 200,
    includeInputs: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = args[index + 1];
    switch (current) {
      case '--runtime-id':
        if (!next) usage();
        out.runtimeId = String(next);
        index += 1;
        break;
      case '--runtime-seed':
        if (!next) usage();
        out.runtimeSeed = String(next);
        index += 1;
        break;
      case '--from':
        out.fromHeight = Math.max(1, Number(next ?? '1'));
        index += 1;
        break;
      case '--to':
        out.toHeight = Math.max(1, Number(next ?? '1'));
        index += 1;
        break;
      case '--limit':
        out.limit = Math.max(1, Math.min(1000, Number(next ?? '200')));
        index += 1;
        break;
      case '--tail':
        out.tail = Math.max(1, Math.min(1000, Number(next ?? '20')));
        index += 1;
        break;
      case '--entity':
        out.entityId = String(next || '').toLowerCase();
        index += 1;
        break;
      case '--event':
        out.eventName = String(next || '');
        index += 1;
        break;
      case '--inputs':
        out.includeInputs = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        usage();
    }
  }
  if (!out.runtimeId && !out.runtimeSeed) usage();
  return out;
};

const matches = (
  entry: { message?: string; entityId?: string },
  filters: { entityId?: string; eventName?: string },
): boolean => {
  if (filters.eventName && entry.message !== filters.eventName) return false;
  if (filters.entityId && String(entry.entityId || '').toLowerCase() !== filters.entityId) return false;
  return true;
};

async function main() {
  const args = readArgs();
  const env = createEmptyEnv(args.runtimeSeed ?? null);
  if (args.runtimeId) {
    env.runtimeId = args.runtimeId.toLowerCase();
    env.dbNamespace = env.runtimeId;
  }

  if (args.tail !== undefined) {
    const latestHeight = await getPersistedLatestHeight(env);
    const tail = Math.max(1, args.tail);
    args.toHeight = latestHeight;
    args.fromHeight = Math.max(1, latestHeight - tail + 1);
    args.limit = Math.max(args.limit, tail);
  }

  const receipts = await readPersistedFrameJournals(env, {
    fromHeight: args.fromHeight,
    ...(args.toHeight === undefined ? {} : { toHeight: args.toHeight }),
    limit: args.limit,
  });

  const filtered = receipts
    .map((receipt) => {
      const logs = (receipt.logs ?? []).filter((entry) => matches(entry, args));
      if ((args.entityId || args.eventName) && logs.length === 0) return null;
      return {
        height: receipt.height,
        timestamp: receipt.timestamp,
        logs,
        ...(args.includeInputs ? { runtimeInput: receipt.runtimeInput } : {}),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (args.json) {
    console.log(safeStringify(filtered));
    return;
  }

  for (const receipt of filtered) {
    console.log(`\n# frame=${receipt.height} ts=${receipt.timestamp}`);
    for (const log of receipt.logs) {
      const entitySuffix = typeof log.entityId === 'string' && log.entityId.length > 0
        ? ` entity=${log.entityId.slice(0, 12)}`
        : '';
      console.log(`- ${log.level}/${log.category} ${log.message}${entitySuffix}`);
      if (log.data && Object.keys(log.data).length > 0) {
        console.log(`  data=${safeStringify(log.data)}`);
      }
    }
    if (args.includeInputs) {
      console.log(`  input=${safeStringify(receipt.runtimeInput)}`);
    }
  }

  console.log(`\nreturned=${filtered.length}`);
}

main().catch((error) => {
  console.error('read-frame-receipts failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
