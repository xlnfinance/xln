export type RuntimeImportLogManifest = {
  expiresAt: number;
  entries: ReadonlyArray<{ label: string }>;
};

export type RuntimeImportLogInput = {
  manifest: RuntimeImportLogManifest;
  importUrl: string;
  access: 'read' | 'admin';
  manifestPath: string;
  exposeUrl?: boolean;
};

const sanitizeLogValue = (value: string): string =>
  value
    .trim()
    .replace(/xlnra1\.[^\s,=]+/g, '<runtime-token-redacted>')
    .replace(/runtime-import=[^\s,=]+/g, 'runtime-import-redacted')
    .replace(/[\s,=]+/g, '_');

export const redactTokenBearingUrlForLog = (urlText: string): string => {
  const url = new URL(urlText);
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const redactRuntimeImportWalletUrl = redactTokenBearingUrlForLog;

export const buildRuntimeImportLogLine = (input: RuntimeImportLogInput): string => {
  if (input.exposeUrl) return input.importUrl;
  const labels = input.manifest.entries.map(entry => sanitizeLogValue(entry.label)).join(',');
  const walletUrl = redactRuntimeImportWalletUrl(input.importUrl);
  return [
    '[MESH] RUNTIME_IMPORT_READY',
    `count=${input.manifest.entries.length}`,
    `access=${input.access}`,
    `path=${sanitizeLogValue(input.manifestPath)}`,
    `expiresAt=${input.manifest.expiresAt}`,
    `labels=${labels}`,
    `wallet=${walletUrl}`,
  ].join(' ');
};
