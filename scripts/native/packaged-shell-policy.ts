import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../core/protocol/serialization';
import { assertNativeWalletContentSecurityPolicy } from './capacitor-candidate';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const assertIncludes = (source: string, fragment: string, code: string): void => {
  if (!source.includes(fragment)) throw new Error(code);
};

const readJsonRecord = async (pathname: string, code: string): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(pathname, 'utf8')) as unknown;
  } catch {
    throw new Error(`${code}_JSON_INVALID`);
  }
  if (!isRecord(value)) throw new Error(`${code}_INVALID`);
  return value;
};

const assertExtensionManifest = (manifest: Record<string, unknown>, version: string): void => {
  const action = manifest['action'];
  const background = manifest['background'];
  const csp = manifest['content_security_policy'];
  const external = manifest['externally_connectable'];
  if (manifest['manifest_version'] !== 3 || manifest['version'] !== version ||
    !isRecord(action) || action['default_popup'] !== undefined || action['default_icon'] !== 'icon-128.png' ||
    !isRecord(background) || background['service_worker'] !== 'extension-service-worker.js' ||
    background['type'] !== 'module' || !isRecord(csp) || !isRecord(external)) {
    throw new Error('PACKAGED_CANDIDATE_EXTENSION_MANIFEST_INVALID');
  }
  if (safeStringify(manifest['permissions']) !== safeStringify(['notifications', 'storage']) ||
    safeStringify(manifest['host_permissions']) !== safeStringify([]) ||
    safeStringify(external['matches']) !== safeStringify([
      'https://xln.finance/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ])) {
    throw new Error('PACKAGED_CANDIDATE_EXTENSION_PERMISSIONS_INVALID');
  }
  const policy = csp['extension_pages'];
  if (typeof policy !== 'string' || !policy.includes("script-src 'self' 'wasm-unsafe-eval'") ||
    !policy.includes("object-src 'self'") || policy.includes("'unsafe-eval'") ||
    !policy.includes('http://localhost:*') || !policy.includes('http://127.0.0.1:*')) {
    throw new Error('PACKAGED_CANDIDATE_EXTENSION_CSP_INVALID');
  }
};

export const verifyPackagedShellPolicy = async (
  workspaceDirectory: string,
  expectedDesktopPackage: string,
): Promise<void> => {
  const desktopRoot = join(workspaceDirectory, 'desktop');
  const extensionRoot = join(workspaceDirectory, 'extension');
  const [desktopPackage, version, desktopMain, desktopPreload, extensionSecurity, extensionWorker, appHtml] =
    await Promise.all([
      readFile(join(desktopRoot, 'package.json'), 'utf8'),
      readFile(join(import.meta.dir, '../../VERSION'), 'utf8').then((value) => value.trim()),
      readFile(join(desktopRoot, 'native/desktop/main.cjs'), 'utf8'),
      readFile(join(desktopRoot, 'native/desktop/preload.cjs'), 'utf8'),
      readFile(join(extensionRoot, 'extension-security.js'), 'utf8'),
      readFile(join(extensionRoot, 'extension-service-worker.js'), 'utf8'),
      readFile(join(extensionRoot, 'app.html'), 'utf8'),
    ]);
  if (desktopPackage !== expectedDesktopPackage) throw new Error('PACKAGED_CANDIDATE_DESKTOP_PACKAGE_MISMATCH');
  assertNativeWalletContentSecurityPolicy(appHtml);
  assertExtensionManifest(await readJsonRecord(
    join(extensionRoot, 'manifest.json'),
    'PACKAGED_CANDIDATE_EXTENSION_MANIFEST',
  ), version);
  assertIncludes(desktopMain, "app.setAsDefaultProtocolClient('xln'", 'PACKAGED_CANDIDATE_DESKTOP_PROTOCOL_MISSING');
  assertIncludes(desktopMain, "app.on('open-url'", 'PACKAGED_CANDIDATE_DESKTOP_OPEN_URL_MISSING');
  assertIncludes(desktopMain, "url.startsWith('xln://')", 'PACKAGED_CANDIDATE_DESKTOP_ROUTE_MISSING');
  assertIncludes(desktopMain, 'contextIsolation: true', 'PACKAGED_CANDIDATE_DESKTOP_ISOLATION_MISSING');
  assertIncludes(desktopMain, 'nodeIntegration: false', 'PACKAGED_CANDIDATE_DESKTOP_NODE_DISABLED_MISSING');
  assertIncludes(desktopMain, 'sandbox: true', 'PACKAGED_CANDIDATE_DESKTOP_SANDBOX_MISSING');
  assertIncludes(desktopPreload, "'xln-native-deeplink'", 'PACKAGED_CANDIDATE_DESKTOP_PRELOAD_ROUTE_MISSING');
  assertIncludes(extensionSecurity, "parsed.protocol !== 'xln:'", 'PACKAGED_CANDIDATE_EXTENSION_PROTOCOL_MISSING');
  assertIncludes(extensionWorker, "openApp('app.html')", 'PACKAGED_CANDIDATE_EXTENSION_ENTRY_MISSING');
};
