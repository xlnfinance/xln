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
  --control-token <token>
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
  controlToken?: string;
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
  return {
    baseUrl,
    controlToken: getArg('--control-token', '').trim() || undefined,
    name,
    seed,
    signerLabel,
    relayUrl: getArg('--relay-url', '').trim() || undefined,
    gossipPollMs: parseOptionalNumber(getArg('--gossip-poll-ms', '')),
    position: parsePosition(getArg('--position', '')),
  };
};

const run = async (): Promise<void> => {
  if (!command || hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const base = requireBaseConfig();
  const client = new DaemonControlClient({
    baseUrl: base.baseUrl,
    controlToken: base.controlToken,
  });

  if (command === 'enable-routing' || command === 'become-hub') {
    const config: EnableRoutingConfig = {
      name: base.name,
      seed: base.seed,
      signerLabel: base.signerLabel,
      ...(base.position ? { position: base.position } : {}),
      ...(base.relayUrl ? { relayUrl: base.relayUrl } : {}),
      ...(base.gossipPollMs !== undefined ? { gossipPollMs: base.gossipPollMs } : {}),
      ...(parseOptionalNumber(getArg('--routing-fee-ppm', '')) !== undefined
        ? { routingFeePPM: parseOptionalNumber(getArg('--routing-fee-ppm', '')) }
        : {}),
      ...(parseOptionalBigInt(getArg('--base-fee', '')) !== undefined
        ? { baseFee: parseOptionalBigInt(getArg('--base-fee', '')) }
        : {}),
      ...(parseOptionalNumber(getArg('--swap-taker-fee-bps', '')) !== undefined
        ? { swapTakerFeeBps: parseOptionalNumber(getArg('--swap-taker-fee-bps', '')) }
        : {}),
      initOrderbook: !hasFlag('--no-orderbook'),
    };
    const result = command === 'become-hub'
      ? await becomeHub(client, config)
      : await enableRouting(client, config);
    console.log(serializeTaggedJson({ ok: true, command, result }));
    return;
  }

  if (command === 'setup-custody') {
    const config: SetupCustodyConfig = {
      name: base.name,
      seed: base.seed,
      signerLabel: base.signerLabel,
      ...(base.position ? { position: base.position } : {}),
      ...(base.relayUrl ? { relayUrl: base.relayUrl } : {}),
      ...(base.gossipPollMs !== undefined ? { gossipPollMs: base.gossipPollMs } : {}),
      hubEntityIds: parseIds(getArg('--hub-ids', '')),
      ...(parseOptionalBigInt(getArg('--credit-amount', '')) !== undefined
        ? { creditAmount: parseOptionalBigInt(getArg('--credit-amount', '')) }
        : {}),
      ...(getArg('--credit-token-ids', '').trim()
        ? { creditTokenIds: parseNumbers(getArg('--credit-token-ids', '')) }
        : {}),
      routingEnabled: hasFlag('--routing-enabled'),
      ...(parseOptionalNumber(getArg('--routing-fee-ppm', '')) !== undefined
        ? { routingFeePPM: parseOptionalNumber(getArg('--routing-fee-ppm', '')) }
        : {}),
      ...(parseOptionalBigInt(getArg('--base-fee', '')) !== undefined
        ? { baseFee: parseOptionalBigInt(getArg('--base-fee', '')) }
        : {}),
      ...(parseOptionalNumber(getArg('--swap-taker-fee-bps', '')) !== undefined
        ? { swapTakerFeeBps: parseOptionalNumber(getArg('--swap-taker-fee-bps', '')) }
        : {}),
    };
    const result = await setupCustody(client, config);
    console.log(serializeTaggedJson({ ok: true, command, result }));
    return;
  }

  throw new Error(`Unknown command "${command}"`);
};

run().catch(error => {
  console.error(`[daemon-control] ${(error as Error).stack || (error as Error).message}`);
  process.exit(1);
});
