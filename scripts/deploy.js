/**
 * Deploys the Escrow contract and updates backend/.env automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network localhost
 *
 * After this, start (or restart) the backend:
 *   node backend/server.js
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", "backend", ".env");

async function main() {
  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  const addr = await escrow.getAddress();
  console.log(`Escrow deployed at: ${addr}`);

  // update backend/.env
  if (fs.existsSync(ENV_PATH)) {
    let env = fs.readFileSync(ENV_PATH, "utf8");
    env = env.replace(/^CONTRACT_ADDRESS=.*$/m, `CONTRACT_ADDRESS=${addr}`);
    fs.writeFileSync(ENV_PATH, env);
    console.log(`Updated backend/.env`);
  } else {
    console.log(`No backend/.env found — create one from .env.example and set CONTRACT_ADDRESS=${addr}`);
  }

  console.log("\nNow start the backend:  node backend/server.js");
  console.log("Then run the e2e test:  npx hardhat run scripts/e2e-test.js --network localhost");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
