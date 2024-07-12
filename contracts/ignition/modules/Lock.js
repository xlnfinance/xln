"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const modules_1 = require("@nomicfoundation/hardhat-ignition/modules");
const JAN_1ST_2030 = 1893456000;
const ONE_GWEI = 1000000000n;
const LockModule = (0, modules_1.buildModule)("LockModule", (m) => {
    const unlockTime = m.getParameter("unlockTime", JAN_1ST_2030);
    const lockedAmount = m.getParameter("lockedAmount", ONE_GWEI);
    const lock = m.contract("Lock", [unlockTime], {
        value: lockedAmount,
    });
    const dep = m.contract('Depository');
    return { lock, dep };
});
exports.default = LockModule;
//# sourceMappingURL=Lock.js.map