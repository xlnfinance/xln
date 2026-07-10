import { json } from '@sveltejs/kit';
import {
  assistantOfflineResponse,
  sanitizeXlnAssistantCatalog,
  xlnAssistantUpstreamUrl,
} from '$lib/server/xln-assistant-proxy';

export const GET = async (): Promise<Response> => {
  try {
    const response = await fetch(`${xlnAssistantUpstreamUrl()}/api/models`, {
      signal: AbortSignal.timeout(2_500),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return assistantOfflineResponse();
    return json(sanitizeXlnAssistantCatalog(await response.json()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return assistantOfflineResponse();
  }
};
