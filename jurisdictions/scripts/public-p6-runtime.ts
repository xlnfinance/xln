#!/usr/bin/env bun
// Public Sepolia: capture real Account signatures, appoint the tower, go offline,
// then recover the same Runtime after the external tower has finalized its exit.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HDNodeWallet, JsonRpcProvider, getBytes, isAddress } from 'ethers';
import type { EntityTx, RuntimeInput } from '../../core/api/public/runtime-module';
import { withRuntimeCommittedRead } from '../../core/runtime/frame/lifecycle/writer-lock';
import { accountNetBalance } from '../../frontend/src/lib/utils/ui/accountBalance';
import { safeStringify } from '../../core/protocol/serialization';
import { assertCanonicalRpcContractStack } from '../../core/orchestrator/bootstrap/contract-readiness';

const mode = process.argv[2];
if (mode !== 'prepare' && mode !== 'recover') throw Error('PUBLIC_P6_MODE_REQUIRED');
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
const tree = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' });
if (source.exitCode !== 0 || tree.exitCode !== 0 || tree.stdout.length) throw Error('PUBLIC_P6_CLEAN_SOURCE_REQUIRED');
const sourceSha = source.stdout.toString().trim();
const seed = process.env['PUBLIC_P6_MNEMONIC'];
const data = process.env['PUBLIC_P6_DATA'];
if (!seed || !data || !resolve(data).includes('/sepolia-p6-')) throw Error('PUBLIC_P6_DEDICATED_IDENTITY_REQUIRED');
const directory = resolve(data);
mkdirSync(directory, { recursive: true, mode: 0o700 });
process.env['NODE_ENV'] = 'production';
process.env['XLN_HLT_ENGINE'] = 'ts';
process.env['XLN_DB_PATH'] = `${directory}/db`;
const xln = await import('../../core/runtime');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('PUBLIC_P6_CONFIG_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
};
const configuration: unknown = JSON.parse(readFileSync('jurisdictions/jurisdictions.json', 'utf8'));
const configured = object(object(object(configuration).jurisdictions)['ethereum-sepolia']);
const rawContracts = object(configured.contracts);
const address = (key: string): string => {
  const value = rawContracts[key];
  if (typeof value !== 'string' || !isAddress(value)) throw Error(`PUBLIC_P6_CONTRACT_INVALID:${key}`);
  return value;
};
const contracts = {
  account: address('account'),
  entityProvider: address('entityProvider'),
  depository: address('depository'),
  deltaTransformer: address('deltaTransformer'),
};
const rpc = configured.rpc;
const name = configured.name;
if (configured.chainId !== 11155111 || typeof rpc !== 'string' || typeof name !== 'string')
  throw Error('PUBLIC_P6_SEPOLIA_REQUIRED');
