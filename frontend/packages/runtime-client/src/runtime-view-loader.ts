import { runtimeViewFrameMatchesAtHeight } from './runtime-view-model';
import {
  createDisconnectedRuntimeViewState,
  createErrorRuntimeViewState,
  createSuccessRuntimeViewState,
  type RuntimeViewHandleModel,
  type RuntimeViewHeadModel,
  type RuntimeViewResultFrameModel,
  type RuntimeViewState,
} from './runtime-view-state';

export type RuntimeViewLoadOutcome<
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> =
  | Readonly<{
    kind: 'disconnected';
    view: RuntimeViewState<Head, Entity, Frame>;
    frame: null;
  }>
  | Readonly<{
    kind: 'success';
    view: RuntimeViewState<Head, Entity, Frame>;
    frame: Frame;
  }>
  | Readonly<{
    kind: 'error';
    view: RuntimeViewState<Head, Entity, Frame>;
    frame: null;
  }>;

export type RuntimeViewLoaderDependencies<Query, Head, Frame> = Readonly<{
  readCurrentHandle: () => RuntimeViewHandleModel;
  readHead: () => Promise<Head>;
  readFrame: (query: Query) => Promise<Frame>;
}>;

export class RuntimeViewLoader<
  Query,
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> {
  constructor(
    private readonly dependencies: RuntimeViewLoaderDependencies<Query, Head, Frame>,
  ) {}

  readonly load = async (
    handle: RuntimeViewHandleModel,
    atHeight: number | null,
    query: Query,
  ): Promise<RuntimeViewLoadOutcome<Head, Entity, Frame>> => {
    if (handle.status !== 'connected') {
      return {
        kind: 'disconnected',
        view: createDisconnectedRuntimeViewState<Head, Entity, Frame>(handle, atHeight),
        frame: null,
      };
    }

    try {
      const [head, frame] = await Promise.all([
        this.dependencies.readHead(),
        this.dependencies.readFrame(query),
      ]);
      if (!runtimeViewFrameMatchesAtHeight(frame, atHeight)) {
        throw new Error(
          `RuntimeView returned h${Number(frame.height || 0)} for selected h${atHeight}`,
        );
      }
      return {
        kind: 'success',
        view: createSuccessRuntimeViewState<Head, Entity, Frame>(
          handle,
          atHeight,
          head,
          frame,
        ),
        frame,
      };
    } catch (error) {
      return {
        kind: 'error',
        view: createErrorRuntimeViewState<Head, Entity, Frame>(
          this.dependencies.readCurrentHandle(),
          atHeight,
          error,
        ),
        frame: null,
      };
    }
  };
}
