import type { CrossJurisdictionSwapRoute, RuntimeInput, Env } from '../types';
import type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
	  RuntimeAdapterConfig,
	  RuntimeAdapterControlAction,
	  RuntimeAdapterCrossJurisdictionIntentResult,
	  RuntimeAdapterReadQuery,
	  RuntimeAdapterSendResult,
	  RuntimeAdapterStatus,
	} from './types';
import { RuntimeAdapterError } from './errors';
import { resolveRuntimeAdapterRead, type RuntimeAdapterResolveContext } from './resolve';

export type EmbeddedRuntimeAdapterDeps = {
  getEnv: () => Env | null;
  main?: (seed?: string | null) => Promise<Env>;
  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
  submitCrossJurisdictionIntent: (
    env: Env,
    route: CrossJurisdictionSwapRoute,
  ) => Promise<RuntimeAdapterCrossJurisdictionIntentResult>;
  controlRuntime?: (env: Env, action: RuntimeAdapterControlAction) => Promise<unknown>;
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
  private configuredRuntimeId = '';

  constructor(private readonly deps: EmbeddedRuntimeAdapterDeps) {}

  get status(): RuntimeAdapterStatus {
    return this.currentStatus;
  }

  get runtimeId(): string {
    return String(this.resolveEnv()?.runtimeId || this.configuredRuntimeId || 'embedded').trim().toLowerCase();
  }

  get serverFingerprint(): null {
    return null;
  }

  get currentHeight(): number {
    const env = this.resolveEnv();
    return Math.max(0, Math.floor(Number(env?.height ?? 0)));
  }

  get nextCommandSequence(): null {
    return null;
  }

  get commandLaneKind(): 'owner' {
    return 'owner';
  }

  get authLevel(): RuntimeAdapterAuthLevel | null {
    return 'admin';
  }

  async connect(config: RuntimeAdapterConfig): Promise<void> {
    if (config.mode !== 'embedded') throw new RuntimeAdapterError('E_BAD_QUERY', 'EmbeddedRuntimeAdapter requires mode=embedded');
    this.setStatus('connecting');
    this.configuredRuntimeId = String(config.runtimeId || '').trim().toLowerCase();
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

  ensureOwnerCommandLane(): Promise<void> {
    return Promise.resolve();
  }

  read<T = unknown>(path: string, query?: RuntimeAdapterReadQuery): Promise<T> {
    const env = this.resolveEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    return resolveRuntimeAdapterRead<T>({ env, ...this.deps.buildReadContext?.(env) }, path, query);
  }

	  send(input: RuntimeInput): Promise<RuntimeAdapterSendResult> {
    const env = this.resolveEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    this.deps.enqueueRuntimeInput(env, input);
    return Promise.resolve({ height: Math.max(0, Math.floor(Number(env.height ?? 0))) });
  }

  submitCrossJurisdictionIntent(
    route: CrossJurisdictionSwapRoute,
  ): Promise<RuntimeAdapterCrossJurisdictionIntentResult> {
    const env = this.resolveEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    return this.deps.submitCrossJurisdictionIntent(env, route);
  }

  control<T = unknown>(action: RuntimeAdapterControlAction): Promise<T> {
    const env = this.resolveEnv();
    if (!env) return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true));
    if (!this.deps.controlRuntime) {
      return Promise.reject(new RuntimeAdapterError('E_INTERNAL', 'runtime admin control is unavailable'));
    }
    return this.deps.controlRuntime(env, action) as Promise<T>;
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

  private resolveEnv(): Env | null {
    return this.deps.getEnv() ?? this.env;
  }
}
