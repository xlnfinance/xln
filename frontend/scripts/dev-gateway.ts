import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { connect as createTlsConnection } from 'node:tls';

import { createProxyServer } from 'http-proxy-3';

import { safeStringify } from '../../core/protocol/serialization';
import {
  createDevelopmentGatewayTargets,
  parseDevelopmentGatewayPort,
  resolveDevelopmentGatewayRequest,
  rewriteDevelopmentGatewayUrl,
  type DevelopmentGatewayDecision,
  type GatewayProxyOwner,
} from '../config/development-gateway';

type GatewayTargets = Readonly<Record<GatewayProxyOwner, string>>;

export type DevelopmentGatewayOptions = Readonly<{
  targets: GatewayTargets;
}>;

const writeLocalResponse = (
  response: ServerResponse,
  status: number,
  body: string,
  headers: Readonly<Record<string, string>>,
): void => {
  response.writeHead(status, headers);
  response.end(body);
};

const writeProxyFailure = (response: ServerResponse, owner: GatewayProxyOwner, error: Error): void => {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  writeLocalResponse(
    response,
    502,
    `${safeStringify({ error: 'DEVELOPMENT_GATEWAY_PROXY_FAILED', owner, detail: error.message })}\n`,
    { 'content-type': 'application/json; charset=utf-8' },
  );
};

const rejectUpgrade = (socket: Socket, status: number, message: string): void => {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}\n`,
  );
};

const forwardWebSocketUpgrade = (
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: string,
): void => {
  // Preserve the browser's original Host and upgrade headers byte-for-byte.
  // The relay/runtime audience is origin-bound, while the target port is only
  // an internal development detail and must not become part of that audience.
  const upstream = new URL(target);
  const secure = upstream.protocol === 'https:' || upstream.protocol === 'wss:';
  if (!secure && upstream.protocol !== 'http:' && upstream.protocol !== 'ws:') {
    rejectUpgrade(socket, 502, `DEVELOPMENT_GATEWAY_WS_PROTOCOL_INVALID:${upstream.protocol}`);
    return;
  }
  const port = Number(upstream.port || (secure ? '443' : '80'));
  const upstreamSocket = secure
    ? createTlsConnection({ host: upstream.hostname, port, servername: upstream.hostname })
    : createConnection({ host: upstream.hostname, port });
  const connectEvent = secure ? 'secureConnect' : 'connect';
  upstreamSocket.once(connectEvent, () => {
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstreamSocket.write(
      `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`,
    );
    if (head.byteLength > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    socket.resume();
    upstreamSocket.resume();
  });
  upstreamSocket.once('error', (error) => {
    rejectUpgrade(socket, 502, `DEVELOPMENT_GATEWAY_WS_FAILED:${error.message}`);
  });
  socket.once('error', (error) => upstreamSocket.destroy(error));
};

export const createDevelopmentGateway = ({ targets }: DevelopmentGatewayOptions) => {
  const proxy = createProxyServer({ xfwd: true, changeOrigin: false });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const rawUrl = request.url ?? '/';
    let decision: DevelopmentGatewayDecision;
    try {
      decision = resolveDevelopmentGatewayRequest(rawUrl);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      writeLocalResponse(response, 400, `${detail}\n`, { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    if (decision.kind === 'redirect') {
      writeLocalResponse(response, decision.status, '', { location: decision.location });
      return;
    }
    if (decision.kind === 'response') {
      writeLocalResponse(response, decision.status, decision.body, decision.headers);
      return;
    }

    request.url = rewriteDevelopmentGatewayUrl(rawUrl, decision);
    proxy.web(request, response, { target: targets[decision.owner], changeOrigin: false }, (error) => {
      writeProxyFailure(response, decision.owner, error);
    });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const rawUrl = request.url ?? '/';
    let decision: DevelopmentGatewayDecision;
    try {
      decision = resolveDevelopmentGatewayRequest(rawUrl);
    } catch (error: unknown) {
      rejectUpgrade(socket, 400, error instanceof Error ? error.message : String(error));
      return;
    }
    if (decision.kind !== 'proxy') {
      rejectUpgrade(socket, 400, 'DEVELOPMENT_GATEWAY_UPGRADE_REJECTED');
      return;
    }
    request.url = rewriteDevelopmentGatewayUrl(rawUrl, decision);
    forwardWebSocketUpgrade(request, socket, head, targets[decision.owner]);
  });

  server.on('clientError', (error: Error, socket: Socket) => {
    rejectUpgrade(socket, 400, `DEVELOPMENT_GATEWAY_CLIENT_ERROR:${error.message}`);
  });
  return server;
};

const run = (): void => {
  const host = process.env['XLN_REACT_GATEWAY_HOST'] ?? '127.0.0.1';
  const defaults = createDevelopmentGatewayTargets(process.env['XLN_REACT_EDGE_TARGET']);
  const targets: GatewayTargets = {
    edge: defaults.edge,
    site: process.env['XLN_REACT_SITE_TARGET'] ?? defaults.site,
    docs: process.env['XLN_REACT_DOCS_TARGET'] ?? defaults.docs,
    wallet: process.env['XLN_REACT_WALLET_TARGET'] ?? defaults.wallet,
    ops: process.env['XLN_REACT_OPS_TARGET'] ?? defaults.ops,
  };
  const server = createDevelopmentGateway({ targets });
  server.listen(parseDevelopmentGatewayPort(process.env['XLN_REACT_GATEWAY_PORT']), host, () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('DEVELOPMENT_GATEWAY_ADDRESS_INVALID');
    console.info(`FRONTEND_GATEWAY_READY origin=http://${host}:${address.port}`);
  });
  const close = (): void => {
    server.close((error?: Error) => {
      if (error !== undefined) throw error;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
};

if (import.meta.main) {
  try {
    run();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
