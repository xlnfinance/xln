const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

const DepositoryModule = buildModule("DepositoryModule", (m) => {
  console.log("🔍 IGNITION: Starting deployment...");

  // 1. Deploy EntityProvider FIRST
  const entityProvider = m.contract('EntityProvider');
  console.log("🔍 IGNITION: EntityProvider deployed");

  // 2. Deploy Account library
  const accountLibrary = m.library('Account');

  // 3. Deploy Depository with immutable EP address
  const depository = m.contract('Depository', [entityProvider], {
    id: 'Depository',
    libraries: {
      Account: accountLibrary
    }
  });
  console.log("🔍 IGNITION: Depository deployed with immutable EP");

  // 4. Deploy test tokens
  const erc20Mock = m.contract('ERC20Mock', ["ERC20Mock", "ERC20", 1000000]);
  const erc721Mock = m.contract('ERC721Mock', ["ERC721Mock", "ERC721"]);
  const erc1155Mock = m.contract('ERC1155Mock');

  // Approve EntityProvider in Depository (legacy support)
  m.call(depository, "addEntityProvider", [entityProvider]);

  return { depository, entityProvider, erc20Mock, erc721Mock, erc1155Mock  };
});

module.exports = DepositoryModule;
