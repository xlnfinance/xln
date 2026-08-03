const FRONTEND_LOCATION_HEADERS = [
  'location = /app {',
  'location / {',
  'location /_app/ {',
] as const;

const braceDelta = (line: string): number =>
  [...line].reduce((total, character) => total + (character === '{' ? 1 : character === '}' ? -1 : 0), 0);

const serverRanges = (lines: readonly string[]): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < lines.length; start += 1) {
    const startLine = lines[start];
    if (!startLine || startLine.trim() !== 'server {') continue;
    let depth = 0;
    for (let end = start; end < lines.length; end += 1) {
      const line = lines[end];
      if (line === undefined) throw new Error('FRONTEND_NGINX_SERVER_RANGE_INVALID');
      depth += braceDelta(line);
      if (depth === 0) {
        ranges.push({ start, end });
        start = end;
        break;
      }
    }
  }
  return ranges;
};

const productionServer = (lines: readonly string[]): { start: number; end: number } => {
  const matches = serverRanges(lines).filter(range => {
    const block = lines.slice(range.start, range.end + 1).join('\n');
    return /\blisten\s+443\b/.test(block) && /\bserver_name\s+xln\.finance;/.test(block);
  });
  if (matches.length !== 1) throw new Error(`FRONTEND_NGINX_PRODUCTION_SERVER_INVALID:${matches.length}`);
  const match = matches[0];
  if (!match) throw new Error('FRONTEND_NGINX_PRODUCTION_SERVER_MISSING');
  return match;
};

const removeLocationBlock = (lines: string[], start: number): number => {
  let depth = 0;
  for (let end = start; end < lines.length; end += 1) {
    const line = lines[end];
    if (line === undefined) throw new Error('FRONTEND_NGINX_LOCATION_RANGE_INVALID');
    depth += braceDelta(line);
    if (depth === 0) {
      lines.splice(start, end - start + 1);
      if (lines[start]?.trim() === '') lines.splice(start, 1);
      return start;
    }
  }
  throw new Error(`FRONTEND_NGINX_LOCATION_UNTERMINATED:${lines[start]}`);
};

const removeLegacyFrontendLocations = (lines: string[], range: { start: number; end: number }): void => {
  let index = range.start + 1;
  while (index < range.end && index < lines.length) {
    const header = lines[index]?.trim() ?? '';
    if (FRONTEND_LOCATION_HEADERS.some(candidate => header === candidate)) {
      const removed = removeLocationBlock(lines, index);
      range.end = productionServer(lines).end;
      index = removed;
      continue;
    }
    index += 1;
  }
};

const removeLegacyRootDirectives = (lines: string[]): void => {
  const range = productionServer(lines);
  for (let index = range.end - 1; index > range.start; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^root\s+\S*\/frontend\/build;$/.test(line) || line === 'index index.html;') lines.splice(index, 1);
  }
};

export const installFrontendReleaseInclude = (
  source: string,
  includePath = '/etc/nginx/snippets/xln-frontend-release.conf',
): string => {
  if (!includePath.startsWith('/') || includePath.includes('..') || /\s/.test(includePath)) {
    throw new Error(`FRONTEND_NGINX_INCLUDE_PATH_INVALID:${includePath}`);
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const range = productionServer(lines);
  removeLegacyFrontendLocations(lines, range);
  removeLegacyRootDirectives(lines);
  const refreshed = productionServer(lines);
  const includeLine = `    include ${includePath};`;
  const existing = lines.slice(refreshed.start, refreshed.end + 1).filter(line => line.trim() === includeLine.trim());
  if (existing.length > 1) throw new Error('FRONTEND_NGINX_INCLUDE_DUPLICATE');
  if (existing.length === 0) {
    const serverName = lines.findIndex(
      (line, index) => index > refreshed.start && index < refreshed.end && line.trim() === 'server_name xln.finance;',
    );
    if (serverName < 0) throw new Error('FRONTEND_NGINX_SERVER_NAME_MISSING');
    lines.splice(serverName + 1, 0, includeLine);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};
