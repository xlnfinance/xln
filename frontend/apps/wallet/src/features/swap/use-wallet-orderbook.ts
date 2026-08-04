import { useEffect, useState } from 'react';

import type { MarketSnapshotPayload } from '@xln/runtime/network/relay/market-snapshot';
import {
  decodeMarketWireResponse,
  encodeMarketWireMessage,
} from '@xln/runtime/network/relay/market-wire';
import { resolveOrderbookRelayWsUrl } from '$lib/components/Trading/orderbook-relay-url';

export type WalletOrderbookSnapshot = Readonly<{
  phase: 'idle' | 'connecting' | 'ready' | 'empty' | 'stale' | 'error';
  error: string | null;
  payload: MarketSnapshotPayload | null;
}>;

let messageSequence = 0;

const messageId = (prefix: string): string => `${prefix}-${++messageSequence}`;

export const canonicalMarketPairId = (tokenA: number, tokenB: number): string => {
  if (!Number.isSafeInteger(tokenA) || tokenA < 1 || !Number.isSafeInteger(tokenB) || tokenB < 1 || tokenA === tokenB) {
    throw new Error(`WALLET_ORDERBOOK_PAIR_INVALID:${tokenA}:${tokenB}`);
  }
  return `${Math.min(tokenA, tokenB)}/${Math.max(tokenA, tokenB)}`;
};
const EMPTY_ORDERBOOK: WalletOrderbookSnapshot = Object.freeze({ phase: 'idle', error: null, payload: null });

export const useWalletOrderbook = (input: Readonly<{
  hubEntityId: string;
  giveTokenId: number;
  wantTokenId: number;
  relayUrl?: string;
}>): WalletOrderbookSnapshot => {
  const [state, setState] = useState<WalletOrderbookSnapshot>(EMPTY_ORDERBOOK);
  const hubEntityId = input.hubEntityId.trim().toLowerCase();
  const pairId = hubEntityId && input.giveTokenId > 0 && input.wantTokenId > 0 && input.giveTokenId !== input.wantTokenId
    ? canonicalMarketPairId(input.giveTokenId, input.wantTokenId)
    : '';

  useEffect(() => {
    if (!hubEntityId || !pairId) {
      setState(EMPTY_ORDERBOOK);
      return;
    }
    const resolution = resolveOrderbookRelayWsUrl(input.relayUrl ?? '', window.location);
    if (!resolution.url) {
      setState(Object.freeze({ phase: 'error', error: resolution.unavailableReason || 'Relay unavailable', payload: null }));
      return;
    }
    let disposed = false;
    let latestReceivedAt = 0;
    const socket = new WebSocket(resolution.url);
    setState(Object.freeze({ phase: 'connecting', error: null, payload: null }));
    const subscriptionId = messageId('wallet-market-subscribe');
    const staleTimer = window.setInterval(() => {
      if (!disposed && latestReceivedAt > 0 && Date.now() - latestReceivedAt > 3_000) {
        setState(current => current.payload ? Object.freeze({ ...current, phase: 'stale' }) : current);
      }
    }, 1_000);
    const firstSnapshotTimer = window.setTimeout(() => {
      if (!disposed && latestReceivedAt === 0) {
        setState(Object.freeze({ phase: 'error', error: 'ORDERBOOK_FIRST_SNAPSHOT_TIMEOUT', payload: null }));
        socket.close();
      }
    }, 6_000);

    socket.addEventListener('open', () => {
      if (disposed) return;
      socket.send(encodeMarketWireMessage({
        type: 'market_subscribe',
        id: subscriptionId,
        replace: true,
        depth: 20,
        hubEntityId,
        pairId,
      }));
      socket.send(encodeMarketWireMessage({ type: 'market_snapshot_request', id: messageId('wallet-market-snapshot') }));
    });
    socket.addEventListener('message', event => {
      if (disposed) return;
      try {
        const message = decodeMarketWireResponse(String(event.data));
        if (message.type === 'error') throw new Error(`${message.code ?? 'MARKET_RELAY_ERROR'}:${message.error}`);
        if (message.type === 'market_status') {
          setState(Object.freeze({ phase: 'empty', error: null, payload: null }));
          return;
        }
        if (message.type !== 'market_snapshot') return;
        if (message.payload.hubEntityId !== hubEntityId || message.payload.pairId !== pairId) {
          throw new Error('WALLET_ORDERBOOK_SNAPSHOT_IDENTITY_MISMATCH');
        }
        latestReceivedAt = Date.now();
        const empty = message.payload.bids.length === 0 && message.payload.asks.length === 0;
        setState(Object.freeze({ phase: empty ? 'empty' : 'ready', error: null, payload: message.payload }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error || 'ORDERBOOK_DECODE_FAILED');
        setState(Object.freeze({ phase: 'error', error: reason, payload: null }));
        socket.close();
      }
    });
    socket.addEventListener('error', () => {
      if (!disposed) setState(Object.freeze({ phase: 'error', error: 'ORDERBOOK_RELAY_CONNECTION_FAILED', payload: null }));
    });
    socket.addEventListener('close', () => {
      if (!disposed) setState(current => current.phase === 'error' ? current : Object.freeze({ phase: 'error', error: 'ORDERBOOK_RELAY_CLOSED', payload: current.payload }));
    });
    return () => {
      disposed = true;
      window.clearInterval(staleTimer);
      window.clearTimeout(firstSnapshotTimer);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeMarketWireMessage({
          type: 'market_unsubscribe',
          id: messageId('wallet-market-unsubscribe'),
          hubEntityId,
          pairId,
        }));
      }
      socket.close();
    };
  }, [hubEntityId, pairId, input.relayUrl]);
  return state;
};
