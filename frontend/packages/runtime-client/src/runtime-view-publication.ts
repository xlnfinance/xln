import type {
  RuntimeViewLoadOutcome,
} from './runtime-view-loader';
import { runtimeViewQueryAtHeight } from './runtime-view-model';
import type {
  RuntimeViewRefreshCoordinator,
} from './runtime-view-refresh';
import {
  createLoadingRuntimeViewState,
  type RuntimeViewHandleModel,
  type RuntimeViewHeadModel,
  type RuntimeViewResultFrameModel,
  type RuntimeViewState,
} from './runtime-view-state';

type RuntimeViewLoadReader<
  Query,
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> = Readonly<{
  load: (
    handle: RuntimeViewHandleModel,
    atHeight: number | null,
    query: Query,
  ) => Promise<RuntimeViewLoadOutcome<Head, Entity, Frame>>;
}>;

export type RuntimeViewPublicationDependencies<
  Query extends object,
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> = Readonly<{
  refresh: Pick<RuntimeViewRefreshCoordinator, 'begin' | 'isCurrent'>;
  loader: RuntimeViewLoadReader<Query, Head, Entity, Frame>;
  readHandle: () => RuntimeViewHandleModel;
  readView: () => RuntimeViewState<Head, Entity, Frame>;
  publishLoading: (view: RuntimeViewState<Head, Entity, Frame>) => void;
  publishSuccess: (view: RuntimeViewState<Head, Entity, Frame>, frame: Frame) => void;
  publishUnavailable: (view: RuntimeViewState<Head, Entity, Frame>) => void;
}>;

export class RuntimeViewPublicationCoordinator<
  Query extends object,
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> {
  constructor(
    private readonly dependencies: RuntimeViewPublicationDependencies<Query, Head, Entity, Frame>,
  ) {}

  readonly refresh = async (inputQuery: Query): Promise<RuntimeViewState<Head, Entity, Frame>> => {
    const refreshLease = this.dependencies.refresh.begin();
    const handle = this.dependencies.readHandle();
    const expectedAtHeight = refreshLease.selection.atHeight;
    const query = runtimeViewQueryAtHeight(inputQuery, expectedAtHeight);
    const requestStillCurrent = (): boolean =>
      this.dependencies.refresh.isCurrent(refreshLease);
    this.dependencies.publishLoading(createLoadingRuntimeViewState(
      this.dependencies.readView(),
      handle,
      expectedAtHeight,
    ));
    const outcome = await this.dependencies.loader.load(handle, expectedAtHeight, query);
    const next = outcome.view;
    // A superseded read still owns its result. Latest-wins applies only to the
    // shared publisher; callers never receive another request's transient view.
    if (!requestStillCurrent()) return next;
    if (outcome.kind === 'success') {
      this.dependencies.publishSuccess(next, outcome.frame);
      return next;
    }
    this.dependencies.publishUnavailable(next);
    return next;
  };
}
