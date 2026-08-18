type HubChildReadiness = {
  lastHealth?: {
    mesh?: { ready?: boolean };
    gossip?: { ready?: boolean };
  } | null;
};

export const areHubChildrenReady = (
  children: readonly HubChildReadiness[],
): boolean => children.every(child =>
  child.lastHealth?.mesh?.ready === true &&
  child.lastHealth?.gossip?.ready === true
);
