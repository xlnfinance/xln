import { expect, test } from 'bun:test';
import { configureRpcNginx } from './configure-rpc-nginx';

const site = `server {
    listen 443 ssl;
    server_name xln.finance app.xln.finance;
    ssl_certificate /operator/cert.pem;
    ssl_certificate_key /operator/key.pem;
    location = /rpc {
        proxy_pass http://127.0.0.1:8080;
        proxy_read_timeout 300s;
        limit_req zone=operator_limit;
    }
    location ~ ^/rpc[2-8]$ {
        proxy_pass http://127.0.0.1:8080;
        proxy_read_timeout 300s;
    }
    location /api/ { proxy_pass http://127.0.0.1:8080; }
    location /relay { proxy_pass http://127.0.0.1:8080; }
}
server {
    server_name custody.xln.finance;
    location /rpc { proxy_pass http://127.0.0.1:8088; }
}
`;

test('compresses both existing RPC locations while preserving every other directive and host', () => {
  const configured = configureRpcNginx(site);
  expect(configured.replace(/^        gzip[^\n]*\n/gm, '')).toBe(site);
  expect(configured.match(/gzip_types application\/json;/g)).toHaveLength(2);
  expect(configured.match(/gzip_vary on;/g)).toHaveLength(2);
  expect(configured.match(/gzip_min_length 1024;/g)).toHaveLength(2);
  expect(configureRpcNginx(configured)).toBe(configured);
});

test('installs missing RPC locations through the orchestrator, never directly to a chain', () => {
  const empty = site.replace(/^    location (?:= \/rpc|~ \^\/rpc\[2-8\]\$) \{\n(?:        .*\n)*?    }\n/gm, '');
  const configured = configureRpcNginx(empty);
  expect(configured.match(/proxy_pass http:\/\/127.0.0.1:8080;/g)).toHaveLength(4);
  expect(configured).toContain('location = /rpc {');
  expect(configured).toContain('location ~ ^/rpc[2-8]$ {');
  expect(configureRpcNginx(configured)).toBe(configured);
});

test('rejects ambiguous ownership, conflicting locations, direct-chain routing and unknown gzip policy', () => {
  for (const bad of [site + site, site.replace('xln.finance app.xln.finance', 'other.example')]) {
    expect(() => configureRpcNginx(bad)).toThrow('NGINX_RPC_CANONICAL_SITE_REQUIRED');
  }
  for (const route of ['location /rpc {', 'location = /rpc2 {', 'location ^~ /rpc {']) {
    expect(() => configureRpcNginx(site.replace('location = /rpc {', route))).toThrow('NGINX_RPC_CONFLICTING_ROUTE');
  }
  const duplicated = site.replace(
    '    location /api/',
    '    location = /rpc {\n        proxy_pass http://127.0.0.1:8080;\n    }\n    location /api/',
  );
  expect(() => configureRpcNginx(duplicated)).toThrow('NGINX_RPC_CONFLICTING_ROUTE');
  expect(() => configureRpcNginx(site.replace(':8080;', ':8545;'))).toThrow('NGINX_RPC_ORCHESTRATOR_UPSTREAM_REQUIRED');
  expect(() => configureRpcNginx(site.replace('        limit_req', '        gzip off;\n        limit_req'))).toThrow(
    'NGINX_RPC_CONFLICTING_COMPRESSION',
  );
});
