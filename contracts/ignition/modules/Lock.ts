import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const JAN_1ST_2030 = 1893456000;
const ONE_GWEI: bigint = 1_000_000_000n;

const LockModule = buildModule("LockModule", (m) => {
  const unlockTime = m.getParameter("unlockTime", JAN_1ST_2030);
  const lockedAmount = m.getParameter("lockedAmount", ONE_GWEI);

  const lock = m.contract("Lock", [unlockTime], {
    value: lockedAmount,
  });
  const dep = m.contract('Depository')
  const erc20Mock = m.contract('ERC20Mock', ["ERC20Mock", "ERC20", 1000000])
  const erc721Mock = m.contract('ERC721Mock', ["ERC721Mock", "ERC721"])
  const erc1155Mock = m.contract('ERC1155Mock')

  return { lock, dep, erc20Mock, erc721Mock, erc1155Mock  };
});

export default LockModule;
