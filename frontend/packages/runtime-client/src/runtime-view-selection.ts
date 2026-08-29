import {
  normalizeEntityIdForRuntimeView,
  normalizeRuntimeViewAtHeight,
} from './runtime-view-model';

export type RuntimeViewPageKind = 'accounts' | 'books';

export type RuntimeViewSelection = Readonly<{
  revision: number;
  entityId: string;
  accountsPage: number;
  booksPage: number;
  atHeight: number | null;
}>;

const normalizePage = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0));

export const runtimeViewSelectionsEqual = (
  left: RuntimeViewSelection,
  right: RuntimeViewSelection,
): boolean => left.revision === right.revision &&
  left.entityId === right.entityId &&
  left.accountsPage === right.accountsPage &&
  left.booksPage === right.booksPage &&
  left.atHeight === right.atHeight;

export type RuntimeViewSelectionCoordinatorDependencies = Readonly<{
  beforePublish?: () => void;
}>;

export class RuntimeViewSelectionCoordinator {
  private snapshot: RuntimeViewSelection = {
    revision: 0,
    entityId: '',
    accountsPage: 0,
    booksPage: 0,
    atHeight: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly dependencies: RuntimeViewSelectionCoordinatorDependencies = {},
  ) {}

  readonly getSnapshot = (): RuntimeViewSelection => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly matches = (expected: RuntimeViewSelection): boolean =>
    runtimeViewSelectionsEqual(this.snapshot, expected);

  readonly publicationMatches = (
    expectedGeneration: number,
    currentGeneration: number,
    expectedSelection: RuntimeViewSelection,
  ): boolean => expectedGeneration === currentGeneration && this.matches(expectedSelection);

  readonly setActiveEntityId = (entityId: string): boolean => {
    const normalizedEntityId = normalizeEntityIdForRuntimeView(entityId);
    if (this.snapshot.entityId === normalizedEntityId) return false;
    this.publish({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      entityId: normalizedEntityId,
      accountsPage: 0,
      booksPage: 0,
    });
    return true;
  };

  readonly setPage = (kind: RuntimeViewPageKind, pageIndex: number): boolean => {
    const safePage = normalizePage(pageIndex);
    const field = kind === 'accounts' ? 'accountsPage' : 'booksPage';
    if (this.snapshot[field] === safePage) return false;
    this.publish({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      [field]: safePage,
    });
    return true;
  };

  readonly setAtHeight = (value: number | null | undefined): boolean => {
    const atHeight = normalizeRuntimeViewAtHeight(value);
    if (this.snapshot.atHeight === atHeight) return false;
    this.publish({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      atHeight,
    });
    return true;
  };

  readonly resetNavigation = (): void => {
    this.publish({
      revision: this.snapshot.revision + 1,
      entityId: '',
      accountsPage: 0,
      booksPage: 0,
      atHeight: this.snapshot.atHeight,
    });
  };

  private publish(snapshot: RuntimeViewSelection): void {
    this.dependencies.beforePublish?.();
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
