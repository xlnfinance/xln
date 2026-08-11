/**
 * Canonical WebSocket send-result contract shared by every server transport.
 *
 * Bun's ServerWebSocket reports `-1` when bytes were accepted into its
 * backpressure queue and `0` when the payload was dropped. Browser/client
 * sockets return `void`; test and adapter sockets may return booleans. Keeping
 * this classification in one module prevents a queued financial envelope from
 * being retried through a fallback route and delivered twice.
 */

export type WebSocketSendResult = boolean | number | void;

type WebSocketSendDisposition = 'accepted' | 'backpressured' | 'dropped';

export const classifyWebSocketSendResult = (
  result: WebSocketSendResult,
): WebSocketSendDisposition => {
  if (result === false || result === 0) return 'dropped';
  if (result === -1) return 'backpressured';
  if (result === true || result === undefined) return 'accepted';
  if (typeof result === 'number' && Number.isFinite(result) && result > 0) return 'accepted';
  throw new Error(`WEBSOCKET_SEND_RESULT_INVALID: ${String(result)}`);
};
