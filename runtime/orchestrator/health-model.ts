export type HubRuntimeHealthInput = {
  processExitCode: number | null | undefined;
  hasHealth: boolean;
  hasSelfRelayPresence: boolean;
};

export type HubRuntimeHealth = {
  online: boolean;
  selfRelayPresence: boolean;
};

export const deriveHubRuntimeHealth = (input: HubRuntimeHealthInput): HubRuntimeHealth => ({
  online: input.processExitCode === null && input.hasHealth,
  selfRelayPresence: input.hasSelfRelayPresence,
});
