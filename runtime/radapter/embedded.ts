import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { RuntimeInput, RuntimeState } from '../runtime/types';
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
import { assertRuntimeCommandReady, getRuntimeCommandReadiness } from '../runtime/lifecycle';
import { ensureRuntimeState } from '../runtime/runtime-state';

export type EmbeddedRuntimeAdapterDeps = {
  getEnv: () => RuntimeState | null;
  main?: (seed?: string | null) => Promise<RuntimeState>;
  enqueueRuntimeInput: (env: RuntimeState, input: RuntimeInput) => void;
  validateRuntimeInputAdmission: (env: RuntimeState, input: RuntimeInput) => void;
  submitCrossJurisdictionIntent: (
    env: RuntimeState,
    route: CrossJurisdictionSwapRoute,
  ) => Promise<RuntimeAdapterCrossJurisdictionIntentResult>;
  controlRuntime?: (env: RuntimeState, action: RuntimeAdapterControlAction) => Promise<unknown>;
  registerEnvChangeCallback: (env: RuntimeState, cb: (env: RuntimeState) => void) => (() => void);
  buildReadContext?: (env: RuntimeState) => Partial<Omit<RuntimeAdapterResolveContext, 'env'>>;
};

export class EmbeddedRuntimeAdapter implements RuntimeAdapter {
  readonly mode = 'embedded' as const;
  private env: RuntimeState | null = null;
  private unregister: (() => void) | null = null;
  private statusCbs = new Set<(status: RuntimeAdapterStatus) => void>();
  private changeCbs = new Set<(height: number) => void>();
  private currentStatus: RuntimeAdapterStatus = 'disconnected';
  private configuredRuntimeId = '';
  private publishedRuntimeId = '';
  private publishedHeight = 0;
  private publishedCommandReady = false;
  private publishedCommandReadyReason: string | null = 'adapter-disconnected';

  constructor(private readonly deps: EmbeddedRuntimeAdapterDeps) {}

  get status(): RuntimeAdapterStatus {
    return this.currentStatus;
  }

  get runtimeId(): string {
    return this.publishedRuntimeId || this.configuredRuntimeId || 'embedded';
  }

  get serverFingerprint(): null {
    return null;
  }

  get currentHeight(): number {
    return this.publishedHeight;
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

  get commandReady(): boolean {
    return this.currentStatus === 'connected' && this.publishedCommandReady;
  }

  get commandReadyReason(): string | null {
    if (this.currentStatus !== 'connected') return `adapter-${this.currentStatus}`;
    return this.publishedCommandReadyReason;
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
    this.publishCommittedMetadata(env);
    this.unregister?.();
    this.unregister = this.deps.registerEnvChangeCallback(env, (nextEnv) => {
      this.env = nextEnv;
      // Infrastructure notifications may race an in-place frame mutation.
      // Such a callback must never publish H+1 before WAL has committed it.
      if (ensureRuntimeState(nextEnv).stateMutationInFlight) return;
      this.publishCommittedMetadata(nextEnv);
      for (const cb of this.changeCbs) cb(this.publishedHeight);
    });
    this.setStatus('connected');
  }

  disconnect(): void {
    this.unregister?.();
    this.unregister = null;
    this.env = null;
    this.publishedRuntimeId = '';
    this.publishedHeight = 0;
    this.publishedCommandReady = false;
    this.publishedCommandReadyReason = 'adapter-disconnected';
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

  async send(input: RuntimeInput): Promise<RuntimeAdapterSendResult> {
    const env = this.resolveEnv();
    if (!env) throw new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true);
    this.requireCommandReady(env);
    this.deps.validateRuntimeInputAdmission(env, input);
    this.deps.enqueueRuntimeInput(env, input);
    return { height: Math.max(0, Math.floor(Number(env.height ?? 0))) };
  }

  async submitCrossJurisdictionIntent(
    route: CrossJurisdictionSwapRoute,
  ): Promise<RuntimeAdapterCrossJurisdictionIntentResult> {
    const env = this.resolveEnv();
    if (!env) throw new RuntimeAdapterError('E_INTERNAL', 'embedded runtime env is not ready', true);
    this.requireCommandReady(env);
    return await this.deps.submitCrossJurisdictionIntent(env, route);
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

  private resolveEnv(): RuntimeState | null {
    return this.deps.getEnv() ?? this.env;
  }

  /**
   * Copy only committed scalar metadata out of the live Runtime object.
   *
   * Runtime frame construction mutates its owned State in place for
   * performance. Holding the object here is necessary for ingress, but UI
   * status must be a value snapshot so an uncommitted H+1 cannot leak.
   */
  private publishCommittedMetadata(env: RuntimeState): void {
    if (ensureRuntimeState(env).stateMutationInFlight) {
      throw new RuntimeAdapterError(
        'E_INTERNAL',
        'RUNTIME_COMMITTED_STATE_UNAVAILABLE_RELOAD_REQUIRED',
        true,
      );
    }
    const readiness = getRuntimeCommandReadiness(env);
    this.publishedRuntimeId = String(env.runtimeId || this.configuredRuntimeId || 'embedded')
      .trim()
      .toLowerCase();
    this.publishedHeight = Math.max(0, Math.floor(Number(env.height ?? 0)));
    this.publishedCommandReady = readiness.ready;
    this.publishedCommandReadyReason = readiness.reason;
  }

  private requireCommandReady(env: RuntimeState): void {
    try {
      assertRuntimeCommandReady(env);
    } catch (error) {
      throw new RuntimeAdapterError(
        'E_COMMAND_PENDING',
        error instanceof Error ? error.message : String(error),
        true,
        250,
      );
    }
  }
}
