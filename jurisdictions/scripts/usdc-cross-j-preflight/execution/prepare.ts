import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, keccak256 } from 'ethers';
import { Depository__factory } from '../../../typechain-types';
import { loadJurisdictions } from '../../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import {
  readCanonicalChainPoint,
  assertCanonicalChainPoint,
} from '../../../../core/jurisdiction/adapter/stack-manager/receipts';
import { safeParse, safeStringify } from '../../../../core/protocol/serialization';
import { requireBoundaryRecord, requireExactBoundaryKeys } from '../../../../core/protocol/boundary-validation';
import { computeAccountKey } from '../../../../core/jurisdiction/adapter/events/contract-codec';
import { readExistingIdentities } from '../identities';
import { preflightProvider } from '../provider';
import { candidateHead, candidateDigest, catalogDigest, decodeAuthority } from './authority';
import type { ExecutionConfig } from './config';

const tokenAbi = ['function symbol() view returns(string)', 'function decimals() view returns(uint8)'];

const observeChain = async (config: ExecutionConfig, chainId: number, limits: Record<string, unknown>) => {
  const catalog = Object.values(loadJurisdictions().jurisdictions);
  const chain = catalog.find(value => value.chainId === chainId);
  if (catalog.length !== 2 || !chain) throw new Error('USDC_EXECUTION_CATALOG_INVALID');
  const rpc = config.apiBase + (chainId === 11155111 ? '/rpc' : '/rpc2');
  if (new URL(chain.rpc, config.apiBase).toString() !== rpc) throw new Error('USDC_EXECUTION_CATALOG_RPC_MISMATCH');
  const provider = preflightProvider(rpc, chainId);
  try {
    const point = await readCanonicalChainPoint(provider);
    const depos = Depository__factory.connect(chain.contracts.depository, provider);
    const selected = requireBoundaryRecord(
      requireBoundaryRecord(chain.tokens, 'USDC_EXECUTION_TOKENS')['USDC'],
      'USDC_EXECUTION_USDC',
    );
    const token = String(selected['address']);
    const binding = await depos._tokens(1, { blockTag: point.number });
    const erc20 = new Contract(token, tokenAbi, provider);
    if (
      selected['tokenId'] !== 1 ||
      selected['decimals'] !== 6 ||
      binding.contractAddress.toLowerCase() !== token.toLowerCase() ||
      (await depos.getTokensLength({ blockTag: point.number })) !== 2n ||
      (await erc20.getFunction('decimals')({ blockTag: point.number })) !== 6n ||
      (await erc20.getFunction('symbol')({ blockTag: point.number })) !== 'USDC'
    )
      throw new Error('USDC_EXECUTION_TOKEN_MISMATCH');
    const identities = readExistingIdentities(config.directory);
    const user = identities.find(value => value.role === 'user')!.chains.find(value => value.chainId === chainId)!;
    const hub = identities.find(value => value.role === 'hub')!.chains.find(value => value.chainId === chainId)!;
    if (
      (await depos._reserves(user.entityId, 1, { blockTag: point.number })) !== 0n ||
      (await depos._collaterals(computeAccountKey(user.entityId, hub.entityId), 1, { blockTag: point.number }))
        .collateral !== 0n
    )
      throw new Error('USDC_EXECUTION_EXISTING_POSITION_REQUIRES_ORIGINAL_AUTHORITY');
    const codeHashes: Record<string, string> = {};
    for (const address of [...Object.values(chain.contracts), token])
      if (address) {
        const code = await provider.getCode(address, point.number);
        if (code === '0x') throw new Error('USDC_EXECUTION_CONTRACT_CODE_MISSING');
        codeHashes[address.toLowerCase()] = keccak256(code);
      }
    const roles = chainId === 11155111 ? ['source-user'] : ['target-user', 'target-hub'];
    const payers = [];
    for (const role of roles) {
      const address = role === 'target-hub' ? hub.signerId : user.signerId;
      const firstNonce = await provider.getTransactionCount(address, point.number);
      if (firstNonce !== (await provider.getTransactionCount(address, 'pending')))
        throw new Error('USDC_EXECUTION_PAYER_PENDING');
      const cap = requireBoundaryRecord(limits[role], 'USDC_EXECUTION_PAYER_LIMIT_REQUIRED');
      payers.push({ ...cap, role, address: address.toLowerCase(), firstNonce });
    }
    await assertCanonicalChainPoint(provider, point);
    return {
      chainId,
      anchorNumber: point.number,
      anchorHash: point.hash,
      depository: chain.contracts.depository,
      entityProvider: chain.contracts.entityProvider,
      token,
      userEntity: user.entityId,
      userSigner: user.signerId,
      hubEntity: hub.entityId,
      hubSigner: hub.signerId,
      codeHashes,
      payers,
    };
  } finally {
    provider.destroy();
  }
};

export const prepareExecution = async (config: ExecutionConfig): Promise<void> => {
  const limits = requireBoundaryRecord(
    safeParse(readFileSync(config.limitsPath, 'utf8')),
    'USDC_EXECUTION_LIMITS_INVALID',
  );
  requireExactBoundaryKeys(
    limits,
    ['expiresAt', 'runIds', 'source-user', 'target-user', 'target-hub'],
    [],
    'USDC_EXECUTION_LIMIT_FIELDS_INVALID',
  );
  const chains = [];
  for (const chainId of [11155111, 421614]) chains.push(await observeChain(config, chainId, limits));
  const proposed = {
    version: 1,
    approved: false,
    candidateDigest: candidateDigest(),
    candidateHead: candidateHead(),
    catalogDigest: catalogDigest(join(config.directory, 'jurisdictions.json')),
    expiresAt: limits['expiresAt'],
    apiBase: config.apiBase,
    runIds: limits['runIds'],
    chains,
  };
  decodeAuthority(proposed);
  writeFileSync(config.output, safeStringify(proposed, 2), { flag: 'wx', mode: 0o600 });
  console.log(`USDC_EXECUTION_PREPARED:${config.output}:approved=false:publicBroadcasts=0`);
};