const url = 'https://sepolia.xln.finance';
const hub = '0x2d08d3bb8f4102fb07fecef0b59f052139c99aa996239ebfc55baac82ac54dd6';
const signer = HDNodeWallet.fromPhrase(seed);
const signerId = signer.address.toLowerCase();
const entityId = xln.generateLazyEntityId([signerId], 1n).toLowerCase();
xln.registerSignerKey(seed, signerId, getBytes(signer.privateKey));
const env = await xln.main(seed, { numericSignerPrewarmCount: 1 });
const provider = new JsonRpcProvider(rpc, 11155111, { cacheTimeout: -1 });
const state = () => [...env.state.eReplicas.values()].find(value => value.entityId === entityId)?.state;
const account = () => {
  const value = state()?.accounts.get(hub);
  if (!value) throw Error('PUBLIC_P6_ACCOUNT_MISSING');
  return value;
};
const balance = () => {
  const a = account();
  const delta = a.state.deltas.get(1);
  if (!delta) throw Error('PUBLIC_P6_TOKEN_MISSING');
  return accountNetBalance(xln.deriveDelta(delta, a.state.leftEntity === entityId));
};
const send = (input: RuntimeInput) => {
  xln.validateRuntimeInputAdmission(env, input);
  xln.enqueueRuntimeInput(env, input);
};
const entity = (entityTxs: EntityTx[]) => send({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }] });
const wait = async (label: string, ready: () => boolean) => {
  const end = Date.now() + 60_000;
  while (!ready()) {
    if (env.infrastructure?.halted || Date.now() > end) throw Error(`PUBLIC_P6_WAIT_FAILED:${label}`);
    await Bun.sleep(100);
  }
  console.log(safeStringify({ stage: label, height: env.state.height }));
};
const proof = () => {
  const a = account();
  if (a.pendingFrame || a.mempool.length) throw Error('PUBLIC_P6_ACCOUNT_NOT_QUIESCENT');
  const body = xln.buildAccountProofBodyFromJurisdictions(env.state, a);
  if (
    !a.currentDisputeProofNonce ||
    !a.currentDisputeProofHanko ||
    a.currentDisputeProofProposerIsLeft === undefined ||
    body.proofBodyHash !== a.currentDisputeProofBodyHash
  )
    throw Error('PUBLIC_P6_SIGNED_PROOF_MISSING');
  return {
    entityId,
    nonce: a.currentDisputeProofNonce,
    sig: a.currentDisputeProofHanko,
    proposerIsLeft: a.currentDisputeProofProposerIsLeft,
    hash: body.proofBodyHash,
    body: body.proofBodyStruct,
  };
};
const post = async (path: string, body: unknown) => {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error(`PUBLIC_P6_HTTP_FAILED:${path}:${response.status}:${await response.text()}`);
};
const stop = async () => {
  await xln.stopJurisdictionWatchersAndWait(env);
  await xln.stopP2PAndWait(env);
  await xln.stopRuntimeLoopAndWait(env);
};
try {
  if ((await provider.getNetwork()).chainId !== 11155111n) throw Error('PUBLIC_P6_WRONG_CHAIN');
  await assertCanonicalRpcContractStack(rpc, contracts, 'PUBLIC_P6', 10_000);
  if (mode === 'prepare' && (env.state.height !== 0 || (await Bun.file(`${directory}/prepared.json`).exists())))
    throw Error('PUBLIC_P6_PREPARE_REQUIRES_FRESH_RUNTIME');
  if (mode === 'recover' && !state()) throw Error('PUBLIC_P6_RECOVERY_STATE_MISSING');
  env.quietRuntimeLogs = true;
  xln.startRuntimeLoop(env, {
    onFatal: async failure => {
      console.error('PUBLIC_P6_RUNTIME_FATAL', failure.message);
    },
  });
  if (!env.state.jReplicas.has(name)) {
    const deploymentBlock = configured.entityProviderDeploymentBlock;
    if (typeof deploymentBlock !== 'number' || !Number.isSafeInteger(deploymentBlock))
      throw Error('PUBLIC_P6_DEPLOYMENT_BLOCK_REQUIRED');
    send({
      runtimeTxs: [
        {
          type: 'importJ',
          data: {
            name,
            chainId: 11155111,
            ticker: 'ETH',
            rpcs: [rpc],
            blockTimeMs: 12_000,
            entityProviderDeploymentBlock: deploymentBlock,
            contracts,
          },
        },
      ],
      entityInputs: [],
    });
    await wait('jurisdiction-imported', () => env.state.jReplicas.has(name));
  }
  if (!state()) {
    send({
      runtimeTxs: [
        xln.importEntity({
          entityId,
          signerId,
          entitySeed: seed,
          data: {
            isProposer: true,
            profileName: 'Public P6 proof',
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: {
                address: `jreplica://${name}`,
                name,
                chainId: 11155111,
                blockTimeMs: 12_000,
                entityProviderAddress: contracts.entityProvider,
                depositoryAddress: contracts.depository,
              },
            },
          },
        }),
      ],
      entityInputs: [],
    });
    await wait('entity-imported', () => Boolean(state()));
  }
  xln.startP2P(env, {
    signerId: String(env.runtimeId),
    relayUrls: ['wss://sepolia.xln.finance/relay'],
    gossipPollMs: 2000,
  });
  await wait('relay-connected', () => xln.getP2P(env)?.isConnected() === true);
  await xln.ensureGossipProfiles(env, [hub]);
  await wait(
    'chain-caught-up',
    () => env.infrastructure?.lifecyclePhase === 'running' && env.infrastructure.entityInputsReady !== false,
  );
  if (mode === 'recover') {
    await wait(
      'tower-finalization-observed',
      () =>
        (state()?.reserves.get(1) ?? 0n) === 100_000_000n &&
        account().state.deltas.get(1)?.collateral === 0n &&
        !account().activeDispute,
    );
    const integrity = await xln.verifyLiveRuntimeStorage(env);
    await Bun.write(
      `${directory}/recovered.json`,
      safeStringify(
        {
          sourceSha,
          entityId,
          runtimeId: env.runtimeId,
          height: env.state.height,
          reserve: state()!.reserves.get(1),
          collateral: account().state.deltas.get(1)!.collateral,
          integrity,
        },
        2,
      ),
    );
  } else {
    entity([
      {
        type: 'openAccount',
        data: {
          targetEntityId: hub,
          creditAmount: 0n,
          tokenId: 1,
          disputeConfig: { leftResponseSeconds: 180, rightResponseSeconds: 180 },
        },
      },
    ]);
    await wait('account-open', () => Boolean(state()?.accounts.get(hub)?.currentFrame) && !account().pendingFrame);
    await post('/api/faucet/gas', { userAddress: signerId, jurisdiction: name });
    await post('/api/faucet/reserve', { userEntityId: entityId, tokenId: 1, tokenSymbol: 'USDT', amount: '100' });
    await wait('reserve-funded', () => state()?.reserves.get(1) === 100_000_000n);
    entity([
      { type: 'r2c', data: { counterpartyId: hub, tokenId: 1, amount: 100_000_000n } },
      { type: 'j_broadcast', data: {} },
    ]);
    await wait('collateral-funded', () => balance() === 100_000_000n && !account().pendingFrame);
    entity([
      {
        type: 'directPayment',
        data: {
          targetEntityId: hub,
          tokenId: 1,
          amount: 25_000_000n,
          route: [entityId, hub],
          deliveryMode: 'direct',
          description: 'Public P6 stale proof',
        },
      },
    ]);
    await wait(
      'old-state-signed',
      () => balance() === 75_000_000n && !account().pendingFrame && account().mempool.length === 0,
    );
    const stale = proof();
    await post('/api/faucet/offchain', {
      userEntityId: entityId,
      userRuntimeId: env.runtimeId,
      hubEntityId: hub,
      tokenId: 1,
      amount: '25',
    });
    await wait(
      'new-state-signed',
      () => balance() === 100_000_000n && !account().pendingFrame && account().mempool.length === 0,
    );
    const latest = proof();
    if (latest.nonce <= stale.nonce || latest.hash === stale.hash) throw Error('PUBLIC_P6_PROOF_DID_NOT_ADVANCE');
    const healthResponse = await fetch(`${url}/api/tower/healthz`);
    const health = object(await healthResponse.json());
    const sweep = object(health.sweep);
    if (
      !healthResponse.ok ||
      health.ok !== true ||
      sweep.enabled !== true ||
      typeof health.signerAddress !== 'string' ||
      !isAddress(health.signerAddress)
    )
      throw Error('PUBLIC_P6_TOWER_UNAVAILABLE');
    const uploaded = await withRuntimeCommittedRead(env, async () => {
      const frame = await xln.readPersistedFrameJournal(env, env.state.height);
      if (!frame) throw Error('PUBLIC_P6_FRAME_MISSING');
      const bundle = xln.buildRuntimeRecoveryBundle(env, {
        kind: 'snapshot',
        frames: [frame],
        signers: [{ index: 0, derivationIndex: 0, address: signerId, name: 'Public P6', entityId, jurisdiction: name }],
        meta: { label: 'Public P6' },
      });
      const encryptedBundle = await xln.encryptRuntimeRecoveryBundle(bundle, seed);
      return xln.buildDelayedLastResortAppointments(
        {
          runtimeId: String(env.runtimeId).toLowerCase(),
          seed,
          jReplicas: env.state.jReplicas,
          tower: { url },
          towerSignerAddress: String(health.signerAddress),
          encryptedBundle,
        },
        [
          {
            entityId,
            signerDerivationIndex: 0,
            chainId: 11155111,
            depositoryAddress: contracts.depository,
            rpcUrl: rpc,
            entityState: state()!,
          },
        ],
      );
    });
    if (uploaded.failures.length || uploaded.uploads.length !== 1)
      throw Error(`PUBLIC_P6_APPOINTMENT_BUILD_FAILED:${safeStringify(uploaded.failures)}`);
    const appointment = uploaded.uploads[0]!.appointment;
    const response = await fetch(`${url}/api/tower/appointment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(appointment),
    });
    const accepted = object(await response.json());
    const receipt = object(accepted.receipt);
    if (
      !response.ok ||
      accepted.ok !== true ||
      receipt.bundleHash !== appointment.bundle.bundleHash ||
      receipt.lookupKey !== appointment.lookupKey ||
      receipt.appointmentSequence !== appointment.lastResortPayload!.appointmentSequence
    )
      throw Error('PUBLIC_P6_APPOINTMENT_RECEIPT_MISMATCH');
    await stop();
    const ownerNonce = await provider.getTransactionCount(signerId);
    await Bun.write(
      `${directory}/prepared.json`,
      safeStringify(
        {
          sourceSha,
          entityId,
          runtimeId: env.runtimeId,
          signerId,
          hub,
          contracts,
          rpc,
          stale,
          latest,
          peerNonce: account().counterpartyDisputeProofNonce,
          ownerNonce,
          tower: health.signerAddress,
          receipt,
          height: env.state.height,
          collateral: account().state.deltas.get(1)!.collateral,
          amount: balance(),
        },
        2,
      ),
    );
    console.log(
      safeStringify({
        stage: 'wallet-offline-and-appointed',
        entityId,
        height: env.state.height,
        oldNonce: stale.nonce,
        latestNonce: latest.nonce,
        peerNonce: account().counterpartyDisputeProofNonce,
        ownerNonce,
      }),
    );
  }
} finally {
  await stop();
  await xln.closeRuntimeDb(env);
  await xln.closeInfraDb(env);
  provider.destroy();
}
