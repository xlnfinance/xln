import { readFileSync, writeFileSync } from 'node:fs';

const compression = `        gzip on;
        gzip_types application/json;
        gzip_min_length 1024;
        gzip_comp_level 4;
        gzip_vary on;
`;

const proxy = `        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
`;

function compressLocation(block: string): string {
  if ((block.match(/\bproxy_pass\s+[^;]+;/g) ?? []).join('') !== 'proxy_pass http://127.0.0.1:8080;') {
    throw new Error('NGINX_RPC_ORCHESTRATOR_UPSTREAM_REQUIRED');
  }
  if (/\bgzip\w*\s/.test(block)) {
    const remaining = block.replace(compression, '');
    if (remaining === block || /\bgzip\w*\s/.test(remaining)) {
      throw new Error('NGINX_RPC_CONFLICTING_COMPRESSION');
    }
    return block;
  }
  return block.replace(/    }\n$/, compression + '    }\n');
}

export function configureRpcNginx(source: string): string {
  const owner = '    server_name xln.finance app.xln.finance;';
  if (source.split(owner).length !== 2) throw new Error('NGINX_RPC_CANONICAL_SITE_REQUIRED');
  const start = source.indexOf(owner);
  const next = source.indexOf('\nserver {', start);
  const end = next === -1 ? source.length : next;
  let site = source.slice(start, end);
  const location = /^    location (?:= \/rpc|~ \^\/rpc\[2-8\]\$) \{\n(?:        [^\n]*\n)*?    }\n/gm;
  const blocks = [...site.matchAll(location)].map(match => match[0]);
  const declarations = site.match(/\blocation\s+[^\n{]*\/rpc[^\n{]*\{/g) ?? [];
  if (
    blocks.length !== declarations.length ||
    new Set(blocks.map(block => block.split('\n')[0])).size !== blocks.length
  ) {
    throw new Error('NGINX_RPC_CONFLICTING_ROUTE');
  }
  site = site.replace(location, compressLocation);
  for (const route of ['= /rpc', '~ ^/rpc[2-8]$']) {
    const opening = `    location ${route} {\n`;
    if (site.includes(opening)) continue;
    const marker = '    location /api/ {';
    if (site.split(marker).length !== 2) throw new Error('NGINX_RPC_API_ANCHOR_REQUIRED');
    site = site.replace(marker, `${opening}${proxy}${compression}    }\n\n${marker}`);
  }
  return source.slice(0, start) + site + source.slice(end);
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('NGINX_RPC_SITE_PATH_REQUIRED');
  const source = readFileSync(path, 'utf8');
  const configured = configureRpcNginx(source);
  if (configured !== source) writeFileSync(path, configured);
}
