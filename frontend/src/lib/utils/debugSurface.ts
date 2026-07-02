type DebugSurfaceOptions = {
  enumerable?: boolean;
};

type XlnDebugWindow = Window & {
  __xln?: Record<string, unknown>;
};

const LOCAL_DEBUG_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalDebugSurfaceAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  return LOCAL_DEBUG_HOSTS.has(window.location.hostname);
}

function ensureDebugRoot(): Record<string, unknown> {
  const target = window as XlnDebugWindow;
  const existing = target.__xln;
  if (existing && typeof existing === 'object') return existing;
  const root: Record<string, unknown> = {};
  Object.defineProperty(target, '__xln', {
    configurable: true,
    enumerable: false,
    value: root,
  });
  return root;
}

export function registerDebugSurface<T>(
  name: string,
  factory: () => T,
  options: DebugSurfaceOptions = {},
): void {
  if (!isLocalDebugSurfaceAllowed()) return;
  const root = ensureDebugRoot();
  Object.defineProperty(root, name, {
    configurable: true,
    enumerable: options.enumerable ?? true,
    get: factory,
  });
}
