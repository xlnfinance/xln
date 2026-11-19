import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Contract, keccak256 } from 'ethers';
import { Depository__factory } from '../../typechain-types';
import { decodeUint768 } from '../../../core/protocol/crypto/abi-money';
import {
  assertCanonicalChainPoint,
  readCanonicalChainPoint,
} from '../../../core/jurisdiction/adapter/stack-manager/receipts';
import { verifyStackBindings } from '../../../core/jurisdiction/adapter/stack-manager/bindings';
import { verifyRoundtripDeployment } from '../usdc-reserve-roundtrip/verification';
import { preflightProvider, runtimeRpc } from './provider';
import { networks, type PreparedIdentities } from './identities';
import { estimatePreparation } from './gas';
import type { JurisdictionConfig } from '../../../core/entity/types';

/** Fresh stores are restricted to unfunded preparation; funded identities must restore their WAL. */
export const assertUnfundedPreparation = async (
  identities: readonly { chainId: number; entityId: string; signerId: string }[],
  jurisdictions: readonly JurisdictionConfig[],
): Promise<void> => {
  for (const chain of networks) {
    const jurisdiction = jurisdictions.find(value => value.chainId === chain.chainId);
    if (!jurisdiction) throw new Error('USDC_PREFLIGHT_FRESH_JURISDICTION_MISSING');
    const provider = preflightProvider(runtimeRpc(chain), chain.chainId);
    try {
      const point = await readCanonicalChainPoint(provider);
      const depository = Depository__factory.connect(jurisdiction.depositoryAddress, provider);
      const token = new Contract(chain.token, ['function balanceOf(address) view returns(uint256)'], provider);
      for (const identity of identities.filter(value => value.chainId === chain.chainId)) {
        const amounts = await Promise.all([
          provider.getBalance(identity.signerId, point.number),
          token.getFunction('balanceOf')(identity.signerId, { blockTag: point.number }),
          depository._reserves(identity.entityId, 1, { blockTag: point.number }),
          depository.entityNonces(identity.entityId, { blockTag: point.number }),
          depository.debtOutstanding(identity.entityId, 1, { blockTag: point.number }).then(decodeUint768),
        ]);
        if (amounts.some(amount => amount !== 0n))
          throw new Error(`USDC_PREFLIGHT_FUNDED_IDENTITY_REQUIRES_RESTORE:${chain.chainId}:${identity.entityId}`);
      }
      await assertCanonicalChainPoint(provider, point);
    } finally {
      provider.destroy();
    }
  }
};

const verifyRuntimeView = async (
  provider: ReturnType<typeof preflightProvider>,
  archive: ReturnType<typeof preflightProvider>,
  verified: Awaited<ReturnType<typeof verifyRoundtripDeployment>>,
) => {
  const point = await readCanonicalChainPoint(provider);
  const manifest = verified.input.manifest;
  if ((await provider.getNetwork()).chainId !== BigInt(manifest.chainId))
    throw new Error('USDC_PREFLIGHT_RUNTIME_CHAIN_MISMATCH');
  const code = await Promise.all(
    Object.entries(manifest.contracts).map(async ([role, address]) => {
      const [expected, actual] = await Promise.all([
        archive.getCode(address, verified.point.number),
        provider.getCode(address, point.number),
      ]);
      if (expected === '0x' || actual !== expected) throw new Error(`USDC_PREFLIGHT_RUNTIME_BYTECODE_MISMATCH:${role}`);
      return { role, address, hash: keccak256(actual) };
    }),
  );
  await verifyStackBindings(provider, manifest, verified.confirmations, point.number);
  await assertCanonicalChainPoint(archive, verified.point);
  return { point, code };
};

export const inspectChain = async (chain: (typeof networks)[number], identities: PreparedIdentities) => {
  const rpc = process.env[chain.env];
  if (!rpc) throw new Error(`USDC_PREFLIGHT_RPC_ENV_REQUIRED:${chain.env}`);
  const archiveProvider = preflightProvider(rpc, chain.chainId);
  const selectedRpc = runtimeRpc(chain);
  const provider = preflightProvider(selectedRpc, chain.chainId);
  try {
    const verified = await verifyRoundtripDeployment(
      {
        network: chain.network,
        chainId: chain.chainId,
        token: chain.token,
        deploymentDir: resolve('jurisdictions/ignition/deployments', chain.deployment),
      },
      archiveProvider,
    );
    const { manifest } = verified.input;
    const token = new Contract(
      chain.token,
      [
        'function balanceOf(address) view returns(uint256)',
        'function decimals() view returns(uint8)',
        'function symbol() view returns(string)',
      ],
      provider,
    );
    const depository = Depository__factory.connect(manifest.contracts.depository, provider);
    const { point, code } = await verifyRuntimeView(provider, archiveProvider, verified);
    const binding = await depository._tokens(1, { blockTag: point.number });
    if (
      binding.contractAddress.toLowerCase() !== chain.token.toLowerCase() ||
      binding.externalTokenId !== 0n ||
      binding.tokenType !== 0n ||
      (await token.getFunction('decimals')({ blockTag: point.number })) !== 6n ||
      (await token.getFunction('symbol')({ blockTag: point.number })) !== 'USDC'
    )
      throw new Error('USDC_PREFLIGHT_RUNTIME_TOKEN_BINDING_MISMATCH');
    const accounts = identities.map(identity => {
      const account = identity.chains.find(value => value.chainId === chain.chainId);
      if (!account) throw new Error('USDC_PREFLIGHT_BALANCE_IDENTITY_MISSING');
      return { role: identity.role, identity: account };
    });
    const balances = await Promise.all(
      accounts.map(async ({ role, identity }) => ({
        role,
        ...identity,
        nativeWei: await provider.getBalance(identity.signerId, point.number),
        token: (await token.getFunction('balanceOf')(identity.signerId, { blockTag: point.number })) as bigint,
        reserve: await depository._reserves(identity.entityId, 1, { blockTag: point.number }),
        debt: decodeUint768(await depository.debtOutstanding(identity.entityId, 1, { blockTag: point.number })),
        entityNonce: await depository.entityNonces(identity.entityId, { blockTag: point.number }),
        eoaNonce: await provider.getTransactionCount(identity.signerId, point.number),
      })),
    );
    const funding = {
      address: manifest.deployer,
      nativeWei: await provider.getBalance(manifest.deployer, point.number),
      token: (await token.getFunction('balanceOf')(manifest.deployer, { blockTag: point.number })) as bigint,
      eoaNonce: await provider.getTransactionCount(manifest.deployer, point.number),
      pendingNonce: await provider.getTransactionCount(manifest.deployer, 'pending'),
    };
    const calls = await estimatePreparation(
      provider,
      chain,
      point.number,
      manifest.deployer,
      manifest.contracts.depository,
      identities,
    );
    await assertCanonicalChainPoint(provider, point);
    return {
      chainId: chain.chainId,
      name: chain.name,
      point,
      deployment: manifest,
      code,
      rpc: {
        archiveFingerprint: createHash('sha256').update(rpc).digest('hex'),
        runtimeFingerprint: createHash('sha256').update(selectedRpc).digest('hex'),
        archivePoint: verified.point,
        separateExplicitRoles: rpc !== selectedRpc,
      },
      verified: {
        sealedArtifacts: true,
        currentArtifacts: true,
        bindings: true,
        confirmations: verified.confirmations,
        inputDigests: verified.input.inputDigests,
      },
      balances,
      funding,
      calls,
      gasPriceWei: await provider.getFeeData().then(value => value.gasPrice),
    };
  } finally {
    provider.destroy();
    archiveProvider.destroy();
  }
};
