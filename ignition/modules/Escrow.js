const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("EscrowModule", (m) => {
  const escrow = m.contract("Escrow");
  return { escrow };
});
