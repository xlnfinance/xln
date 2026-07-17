export type TokenRegistryReader<T> = {
  getTokenRegistry: () => Promise<T[]>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error);

export const loadJurisdictionTokenRegistry = async <T>(
  reader: TokenRegistryReader<T>,
): Promise<T[]> => {
  try {
    const tokens = await reader.getTokenRegistry();
    if (!Array.isArray(tokens)) throw new Error('TOKEN_REGISTRY_RESPONSE_INVALID');
    return tokens;
  } catch (error) {
    const message = errorMessage(error);
    if (message.startsWith('JURISDICTION_TOKEN_REGISTRY_FAILED:')) throw error;
    throw new Error(`JURISDICTION_TOKEN_REGISTRY_FAILED:${message}`, { cause: error });
  }
};

