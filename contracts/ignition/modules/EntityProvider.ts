import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const EntityProviderModule = buildModule("EntityProviderModule", (m) => {
  // Deploy EntityProvider contract
  const entityProvider = m.contract('EntityProvider');

  return { entityProvider };
});

export default EntityProviderModule; 