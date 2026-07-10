export type HubRuntimeHealthInput = {
  processExitCode: number | null | undefined;
  hasHealth: boolean;
  hasSelfRelayPresence: boolean;
};

export type HubRuntimeHealth = {
  online: boolean;
  selfRelayPresence: boolean;
};

export type ResetHealthInput = {
  inProgress: boolean;
  lastError: string | null;
  resolvedAt: number | null;
};

export const deriveHubRuntimeHealth = (input: HubRuntimeHealthInput): HubRuntimeHealth => ({
  online: input.processExitCode === null && input.hasHealth,
  selfRelayPresence: input.hasSelfRelayPresence,
});

export const deriveResetHealthOk = (input: ResetHealthInput): boolean =>
  !input.inProgress && (!input.lastError || input.resolvedAt !== null);
