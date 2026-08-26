import type {
  RuntimeAdapterAuthLevel,
  RuntimeAdapterMode,
  RuntimeAdapterStatus,
} from './runtime-handle';
import {
  normalizeEntityIdForRuntimeView,
  type RuntimeViewFrameModel,
} from './runtime-view-model';

export type RuntimeViewHeadModel = Readonly<{ latestHeight?: unknown }>;

export type RuntimeViewResultFrameModel<Entity> = RuntimeViewFrameModel & Readonly<{
  entities?: Entity[];
}>;

export type RuntimeViewHandleModel = Readonly<{
  id: string;
  mode: RuntimeAdapterMode;
  authLevel: RuntimeAdapterAuthLevel | null;
  status: RuntimeAdapterStatus;
  height: number;
}>;

export type RuntimeViewState<
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
> = {
  runtimeId: string;
  mode: RuntimeAdapterMode;
  authLevel: RuntimeAdapterAuthLevel | null;
  status: RuntimeAdapterStatus;
  atHeight: number | null;
  height: number;
  loading: boolean;
  error: string | null;
  head: Head | null;
  frame: Frame | null;
  entities: Entity[];
  activeEntityId: string;
};

const normalizeHeight = (value: unknown): number => {
  const normalized = Math.floor(Number(value || 0));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
};

const runtimeViewHandleState = (handle: RuntimeViewHandleModel) => ({
  runtimeId: handle.id,
  mode: handle.mode,
  authLevel: handle.authLevel,
  status: handle.status,
});

export const runtimeViewErrorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value || 'RuntimeView refresh failed');

export const createEmptyRuntimeViewState = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(handle: RuntimeViewHandleModel, atHeight: number | null): RuntimeViewState<Head, Entity, Frame> => ({
  ...runtimeViewHandleState(handle),
  atHeight,
  height: atHeight ?? normalizeHeight(handle.height),
  loading: false,
  error: null,
  head: null,
  frame: null,
  entities: [],
  activeEntityId: '',
});

export const createLoadingRuntimeViewState = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  current: RuntimeViewState<Head, Entity, Frame>,
  handle: RuntimeViewHandleModel,
  atHeight: number | null,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...current,
  ...runtimeViewHandleState(handle),
  atHeight,
  height: atHeight ?? normalizeHeight(handle.height),
  loading: true,
  error: null,
});

export const createDisconnectedRuntimeViewState = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  handle: RuntimeViewHandleModel,
  atHeight: number | null,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...createEmptyRuntimeViewState<Head, Entity, Frame>(handle, atHeight),
  error: 'Runtime adapter is not connected',
});

export const createSuccessRuntimeViewState = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  handle: RuntimeViewHandleModel,
  atHeight: number | null,
  head: Head,
  frame: Frame,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...runtimeViewHandleState(handle),
  atHeight,
  height: atHeight ?? Math.max(
    normalizeHeight(handle.height),
    normalizeHeight(frame.height),
    normalizeHeight(head.latestHeight),
  ),
  loading: false,
  error: null,
  head,
  frame,
  entities: frame.entities ?? [],
  activeEntityId: normalizeEntityIdForRuntimeView(
    frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.activeEntity?.core?.entityId,
  ),
});

export const createErrorRuntimeViewState = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  handle: RuntimeViewHandleModel,
  atHeight: number | null,
  error: unknown,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...createEmptyRuntimeViewState<Head, Entity, Frame>(handle, atHeight),
  error: runtimeViewErrorMessage(error),
});

export const selectRuntimeViewHeight = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  current: RuntimeViewState<Head, Entity, Frame>,
  atHeight: number | null,
  liveHeight: number,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...current,
  atHeight,
  height: atHeight ?? normalizeHeight(liveHeight),
  loading: true,
  error: null,
  frame: null,
  entities: [],
});

export const advanceRuntimeViewHeight = <
  Head extends RuntimeViewHeadModel,
  Entity,
  Frame extends RuntimeViewResultFrameModel<Entity>,
>(
  current: RuntimeViewState<Head, Entity, Frame>,
  nextHeight: number,
): RuntimeViewState<Head, Entity, Frame> => ({
  ...current,
  height: current.atHeight ?? Math.max(current.height, normalizeHeight(nextHeight)),
});
