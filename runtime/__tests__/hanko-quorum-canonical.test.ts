import { beforeEach, describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  clearSignerKeys,
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
  verifyAccountSignature,
} from '../account/crypto';
import { encodeBoard, generateLazyEntityId, hashBoard } from '../entity/factory';
import { buildQuorumHanko, inspectHankoForHash, verifyHankoForHash } from '../hanko/signing';
import { decodeHankoEnvelope, encodeHankoEnvelope } from '../hanko/codec';
import { createEmptyEnv } from '../runtime';
import { createJReplica } from '../scenarios/boot';
import type { ConsensusConfig, EntityReplica, Env, JurisdictionConfig } from '../types';
import { installCanonicalRegisteredBoardAuthority } from './helpers/registration-evidence';

type Fixture = {
  env: Env;
  entityId: string;
  config: ConsensusConfig;
  digest: string;
  signers: string[];
  signatures: string[];
};

const upperHexAddress = (address: string): string => `0x${address.slice(2).toUpperCase()}`;
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

const malleateHighS = (signature: string): string => {
  const compact = signature.slice(2, 130);
  const highS = (SECP256K1_ORDER - BigInt(`0x${compact.slice(64)}`)).toString(16).padStart(64, '0');
  const flippedRecovery = signature.slice(-2) === '00' ? '01' : '00';
  return `0x${compact.slice(0, 64)}${highS}${flippedRecovery}`;
};

const createFixture = (threshold = 2n): Fixture => {
  const seed = 'hanko-quorum-canonical seed alpha beta gamma';
  const env = createEmptyEnv(seed);
  const signers = ['1', '2', '3'].map((slot) => deriveSignerAddressSync(seed, slot).toLowerCase());
  signers.forEach((signer, index) => registerSignerKey(env, signer, deriveSignerKeySync(seed, String(index + 1))));
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold,
    validators: [...signers],
    shares: Object.fromEntries(signers.map((signer) => [signer, 1n])),
  };
  const entityId = generateLazyEntityId(signers, threshold).toLowerCase();
  const digest = ethers.keccak256(ethers.toUtf8Bytes('canonical quorum digest'));
  return {
    env,
    entityId,
    config,
    digest,
    signers,
    signatures: signers.map((signer) => signAccountFrame(env, signer, digest)),
  };
};

const quorum = (
  fixture: Fixture,
  entries: Array<{ signerId: string; signature: string }>,
  config = fixture.config,
): Promise<string> => buildQuorumHanko(fixture.env, fixture.entityId, fixture.digest, entries, config);

const installRegisteredBoardAuthority = async (
  fixture: Fixture,
  entityId: string,
  config: ConsensusConfig,
): Promise<void> => {
  const jurisdiction = config.jurisdiction!;
  const jReplica = createJReplica(fixture.env, jurisdiction.name, jurisdiction.depositoryAddress);
  jReplica.chainId = jurisdiction.chainId;
  jReplica.depositoryAddress = jurisdiction.depositoryAddress;
  jReplica.entityProviderAddress = jurisdiction.entityProviderAddress;
  jReplica.watcherConfirmationDepth = 0;
  const boardHash = hashBoard(encodeBoard(config)).toLowerCase();
  const state = fixture.env.eReplicas.get(`${entityId}:${config.validators[0]}`)!.state;
  await installCanonicalRegisteredBoardAuthority(fixture.env, jurisdiction, state, boardHash);
};

beforeEach(() => clearSignerKeys('hanko-quorum-canonical seed alpha beta gamma'));

