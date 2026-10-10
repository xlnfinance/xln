import { createStructuredLogger } from '../../support/logger';
import { pushDebugEvent, removeClient, type RelayStore } from '../../network/relay/store';
import {
  forgetRelaySocketRuntimeId,
  isRelaySocketAuthenticated,
  relayRoute,
  type RelayRouterConfig,
} from '../../network/relay/router';
import { resolveRuntimeWsMaxMessageBytes, serializeWsMessage, toRuntimeWsBytes } from '../../network/p2p/ws-protocol';
import type { createHelloChallengeRegistry } from '../../network/p2p/auth/hello-challenge';
import type { MarketSubscriptionStack } from '../../network/relay/market/subscription-types';
import { encodeMarketWireMessage } from '../../network/relay/market/wire';
import { decodeRelaySocketFrame } from '../../api/server/network/relay-frame';
import type { OrchestratorWebSocket } from '../orchestrator-types';

type RelaySocketDeps = Readonly<{
  relayStore: RelayStore;
  relayHelloChallenges: ReturnType<typeof createHelloChallengeRegistry>;
  marketSubscriptionStack: MarketSubscriptionStack<OrchestratorWebSocket>;
  routerConfig: RelayRouterConfig;
}>;

const meshLog = createStructuredLogger('mesh.orchestrator');
const serializeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const createOrchestratorRelaySocketHandlers = (
  deps: RelaySocketDeps,
): Bun.WebSocketHandler<OrchestratorWebSocket['data']> => {
  const { relayStore, relayHelloChallenges, marketSubscriptionStack, routerConfig } = deps;
  const cleanupRpcMarketSubscription = (ws: OrchestratorWebSocket): void => marketSubscriptionStack.cleanup(ws);
  return {
    maxPayloadLength: resolveRuntimeWsMaxMessageBytes(),
    open(ws) {
      const relayWs = ws;
      if (relayWs.data.type === 'relay') relayHelloChallenges.issue(relayWs, relayWs.data.audience);
      pushDebugEvent(relayStore, {
        event: 'ws_open',
        details: { wsType: relayWs.data.type },
      });
    },
    message(ws, raw) {
      try {
        const frame = decodeRelaySocketFrame(raw, isRelaySocketAuthenticated(ws));
        if (frame.kind === 'market') {
          const marketMessage = frame.message;
          Promise.resolve(marketSubscriptionStack.handleMessage(ws, marketMessage)).catch(error => {
            const reason = serializeError(error);
            pushDebugEvent(relayStore, {
              event: 'error',
              reason: 'MARKET_HANDLER_EXCEPTION',
              details: { error: reason, msgType: marketMessage.type },
            });
            meshLog.error('relay.market_handler_exception', { error: reason, msgType: marketMessage.type });
            // The peer may be unauthenticated: it gets a fixed code, never internal exception text.
            try {
              ws.send(encodeMarketWireMessage({ type: 'error', error: 'Market handler exception' }));
            } catch (sendError) {
              meshLog.warn('relay.market_error_send_failed', { error: serializeError(sendError) });
            }
          });
          return;
        }
        const peerMessage = frame.message;
        Promise.resolve(relayRoute(routerConfig, ws, peerMessage, typeof raw === 'string' ? undefined : toRuntimeWsBytes(raw))).catch(error => {
          const reason = serializeError(error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'RELAY_HANDLER_EXCEPTION',
            details: {
              error: reason,
              msgType: peerMessage.type,
              from: peerMessage.from,
              to: peerMessage.to,
            },
          });
          meshLog.error('relay.handler_exception', { error: reason, msgType: peerMessage.type });
          try {
            ws.send(serializeWsMessage({ type: 'error', error: 'Relay handler exception' }));
          } catch (sendError) {
            meshLog.warn('relay.error_send_failed', { error: serializeError(sendError) });
          }
        });
      } catch (error) {
        pushDebugEvent(relayStore, {
          event: 'error',
          reason: 'INVALID_RELAY_MESSAGE',
          details: { error: serializeError(error) },
        });
        try {
          ws.send(serializeWsMessage({ type: 'error', error: 'Invalid relay message' }));
        } catch (sendError) {
          meshLog.warn('relay.invalid_message_send_failed', { error: serializeError(sendError) });
        }
      }
    },
    close(ws) {
      const relayWs = ws;
      relayHelloChallenges.forget(relayWs);
      cleanupRpcMarketSubscription(relayWs);
      forgetRelaySocketRuntimeId(relayWs);
      removeClient(relayStore, relayWs);
    },
  };
};
