import type { ExternalWalletApiContext } from './context';
import { createJsonResponse } from './http';

export const handleTokens = async (context: ExternalWalletApiContext): Promise<Response> => {
  if (!context.getJAdapter()) {
    return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
  }
  try {
    return createJsonResponse(context.jsonHeaders, { tokens: await context.getTokenCatalog() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createJsonResponse(context.jsonHeaders, { error: message }, 500);
  }
};
