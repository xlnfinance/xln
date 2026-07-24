const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

const DepositoryModule = buildModule("DepositoryModule", (m) => {
  console.log("🔍 IGNITION: Starting deployment...");
  const foundationRecipient = m.getParameter("foundationRecipient", m.getAccount(0));
  const disputeDelayBlocks = m.getParameter("defaultDisputeDelayBlocks", 5760);

  // 1. Deploy the verifier library and linked EntityProvider first
  const hankoVerifier = m.library('HankoVerifier');
  const entityProvider = m.contract('EntityProvider', [foundationRecipient], {
    libraries: { HankoVerifier: hankoVerifier },
  });
  console.log("🔍 IGNITION: EntityProvider deployed");

  // 2. Deploy Account library
  const accountLibrary = m.library('Account');

  // 3. Deploy Depository with immutable EP address
  const depository = m.contract('Depository', [entityProvider, disputeDelayBlocks], {
    id: 'Depository',
    libraries: {
      Account: accountLibrary
    }
  });
  console.log("🔍 IGNITION: Depository deployed with immutable EP");

  // 4. Deploy test tokens
  const erc20Mock = m.contract('ERC20Mock', ["ERC20Mock", "ERC20", 18, 1000000]);
  const erc721Mock = m.contract('ERC721Mock', ["ERC721Mock", "ERC721"]);
  const erc1155Mock = m.contract('ERC1155Mock');

  // Depository constructor already registers the EntityProvider.
  // Do not call addEntityProvider again (reverts with "exists").

  return { depository, entityProvider, erc20Mock, erc721Mock, erc1155Mock  };
});

module.exports = DepositoryModule;