describe('canonical quorum Hanko construction', () => {
  test('packs valid signatures in config order regardless of arrival order', async () => {
    const fixture = createFixture();
    const [a, b] = fixture.signers;
    const [sigA, sigB] = fixture.signatures;
    const first = await quorum(fixture, [
      { signerId: b!, signature: sigB! },
      { signerId: a!, signature: sigA! },
    ]);
    const second = await quorum(fixture, [
      { signerId: a!, signature: sigA! },
      { signerId: b!, signature: sigB! },
    ]);

    expect(first).toBe(second);
    expect(await verifyHankoForHash(first, fixture.digest, fixture.entityId, fixture.env))
      .toEqual({ valid: true, entityId: fixture.entityId });
  });

  test('matches validator addresses case-insensitively', async () => {
    const fixture = createFixture(1n);
    const hanko = await quorum(fixture, [{
      signerId: upperHexAddress(fixture.signers[0]!),
      signature: fixture.signatures[0]!,
    }]);

    expect((await verifyHankoForHash(hanko, fixture.digest, fixture.entityId, fixture.env)).valid).toBe(true);
  });

  test('rejects exact and case-variant duplicate signer entries', async () => {
    const fixture = createFixture();
    const [a, b] = fixture.signers;
    const [sigA, sigB] = fixture.signatures;

    await expect(quorum(fixture, [
      { signerId: a!, signature: sigA! },
      { signerId: a!, signature: sigA! },
      { signerId: b!, signature: sigB! },
    ])).rejects.toThrow(/DUPLICATE/i);
    await expect(quorum(fixture, [
      { signerId: a!, signature: sigA! },
      { signerId: upperHexAddress(a!), signature: sigA! },
      { signerId: b!, signature: sigB! },
    ])).rejects.toThrow(/DUPLICATE/i);
  });

  test('rejects case-variant duplicate validators in the config', async () => {
    const fixture = createFixture(1n);
    const signer = fixture.signers[0]!;
    const duplicateConfig: ConsensusConfig = {
      ...fixture.config,
      validators: [signer, upperHexAddress(signer)],
      shares: { [signer]: 1n, [upperHexAddress(signer)]: 1n },
    };

    await expect(quorum(fixture, [{ signerId: signer, signature: fixture.signatures[0]! }], duplicateConfig))
      .rejects.toThrow(/DUPLICATE/i);
  });

  test('requires exactly one explicit share for every validator', async () => {
    const fixture = createFixture();
    const [a, b, c] = fixture.signers;
    const signatures = [
      { signerId: a!, signature: fixture.signatures[0]! },
      { signerId: b!, signature: fixture.signatures[1]! },
    ];

    await expect(quorum(fixture, signatures, {
      ...fixture.config,
      shares: { [a!]: 1n, [b!]: 1n },
    })).rejects.toThrow(/MISSING_SHARE/i);
    await expect(quorum(fixture, signatures, {
      ...fixture.config,
      shares: { ...fixture.config.shares, [`${c}-extra`]: 1n },
    })).rejects.toThrow(/UNKNOWN_SHARE/i);
  });

  test('rejects an unknown signer even when known signatures reach quorum', async () => {
    const fixture = createFixture();
    const [a, b, unknown] = fixture.signers;
    const [sigA, sigB, unknownSig] = fixture.signatures;

    await expect(quorum(fixture, [
      { signerId: a!, signature: sigA! },
      { signerId: b!, signature: sigB! },
      { signerId: unknown!, signature: unknownSig! },
    ], { ...fixture.config, validators: [a!, b!], shares: { [a!]: 1n, [b!]: 1n } }))
      .rejects.toThrow(/UNKNOWN/i);
  });

  test('rejects a signature for another digest or claimed signer', async () => {
    const fixture = createFixture();
    const [a, b] = fixture.signers;
    const [sigA, sigB] = fixture.signatures;
    const wrongDigest = ethers.keccak256(ethers.toUtf8Bytes('wrong quorum digest'));

    await expect(quorum(fixture, [
      { signerId: a!, signature: sigA! },
      { signerId: b!, signature: signAccountFrame(fixture.env, b!, wrongDigest) },
    ])).rejects.toThrow(/SIGNER|DIGEST|RECOVER/i);
    await expect(quorum(fixture, [
      { signerId: a!, signature: sigB! },
      { signerId: b!, signature: sigA! },
    ])).rejects.toThrow(/SIGNER|DIGEST|RECOVER/i);
  });

  test('requires exact 65-byte signatures with canonical recovery bytes', async () => {
    const fixture = createFixture();
    const [a, b] = fixture.signers;
    const [sigA, sigB] = fixture.signatures;
    const recovery = sigB!.slice(-2);
    const malformed = [
      sigB!.slice(0, -2),
      `${sigB}00`,
      `${sigB!.slice(0, -2)}02`,
      `${sigB!.slice(0, -2)}${recovery === '00' ? '01' : '00'}`,
      `${sigB!.slice(0, -2)}${recovery === '00' ? '1b' : '1c'}`,
      malleateHighS(sigB!),
    ];

    expect(verifyAccountSignature(fixture.env, b!, fixture.digest, sigB!)).toBe(true);
    for (const signature of malformed) {
      expect(verifyAccountSignature(fixture.env, b!, fixture.digest, signature)).toBe(false);
      await expect(quorum(fixture, [
        { signerId: a!, signature: sigA! },
        { signerId: b!, signature },
      ])).rejects.toThrow(/SIGNATURE|RECOVERY|LENGTH|CANONICAL|MISMATCH/i);
    }
  });

  test('uses bigint quorum power without precision loss', async () => {
    const fixture = createFixture();
    const [a, b] = fixture.signers;
    const belowThreshold = 9_007_199_254_740_992n;
    const config: ConsensusConfig = {
      ...fixture.config,
      threshold: belowThreshold + 1n,
      validators: [a!, b!],
      shares: { [a!]: belowThreshold, [b!]: 1n },
    };

    await expect(quorum(fixture, [{ signerId: a!, signature: fixture.signatures[0]! }], config))
      .rejects.toThrow(/INSUFFICIENT|QUORUM|THRESHOLD/i);
  });

  test('preserves board powers as bigint through build, inspect, and verify', async () => {
    const fixture = createFixture();
    const signer = fixture.signers[0]!;
    const maximumBoardPower = 65_535n;
    const config: ConsensusConfig = {
      ...fixture.config,
      threshold: maximumBoardPower,
      validators: [signer],
      shares: { [signer]: maximumBoardPower },
    };
    const entityId = generateLazyEntityId([{ name: signer, weight: Number(maximumBoardPower) }], maximumBoardPower);
    const hanko = await buildQuorumHanko(fixture.env, entityId, fixture.digest, [{
      signerId: signer,
      signature: fixture.signatures[0]!,
    }], config);
    const inspected = await inspectHankoForHash(hanko, fixture.digest);

    expect(inspected.claims[0]?.threshold).toBe(maximumBoardPower);
    expect(inspected.claims[0]?.weights).toEqual([maximumBoardPower]);
    expect((await verifyHankoForHash(hanko, fixture.digest, entityId, fixture.env)).valid).toBe(true);
  });

  test('rejects a claim index that cannot be represented safely', async () => {
    const fixture = createFixture(1n);
    const hanko = await quorum(fixture, [{
      signerId: fixture.signers[0]!,
      signature: fixture.signatures[0]!,
    }]);
    const envelope = decodeHankoEnvelope(hanko);
    const claim = envelope.claims[0]!;
    const unsafe = encodeHankoEnvelope({
      ...envelope,
      claims: [{ ...claim, entityIndexes: [BigInt(Number.MAX_SAFE_INTEGER) + 1n] }],
    });

    await expect(inspectHankoForHash(unsafe, fixture.digest)).rejects.toThrow(/INDEX.*OOB/i);
  });

  test('binds lazy and registered entity ids to their canonical boards', async () => {
    const fixture = createFixture();
    const [a, b, c] = fixture.signers;
    const [sigA, sigB, sigC] = fixture.signatures;
    await expect(buildQuorumHanko(fixture.env, `0x${'44'.repeat(32)}`, fixture.digest, [
      { signerId: a!, signature: sigA! },
      { signerId: b!, signature: sigB! },
    ], fixture.config)).rejects.toThrow('BUILD_QUORUM_HANKO_BOARD_UNAVAILABLE');

    const registeredId = ethers.toBeHex(42n, 32);
    const jurisdiction = {
      name: 'Hanko registered board fixture',
      address: 'http://127.0.0.1:8545',
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
      entityProviderDeploymentBlock: 4,
      registrationBlock: 5,
    } satisfies JurisdictionConfig;
    const authoritative = {
      ...fixture.config,
      validators: [a!, b!],
      shares: { [a!]: 1n, [b!]: 1n },
      jurisdiction,
    };
    fixture.env.eReplicas.set(`${registeredId}:${a}`, {
      entityId: registeredId,
      signerId: a!,
      mempool: [],
      isProposer: true,
      state: { entityId: registeredId, config: authoritative },
    } as unknown as EntityReplica);
    await installRegisteredBoardAuthority(fixture, registeredId, authoritative);
    await expect(buildQuorumHanko(fixture.env, registeredId, fixture.digest, [
      { signerId: a!, signature: sigA! },
      { signerId: c!, signature: sigC! },
    ], { ...authoritative, validators: [a!, c!], shares: { [a!]: 1n, [c!]: 1n } }))
      .rejects.toThrow(/BOARD.*MISMATCH/i);
  });

  test('fails when a non-signer cannot be encoded as a placeholder', async () => {
    const fixture = createFixture(1n);
    const signer = fixture.signers[0]!;
    const config: ConsensusConfig = {
      ...fixture.config,
      validators: [signer, 'validator-without-address'],
      shares: { [signer]: 1n, 'validator-without-address': 1n },
    };

    await expect(quorum(fixture, [{ signerId: signer, signature: fixture.signatures[0]! }], config))
      .rejects.toThrow(/PLACEHOLDER|ADDRESS/i);
  });
});
