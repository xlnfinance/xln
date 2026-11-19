import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, keccak256, type JsonRpcProvider } from 'ethers';
import { Depository__factory } from '../../../typechain-types';
import { generateLazyEntityId } from '../../../../core/entity/factory';
import { decodeJurisdictionsData } from '../../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import {
  readCanonicalChainPoint,
  assertCanonicalChainPoint,
} from '../../../../core/jurisdiction/adapter/stack-manager/receipts';
import { decodeUint768 } from '../../../../core/protocol/crypto/abi-money';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../core/protocol/boundary-validation';
import { safeParse, safeStringify } from '../../../../core/protocol/serialization';
import { candidateHead, candidateDigest, catalogDigest } from '../execution/authority';
import { money } from '../execution/boundary';
import { readExistingIdentities } from '../identities';
import {
  decodeFundingAuthority,
  decodeFundingLimit,
  fundingSlots,
  type FundingChain,
  type FundingLimit,
} from './authority';
import { fundingProviders } from './providers';
import { fundingTransfer } from './wires';
import type { FundingConfig } from './config';

const estimateFundingCalls = async (provider: JsonRpcProvider, chain: FundingChain) => {
  const estimates = [];
  for (const { stage, cap, valueWei } of fundingSlots(chain.limits)) {
    if (stage === 'deposit') {
      estimates.push([
        stage,
        {
          status: 'conditional-cap',
          gasLimit: cap.gasLimit,
          reason: 'Exact authorized Hanko and confirmed allowance are required before deposit estimation.',
        },
      ] as const);
      continue;
    }
    const call = fundingTransfer(chain, stage);
    const gas = await provider.estimateGas({ from: chain.funder.address, ...call, value: valueWei });
    if (gas > cap.gasLimit) throw new Error(`USDC_FUNDING_ESTIMATE_EXCEEDS_LIMIT:${chain.chainId}:${stage}:${gas}`);
    estimates.push([stage, gas] as const);
  }
  return Object.fromEntries(estimates);
};

