import { JsonRpcProvider, id, keccak256, toUtf8Bytes } from 'ethers';

const GOVERNANCE_DOMAINS = {
  BOARD_PROPOSAL_DOMAIN: 'XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V1',
  BOARD_PROPOSAL_CANCEL_DOMAIN: 'XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_CANCEL_V1',
} as const;

export type EntityProviderGovernanceDomains = Readonly<Record<keyof typeof GOVERNANCE_DOMAINS, string>>;

export const expectedEntityProviderGovernanceDomains = (): EntityProviderGovernanceDomains =>
  Object.fromEntries(Object.entries(GOVERNANCE_DOMAINS).map(([name, domain]) => [
    name,
    keccak256(toUtf8Bytes(domain)).toLowerCase(),
  ])) as EntityProviderGovernanceDomains;

export const assertEntityProviderGovernanceDomains = (
  actual: EntityProviderGovernanceDomains,
): void => {
  const expected = expectedEntityProviderGovernanceDomains();
  for (const name of Object.keys(GOVERNANCE_DOMAINS) as Array<keyof typeof GOVERNANCE_DOMAINS>) {
    const received = String(actual[name] || '').toLowerCase();
    if (received !== expected[name]) {
      throw new Error(`ENTITY_PROVIDER_GOVERNANCE_DOMAIN_MISMATCH:${name}:${expected[name]}:${received}`);
    }
  }
};

export const readEntityProviderGovernanceDomains = async (
  rpcUrl: string,
  entityProvider: string,
): Promise<EntityProviderGovernanceDomains> => {
  const provider = new JsonRpcProvider(rpcUrl);
  const read = async (name: keyof typeof GOVERNANCE_DOMAINS): Promise<string> =>
    provider.call({ to: entityProvider, data: id(`${name}()`).slice(0, 10) });
  return {
    BOARD_PROPOSAL_DOMAIN: await read('BOARD_PROPOSAL_DOMAIN'),
    BOARD_PROPOSAL_CANCEL_DOMAIN: await read('BOARD_PROPOSAL_CANCEL_DOMAIN'),
  };
};

export const verifyEntityProviderGovernanceDomains = async (
  rpcUrl: string,
  entityProvider: string,
): Promise<void> => {
  assertEntityProviderGovernanceDomains(
    await readEntityProviderGovernanceDomains(rpcUrl, entityProvider),
  );
};
