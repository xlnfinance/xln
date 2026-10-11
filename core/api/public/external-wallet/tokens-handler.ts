import type { ExternalWalletApiContext } from './context';
import { createJsonResponse } from './http';

export const handleTokens = async (context: ExternalWalletApiContext, request?: Request): Promise<Response> => {
  const entityId = request ? (new URL(request.url).searchParams.get('entityId') ?? undefined) : undefined;
  if (entityId !== undefined && !/^0x[0-9a-f]{64}$/i.test(entityId))
    return createJsonResponse(context.jsonHeaders, { error: 'Invalid entityId' }, 400);
  if (!context.getJAdapter(entityId)) {
    return createJsonResponse(context.jsonHeaders, { error: 'J-adapter not initialized' }, 503);
  }
  try {
    return createJsonResponse(context.jsonHeaders, { tokens: await context.getTokenCatalog(entityId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createJsonResponse(context.jsonHeaders, { error: message }, 500);
  }
};
