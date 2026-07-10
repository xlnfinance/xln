import { json } from '@sveltejs/kit';
import {
  assistantOfflineResponse,
  parseXlnAssistantProxyRequest,
  xlnAssistantUpstreamUrl,
} from '$lib/server/xln-assistant-proxy';

export const POST = async ({ request }: { request: Request }): Promise<Response> => {
  let body;
  try {
    body = parseXlnAssistantProxyRequest(await request.json());
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : 'Invalid assistant request.' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${xlnAssistantUpstreamUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!upstream.ok || !upstream.body) return assistantOfflineResponse();
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
      },
    });
  } catch {
    return assistantOfflineResponse();
  }
};
