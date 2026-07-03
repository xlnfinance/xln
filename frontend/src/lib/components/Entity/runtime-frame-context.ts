export type EntityWorkspaceRuntimeFrameContext = {
  envRevision: string;
  timeIndex: number;
  isLive: boolean;
  onGoToLive: () => void;
};

export const emptyEntityWorkspaceRuntimeFrameContext: EntityWorkspaceRuntimeFrameContext = {
  envRevision: '',
  timeIndex: -1,
  isLive: true,
  onGoToLive: () => undefined,
};
