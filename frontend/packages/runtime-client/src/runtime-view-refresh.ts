import type { RuntimeAdapterMode } from './runtime-handle';
import {
  runtimeViewSelectionsEqual,
  type RuntimeViewSelection,
} from './runtime-view-selection';

export type RuntimeViewRefreshTarget = Readonly<{
  runtimeId: string;
  mode: RuntimeAdapterMode;
  selection: RuntimeViewSelection;
}>;

export type RuntimeViewRefreshLease = RuntimeViewRefreshTarget & Readonly<{
  generation: number;
}>;

export type RuntimeViewRefreshDependencies = Readonly<{
  readTarget: () => RuntimeViewRefreshTarget;
}>;

export class RuntimeViewRefreshCoordinator {
  private generation = 0;

  constructor(private readonly dependencies: RuntimeViewRefreshDependencies) {}

  readonly begin = (): RuntimeViewRefreshLease => ({
    generation: ++this.generation,
    ...this.dependencies.readTarget(),
  });

  readonly invalidate = (): void => {
    this.generation += 1;
  };

  readonly isCurrent = (lease: RuntimeViewRefreshLease): boolean => {
    if (lease.generation !== this.generation) return false;
    const current = this.dependencies.readTarget();
    return current.runtimeId === lease.runtimeId &&
      current.mode === lease.mode &&
      runtimeViewSelectionsEqual(current.selection, lease.selection);
  };
}
