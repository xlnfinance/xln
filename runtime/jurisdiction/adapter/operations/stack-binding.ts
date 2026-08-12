import { ethers } from 'ethers';

type DepositoryEntityProviderReader = {
  entityProvider(): Promise<string>;
  getAddress(): Promise<string>;
};

export const canonicalJStackAddress = (label: string, value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`J_STACK_ADDRESS_INVALID:${label}:${raw || 'missing'}`);
  }
  return ethers.getAddress(raw);
};

export const assertJStackAddressMatch = (
  context: string,
  expected: unknown,
  actual: unknown,
): void => {
  const canonicalExpected = canonicalJStackAddress(`${context}:expected`, expected);
  const canonicalActual = canonicalJStackAddress(`${context}:actual`, actual);
  if (canonicalExpected !== canonicalActual) {
    throw new Error(
      `J_STACK_CONNECTED_ADDRESS_MISMATCH:${context}` +
      `:expected=${canonicalExpected}:actual=${canonicalActual}`,
    );
  }
};

/**
 * Proves the configured watcher carrier is the authority contract selected by
 * Depository itself. Merely finding bytecode at both addresses is insufficient:
 * an attacker can point replica metadata at a second live EntityProvider and
 * make validators observe a registration history Depository never authorizes.
 */
export const assertDepositoryEntityProviderBinding = async (
  context: string,
  depository: DepositoryEntityProviderReader,
  configuredEntityProvider: unknown,
): Promise<void> => {
  const depositoryAddress = canonicalJStackAddress(
    `${context}:depository`,
    await depository.getAddress(),
  );
  const configured = canonicalJStackAddress(
    `${context}:configured_entity_provider`,
    configuredEntityProvider,
  );
  const linked = canonicalJStackAddress(
    `${context}:linked_entity_provider`,
    await depository.entityProvider(),
  );
  if (linked !== configured) {
    throw new Error(
      `J_STACK_ENTITY_PROVIDER_MISMATCH:${context}` +
      `:depository=${depositoryAddress}:configured=${configured}:linked=${linked}`,
    );
  }
};
