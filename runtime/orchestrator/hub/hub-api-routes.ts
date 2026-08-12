import { safeStringify } from '../../protocol/serialization';
import type { HubChild } from '../orchestrator-types';

type HubApiRouteDependencies = {
  host: string;
  getHubChildByEntityId: (entityId: string) => HubChild | null;
  pollAllHubHealth: () => Promise<void>;
  proxyHubApi: (
    request: Request,
    pathname: '/api/faucet/offchain',
  ) => Promise<Response>;
};

export const createHubApiRoutes = (
  dependencies: HubApiRouteDependencies,
): {
  handleHubApiRequest: (
    request: Request,
    url: URL,
    headers: Record<string, string>,
  ) => Promise<Response | null>;
  handleHubAccountRequest: (
    request: Request,
    url: URL,
    headers: Record<string, string>,
  ) => Promise<Response | null>;
} => {
  const findHub = async (entityId: string): Promise<HubChild | null> => {
    const cached = dependencies.getHubChildByEntityId(entityId);
    if (cached) return cached;
    await dependencies.pollAllHubHealth();
    return dependencies.getHubChildByEntityId(entityId);
  };

  const handleHubApiRequest = async (
    request: Request,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response | null> => {
    const inputStatusMatch = url.pathname.match(
      /^\/api\/hub\/runtime-input\/([^/]+)\/status$/,
    );
    if (inputStatusMatch && request.method === 'GET') {
      const hubEntityId = String(
        url.searchParams.get('hubEntityId') || '',
      ).toLowerCase();
      if (!hubEntityId) {
        return new Response(
          safeStringify({
            ok: false,
            error: 'hubEntityId is required',
            code: 'HUB_RUNTIME_INPUT_STATUS_HUB_REQUIRED',
          }),
          { status: 400, headers },
        );
      }
      const child = await findHub(hubEntityId);
      if (!child) {
        return new Response(
          safeStringify({
            ok: false,
            error: `Hub not found for hubEntityId=${hubEntityId}`,
            code: 'HUB_RUNTIME_INPUT_STATUS_HUB_NOT_FOUND',
          }),
          { status: 404, headers },
        );
      }
      const receiptId = encodeURIComponent(
        decodeURIComponent(inputStatusMatch[1] || ''),
      );
      try {
        const response = await fetch(
          `http://${dependencies.host}:${child.apiPort}/api/control/runtime-input/${receiptId}/status`,
        );
        return new Response(await response.text(), {
          status: response.status,
          headers: {
            ...headers,
            'content-type':
              response.headers.get('content-type') || 'application/json',
          },
        });
      } catch (error) {
        return new Response(
          safeStringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: 'HUB_RUNTIME_INPUT_STATUS_PROXY_FAILED',
          }),
          { status: 502, headers },
        );
      }
    }

    return url.pathname === '/api/faucet/offchain' &&
      request.method === 'POST'
      ? dependencies.proxyHubApi(request, '/api/faucet/offchain')
      : null;
  };

  const handleHubAccountRequest = async (
    request: Request,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response | null> => {
    if (
      url.pathname !== '/api/hub/account-status' ||
      request.method !== 'GET'
    ) {
      return null;
    }
    const hubEntityId = String(
      url.searchParams.get('hubEntityId') || '',
    ).toLowerCase();
    const counterpartyEntityId = String(
      url.searchParams.get('counterpartyEntityId') || '',
    ).toLowerCase();
    const child = await findHub(hubEntityId);
    if (!child) {
      return new Response(
        safeStringify({
          success: false,
          code: 'HUB_ACCOUNT_STATUS_HUB_NOT_FOUND',
          error: `Hub not found for hubEntityId=${hubEntityId || 'missing'}`,
        }),
        { status: 404, headers },
      );
    }
    const childUrl = new URL(
      `http://${dependencies.host}:${child.apiPort}/api/account/status`,
    );
    childUrl.searchParams.set('hubEntityId', hubEntityId);
    childUrl.searchParams.set(
      'counterpartyEntityId',
      counterpartyEntityId,
    );
    const tokenIds = String(url.searchParams.get('tokenIds') || '').trim();
    if (tokenIds) childUrl.searchParams.set('tokenIds', tokenIds);
    try {
      const response = await fetch(childUrl);
      return new Response(await response.text(), {
        status: response.status,
        headers: {
          ...headers,
          'content-type':
            response.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error) {
      return new Response(
        safeStringify({
          success: false,
          code: 'HUB_ACCOUNT_STATUS_PROXY_FAILED',
          error: error instanceof Error ? error.message : String(error),
        }),
        { status: 502, headers },
      );
    }
  };

  return { handleHubApiRequest, handleHubAccountRequest };
};
