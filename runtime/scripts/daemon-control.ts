#!/usr/bin/env bun

import { serializeTaggedJson } from '../serialization-utils';
import {
  becomeHub,
  DaemonControlClient,
  enableRouting,
  setupCustody,
  type EnableRoutingConfig,
  type SetupCustodyConfig,
} from '../orchestrator/daemon-control';

const args = process.argv.slice(2);

const command = args[0] || '';

const getArg = (name: string, fallback = ''): string => {
  const withEquals = args.find(arg => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
};

const hasFlag = (name: string): boolean => args.includes(name);

const parseOptionalNumber = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalBigInt = (value: string): bigint | undefined => {
  if (!value.trim()) return undefined;
  return BigInt(value);
};

const parseIds = (value: string): string[] =>
  value
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);

const parseNumbers = (value: string): number[] =>
  value
    .split(',')
    .map(part => Number(part.trim()))
    .filter(part => Number.isFinite(part) && part > 0);

const printUsage = (): void => {
  console.log(`
Usage:
  bun runtime/scripts/daemon-control.ts enable-routing --base-url http://127.0.0.1:8080 --name H1 --seed my-seed --signer-label hub-1
  bun runtime/scripts/daemon-control.ts become-hub --base-url http://127.0.0.1:8080 --name H1 --seed my-seed --signer-label hub-1
  bun runtime/scripts/daemon-control.ts setup-custody --base-url http://127.0.0.1:8080 --name Custody --seed my-seed --signer-label custody-1 --hub-ids 0x...,0x...

Optional:
  --auth-key <xlnra1 capability>
  --relay-url <ws://.../relay>
  --gossip-poll-ms <ms>
  --routing-fee-ppm <ppm>
  --base-fee <wei>
  --credit-amount <wei>
  --credit-token-ids 1,2,3
  --position 0,0,0
  --no-orderbook
  --routing-enabled
`);
};

const parsePosition = (value: string): { x: number; y: number; z: number } | undefined => {
  if (!value.trim()) return undefined;
  const parts = value.split(',').map(part => Number(part.trim()));
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) {
    throw new Error(`Invalid --position "${value}" (expected x,y,z)`);
  }
  return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
};

const requireBaseConfig = (): {
  baseUrl: string;
  authKey?: string;
  name: string;
  seed: string;
  signerLabel: string;
  relayUrl?: string;
  gossipPollMs?: number;
  position?: { x: number; y: number; z: number };
} => {
  const baseUrl = getArg('--base-url', '').trim();
  const name = getArg('--name', '').trim();
  const seed = getArg('--seed', '').trim();
  const signerLabel = getArg('--signer-label', '').trim();
  if (!baseUrl || !name || !seed || !signerLabel) {
    throw new Error('--base-url, --name, --seed, and --signer-label are required');
  }
  const result: {
    baseUrl: string;
    authKey?: string;
    name: string;
    seed: string;
    signerLabel: string;
    relayUrl?: string;
    gossipPollMs?: number;
    position?: { x: number; y: number; z: number };
  } = {
    baseUrl,
    name,
    seed,
    signerLabel,
  };
  const authKey = getArg('--auth-key', '').trim();
  if (authKey) result.authKey = authKey;
  const relayUrl = getArg('--relay-url', '').trim();
  if (relayUrl) result.relayUrl = relayUrl;
  const gossipPollMs = parseOptionalNumber(getArg('--gossip-poll-ms', ''));
  if (gossipPollMs !== undefined) result.gossipPollMs = gossipPollMs;
  const position = parsePosition(getArg('--position', ''));
  if (position) result.position = position;
  return result;
};

const formatCliError = (error: unknown): string => {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === 'string') return error;
  if (error === undefined || error === null) return `Unknown daemon-control error: ${String(error)}`;
  try {
    return serializeTaggedJson(error);
  } catch {
    return String(error);
  }
};

const run = async (): Promise<void> => {
  if (!command || hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const base = requireBaseConfig();
  const client = new DaemonControlClient({
    baseUrl: base.baseUrl,
    ...(base.authKey ? { authKey: base.authKey } : {}),
  });

  if (command === 'enable-routing' || command === 'become-hub') {
    const routingFeePPM = parseOptionalNumber(getArg('--routing-fee-ppm', ''));
    const baseFee = parseOptionalBigInt(getArg('--base-fee', ''));
    const swapTakerFeeBps = parseOptionalNumber(getArg('--swap-taker-fee-bps', ''));
    const config: EnableRoutingConfig = {
      name: base.name,
      seed: base.seed,
      signerLabel: base.signerLabel,
      ...(base.position ? { position: base.position } : {}),
      ...(base.relayUrl ? { relayUrl: base.relayUrl } : {}),
      ...(base.gossipPollMs !== undefined ? { gossipPollMs: base.gossipPollMs } : {}),
      ...(routingFeePPM !== undefined ? { routingFeePPM } : {}),
      ...(baseFee !== undefined ? { baseFee } : {}),
      ...(swapTakerFeeBps !== undefined ? { swapTakerFeeBps } : {}),
      initOrderbook: !hasFlag('--no-orderbook'),
    };
    const result = command === 'become-hub'
      ? await becomeHub(client, config)
      : await enableRouting(client, config);
    console.log(serializeTaggedJson({ ok: true, command, result }));
    return;
  }

  if (command === 'setup-custody') {
    const creditAmount = parseOptionalBigInt(getArg('--credit-amount', ''));
    const routingFeePPM = parseOptionalNumber(getArg('--routing-fee-ppm', ''));
    const baseFee = parseOptionalBigInt(getArg('--base-fee', ''));
    const swapTakerFeeBps = parseOptionalNumber(getArg('--swap-taker-fee-bps', ''));
    const config: SetupCustodyConfig = {
      name: base.name,
      seed: base.seed,
      signerLabel: base.signerLabel,
      ...(base.position ? { position: base.position } : {}),
      ...(base.relayUrl ? { relayUrl: base.relayUrl } : {}),
      ...(base.gossipPollMs !== undefined ? { gossipPollMs: base.gossipPollMs } : {}),
      hubEntityIds: parseIds(getArg('--hub-ids', '')),
      ...(creditAmount !== undefined ? { creditAmount } : {}),
      ...(getArg('--credit-token-ids', '').trim()
        ? { creditTokenIds: parseNumbers(getArg('--credit-token-ids', '')) }
        : {}),
      routingEnabled: hasFlag('--routing-enabled'),
      ...(routingFeePPM !== undefined ? { routingFeePPM } : {}),
      ...(baseFee !== undefined ? { baseFee } : {}),
      ...(swapTakerFeeBps !== undefined ? { swapTakerFeeBps } : {}),
    };
    const result = await setupCustody(client, config);
    console.log(serializeTaggedJson({ ok: true, command, result }));
    return;
  }

  throw new Error(`Unknown command "${command}"`);
};

run().catch((error: unknown) => {
  console.error(`[daemon-control] ${formatCliError(error)}`);
  process.exit(1);
});