const observe = async (config: FundingConfig, limit: FundingLimit, rawLimit: unknown, expectedHubReserve: bigint) => {
  const catalog = Object.values(
    decodeJurisdictionsData(safeParse(readFileSync(config.catalogPath, 'utf8'))).jurisdictions,
  );
  const chain = catalog.find(value => value.chainId === limit.chainId);
  if (catalog.length !== 2 || !chain) throw new Error('USDC_FUNDING_CATALOG_INVALID');
  const identities = readExistingIdentities(config.directory, config.userVault);
  if (identities.some(role => role.chains.some(identity => identity.signerId === config.funder)))
    throw new Error('USDC_FUNDING_OPERATOR_SIGNER_CANNOT_BE_FUNDER');
  const hub = identities.find(role => role.role === 'hub')!.chains.find(value => value.chainId === limit.chainId)!;
  const user = identities.find(role => role.role === 'user')!.chains.find(value => value.chainId === limit.chainId)!;
  if (limit.userFunding && limit.userFunding.signer !== user.signerId)
    throw new Error('USDC_FUNDING_VAULT_BINDING_MISMATCH');
  const configured = requireBoundaryRecord(chain.tokens, 'USDC_FUNDING_TOKENS');
  const selected = requireBoundaryRecord(configured['USDC'], 'USDC_FUNDING_USDC');
  const token = String(selected['address']).toLowerCase();
  const providers = fundingProviders(limit.chainId, 'read');
  const provider = providers.current;
  try {
    const point = await readCanonicalChainPoint(provider);
    const depos = Depository__factory.connect(chain.contracts.depository, provider);
    const usdc = new Contract(
      token,
      [
        'function decimals() view returns(uint8)',
        'function symbol() view returns(string)',
        'function balanceOf(address) view returns(uint256)',
      ],
      provider,
    );
    const registryToken = await depos._tokens(1, { blockTag: point.number });
    if (
      (await provider.getNetwork()).chainId !== BigInt(limit.chainId) ||
      Object.keys(configured).length !== 1 ||
      selected['tokenId'] !== 1 ||
      selected['decimals'] !== 6 ||
      registryToken.contractAddress.toLowerCase() !== token ||
      (await depos.getTokensLength({ blockTag: point.number })) !== 2n ||
      (await usdc.getFunction('symbol')({ blockTag: point.number })) !== 'USDC' ||
      (await usdc.getFunction('decimals')({ blockTag: point.number })) !== 6n
    )
      throw new Error('USDC_FUNDING_TOKEN_BINDING_INVALID');
    const codeHashes: Record<string, string> = {};
    for (const address of [...Object.values(chain.contracts), token])
      if (address) {
        const code = await provider.getCode(address, point.number);
        if (code === '0x') throw new Error('USDC_FUNDING_CODE_MISSING');
        codeHashes[address.toLowerCase()] = keccak256(code);
      }
    const at = { blockTag: point.number };
    const funderEntity = generateLazyEntityId([config.funder], 1n).toLowerCase();
    const firstNonce = await provider.getTransactionCount(config.funder, point.number);
    if (firstNonce !== (await provider.getTransactionCount(config.funder, 'pending')))
      throw new Error('USDC_FUNDING_PAYER_PENDING');
    const hubReserveBefore = await depos._reserves(hub.entityId, 1, at);
    if (hubReserveBefore !== expectedHubReserve)
      throw new Error(
        `USDC_FUNDING_RESERVE_BASELINE_MISMATCH:${limit.chainId}:${expectedHubReserve}:${hubReserveBefore}`,
      );
    if (decodeUint768(await depos.debtOutstanding(hub.entityId, 1, at)) !== 0n)
      throw new Error('USDC_FUNDING_HUB_DEBT_OUTSTANDING');
    const funderNativeWei = await provider.getBalance(config.funder, point.number);
    const funderUsdc = BigInt(await usdc.getFunction('balanceOf')(config.funder, at));
    if (
      funderUsdc < limit.amount + (limit.userFunding?.usdcAtoms ?? 0n) ||
      funderNativeWei < limit.totalNativeOutflowLimitWei
    )
      throw new Error('USDC_FUNDING_PAYER_BALANCE_INSUFFICIENT');
    const binding: FundingChain = {
      chainId: limit.chainId,
      anchorNumber: point.number,
      anchorHash: point.hash,
      depository: chain.contracts.depository.toLowerCase(),
      entityProvider: chain.contracts.entityProvider.toLowerCase(),
      token,
      codeHashes,
      funder: { address: config.funder, firstNonce },
      funderEntity,
      entityNonce: await depos.entityNonces(funderEntity, at),
      hubEntity: hub.entityId,
      hubSigner: hub.signerId,
      hubReserveBefore,
      limits: limit,
    };
    const gas = await estimateFundingCalls(provider, binding);
    await assertCanonicalChainPoint(provider, point);
    return {
      authority: {
        ...binding,
        entityNonce: String(binding.entityNonce),
        hubReserveBefore: String(hubReserveBefore),
        limits: rawLimit,
      },
      observation: {
        chainId: limit.chainId,
        point,
        funderNativeWei,
        funderUsdc,
        hubReserveBefore,
        gas,
      },
    };
  } finally {
    provider.destroy();
    providers.historical.destroy();
  }
};

export const prepareFunding = async (config: FundingConfig): Promise<void> => {
  const limits = requireBoundaryRecord(
    safeParse(readFileSync(config.limitsPath, 'utf8')),
    'USDC_FUNDING_LIMITS_INVALID',
  );
  requireExactBoundaryKeys(limits, ['expiresAt', 'chains'], [], 'USDC_FUNDING_LIMITS_FIELDS');
  if (!Array.isArray(limits['chains']) || limits['chains'].length < 1 || limits['chains'].length > 2)
    throw new Error('USDC_FUNDING_CHAIN_LIMITS_REQUIRED');
  const fingerprint = candidateDigest();
  const observations = [];
  for (const raw of limits['chains']) {
    const { expectedHubReserve = '0', ...rawLimit } = requireBoundaryRecord(raw, 'USDC_FUNDING_LIMIT_INVALID');
    observations.push(await observe(config, decodeFundingLimit(rawLimit), rawLimit, money(expectedHubReserve)));
  }
  if (fingerprint !== candidateDigest()) throw new Error('USDC_FUNDING_CANDIDATE_CHANGED');
  const proposed = {
    version: 2,
    operation: 'operator-funding',
    approved: false,
    candidateHead: candidateHead(),
    candidateDigest: fingerprint,
    catalogDigest: catalogDigest(config.catalogPath),
    expiresAt: limits['expiresAt'],
    chains: observations.map(value => value.authority),
  };
  decodeFundingAuthority(proposed);
  writeFileSync(config.output, safeStringify(proposed, 2), { mode: 0o600, flag: 'wx' });
  console.log(
    safeStringify(
      {
        status: 'prepared-unapproved',
        output: config.output,
        observations: observations.map(value => value.observation),
        publicBroadcasts: 0,
      },
      2,
    ),
  );
};
