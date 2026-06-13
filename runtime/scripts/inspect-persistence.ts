#!/usr/bin/env bun

import { buildPersistenceInspection, type PersistenceInspectionSummary } from '../persistence-inspect';
import { safeStringify } from '../serialization-utils';

type Args = {
  runtimeId?: string;
  runtimeSeed?: string;
  tail: number;
  verify: boolean;
  bundlePath?: string;
  towerUrl?: string;
  lookupKey?: string;
  json: boolean;
  strict: boolean;
};

const usage = (code = 1): never => {
  console.log([
    'Usage:',
    '  bun runtime/scripts/inspect-persistence.ts (--runtime-id <id> | --runtime-seed <seed>) [options]',
    '',
    'Options:',
    '  --tail <n>             Number of latest WAL frames to inspect (default: 32)',
    '  --verify               Replay persisted frames from the latest checkpoint',
    '  --bundle <path>        Validate a plaintext or encrypted recovery bundle file',
    '  --tower-url <url>      Check latest watchtower receipt by lookup key',
    '  --lookup-key <key>     Explicit tower lookup key; derived from --runtime-seed when omitted',
    '  --json                 Print machine-readable JSON',
    '  --strict               Exit 2 on critical status, 1 on warning status',
    '  --help                 Show this help',
    '',
    'This command is inspect-only. It never mutates local persistence.',
  ].join('\n'));
  process.exit(code);
};

const requireValue = (flag: string, value: string | undefined): string => {
  if (!value || value.startsWith('--')) {
    throw new Error(`ARG_VALUE_REQUIRED:${flag}`);
  }
  return value;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const out: Args = {
    tail: 32,
    verify: false,
    json: false,
    strict: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = args[index + 1];
    switch (current) {
      case '--runtime-id':
        out.runtimeId = requireValue(current, next).toLowerCase();
        index += 1;
        break;
      case '--runtime-seed':
        out.runtimeSeed = requireValue(current, next);
        index += 1;
        break;
      case '--tail':
        out.tail = Math.max(1, Math.min(5000, Math.floor(Number(requireValue(current, next)))));
        index += 1;
        break;
      case '--verify':
        out.verify = true;
        break;
      case '--bundle':
        out.bundlePath = requireValue(current, next);
        index += 1;
        break;
      case '--tower-url':
        out.towerUrl = requireValue(current, next);
        index += 1;
        break;
      case '--lookup-key':
        out.lookupKey = requireValue(current, next).toLowerCase();
        index += 1;
        break;
      case '--json':
        out.json = true;
        break;
      case '--strict':
        out.strict = true;
        break;
      case '--help':
      case '-h':
        usage(0);
        break;
      default:
        throw new Error(`ARG_UNKNOWN:${current || ''}`);
    }
  }
  if (!out.runtimeId && !out.runtimeSeed) {
    usage();
  }
  if (!Number.isFinite(out.tail) || out.tail <= 0) {
    throw new Error('ARG_INVALID:--tail');
  }
  return out;
};

const formatBytes = (value: number | undefined): string => {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
};

const printHuman = (summary: PersistenceInspectionSummary): void => {
  console.log(`status: ${summary.status}`);
  console.log(`runtime: ${summary.runtimeId}`);
  console.log(`namespace: ${summary.dbNamespace}`);
  console.log(`latestHeight: ${summary.latestHeight}`);
  console.log(`checkpoints: ${summary.checkpointHeights.length ? summary.checkpointHeights.join(', ') : 'none'}`);
  console.log(`walTail: ${summary.walTail.fromHeight}-${summary.walTail.toHeight} present=${summary.walTail.presentCount} missing=${summary.walTail.missingHeights.length ? summary.walTail.missingHeights.join(',') : 'none'}`);
  console.log(`lastFrameLogs: ${summary.walTail.lastFrameLogCount}`);

  if (summary.storage) {
    console.log(`storageFrames: ${summary.storage.frameCount}`);
    console.log(`storageSnapshots: ${summary.storage.snapshotHeights.length}`);
    console.log(`storageBytes: ${formatBytes(summary.storage.totalBytes)}`);
    for (const epoch of summary.storage.epochDbs ?? []) {
      if (!epoch) continue;
      console.log(`storageDb.${epoch.role}: height=${epoch.latestHeight} snapshots=${epoch.snapshotCount} path=${epoch.path}`);
    }
  } else {
    console.log('storage: none');
  }

  if (summary.verification) {
    console.log(`verify: ${summary.verification.ok ? 'ok' : 'failed'} restoredHeight=${summary.verification.restoredHeight}`);
    if (!summary.verification.ok) {
      console.log(`verify.expectedStateHash: ${summary.verification.expectedStateHash || 'n/a'}`);
      console.log(`verify.actualStateHash: ${summary.verification.actualStateHash || 'n/a'}`);
    }
  } else {
    console.log('verify: skipped');
  }

  console.log(summary.bundle.checked
    ? `bundle: ${summary.bundle.valid ? 'valid' : 'invalid'} ${summary.bundle.encrypted ? 'encrypted' : 'plaintext'} height=${summary.bundle.height ?? 'n/a'}`
    : 'bundle: not checked');
  console.log(summary.tower.checked
    ? `tower: ${summary.tower.ok ? 'ok' : 'unavailable'} height=${summary.tower.receipt?.height ?? 'n/a'}`
    : 'tower: not checked');

  if (summary.issues.length > 0) {
    console.log('');
    console.log('issues:');
    for (const issue of summary.issues) {
      console.log(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  if (summary.repairPlan.length > 0) {
    console.log('');
    console.log('repair plan:');
    for (const step of summary.repairPlan) {
      console.log(`- ${step}`);
    }
  }
};

const strictExitCode = (summary: PersistenceInspectionSummary): number => {
  if (summary.status === 'critical') return 2;
  if (summary.status === 'warning') return 1;
  return 0;
};

async function main() {
  const args = parseArgs();
  const summary = await buildPersistenceInspection({
    ...(args.runtimeId ? { runtimeId: args.runtimeId } : {}),
    ...(args.runtimeSeed ? { runtimeSeed: args.runtimeSeed } : {}),
    tail: args.tail,
    verify: args.verify,
    ...(args.bundlePath ? { bundlePath: args.bundlePath } : {}),
    ...(args.towerUrl ? { towerUrl: args.towerUrl } : {}),
    ...(args.lookupKey ? { lookupKey: args.lookupKey } : {}),
  });

  if (args.json) {
    console.log(safeStringify(summary, 2));
  } else {
    printHuman(summary);
  }
  if (args.strict) process.exit(strictExitCode(summary));
}

main().catch((error) => {
  console.error('inspect-persistence failed:', error instanceof Error ? error.message : String(error));
  process.exit(2);
});
