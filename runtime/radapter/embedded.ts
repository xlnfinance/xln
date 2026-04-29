import type { RuntimeInput, Env } from '../types';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
} from './types';
import { RuntimeAdapterError } from './errors';
import { resolveRuntimeAdapterRead, type RuntimeAdapterResolveContext } from './resolve';

export type EmbeddedRuntimeAdapterDeps = {
  getEnv: () => Env | null;
  main?: (seed?: string | null) => Promise<Env>;
  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
  registerEnvChangeCallback: (env: Env, cb: (env: Env) => void) => (() => void);
  buildReadContext?: (env: Env) => Partial<Omit<RuntimeAdapterResolveContext, 'env'>>;
};

export class EmbeddedRuntimeAdapter implements RuntimeAdapter {
  readonly mode = 'embedded' as const;
  private env: Env | null = null;
  private unregister: (() => void) | null = null;
  private statusCbs = new Set<(status: RuntimeAdapterStatus) => void>();
  private changeCbs = new Set<(height: number) => void>();
  private currentStatus: RuntimeAdapterStatus = 'disconnected';

  constructor(private readonly deps: EmbeddedRuntimeAdapterDeps) {}

  get status(): RuntimeAdapterStatus {
    return this.currentStatus;
  }

  get currentHeight(): number {
    return Math.max(0, Math.floor(Number(this.env?.height ?? 0)));
  }

  get authLevel(): RuntimeAdapterAuthLevel | null {
    return 'admin';
  }

  async connect(config: RuntimeAdapterConfig): Promise<void> {
    if (config.mode !== 'embedded') throw new RuntimeAdapterError('E_BAD_QUERY', 'EmbeddedRuntimeAdapter requires mode=embedded');
    this.setStatus('connecting');
    const env = config.seed && this.deps.main
      ? await this.deps.main(config.seed)
      : this.deps.getEnv();
    if (!env) throw new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true);
    this.env = env;
    this.unregister?.();
    this.unregister = this.deps.registerEnvChangeCallback(env, (nextEnv) => {
      this.env = nextEnv;
      for (const cb of this.changeCbs) cb(Math.max(0, Math.floor(Number(nextEnv.height ?? 0))));
    });
    this.setStatus('connected');
  }

  disconnect(): void {
    this.unregister?.();
    this.unregister = null;
    this.env = null;
    this.setStatus('disconnected');
  }

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    const env = this.env ?? this.deps.getEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    return resolveRuntimeAdapterRead<T>({ env, ...this.deps.buildReadContext?.(env) }, path, query);
  }

  send(input: RuntimeInput): Promise<{ height: number }> {
    const env = this.env ?? this.deps.getEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    this.deps.enqueueRuntimeInput(env, input);
    return Promise.resolve({ height: Math.max(0, Math.floor(Number(env.height ?? 0))) });
  }

  onChange(cb: (height: number) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  onStatus(cb: (status: RuntimeAdapterStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  private setStatus(status: RuntimeAdapterStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const cb of this.statusCbs) cb(status);
  }
}
