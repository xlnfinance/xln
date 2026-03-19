export type ReplayStartMode = 'default' | 'force-genesis';

export type ReplayStartSelection = {
  snapshotHeight: number;
  snapshotLabel: string;
  source: 'checkpoint' | 'forced-genesis' | 'retry-genesis';
};

export const selectReplayStart = (
  mode: ReplayStartMode,
  checkpointHeight: number,
): ReplayStartSelection => {
  if (mode === 'force-genesis') {
    return {
      snapshotHeight: 1,
      snapshotLabel: 'forced-genesis:1',
      source: 'forced-genesis',
    };
  }
  return {
    snapshotHeight: checkpointHeight,
    snapshotLabel: `checkpoint:${checkpointHeight}`,
    source: 'checkpoint',
  };
};

export const selectReplayRetryFromGenesis = (): ReplayStartSelection => {
  return {
    snapshotHeight: 1,
    snapshotLabel: 'genesis:1',
    source: 'retry-genesis',
  };
};
