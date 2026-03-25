/**
 * End-to-end test script
 *
 * Reads CONTRACT_ADDRESS from backend/.env and runs all escrow flows
 * against the already-deployed contract, then checks the REST APIs.
 *
 * Steps:
 *   1. npx hardhat node
 *   2. npx hardhat run scripts/deploy.js --network localhost
 *   3. node backend/server.js
 *   4. npx hardhat run scripts/e2e-test.js --network localhost
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const API_BASE = "http://localhost:3000";
const ENV_PATH = path.join(__dirname, "..", "backend", ".env");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchApi(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`);
    return await res.json();
  } catch {
    return null;
  }
}

function getContractAddress() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error("backend/.env not found. Run: npx hardhat run scripts/deploy.js --network localhost");
  }
  const env = fs.readFileSync(ENV_PATH, "utf8");
  const match = env.match(/^CONTRACT_ADDRESS=(.+)$/m);
  if (!match || !match[1]) {
    throw new Error("CONTRACT_ADDRESS not set in backend/.env. Run: npx hardhat run scripts/deploy.js --network localhost");
  }
  return match[1].trim();
}

async function main() {
  const [buyer, seller, arbitrator] = await ethers.getSigners();
  const METADATA = "bafkreihicvybv63casb2k37lg4dd37h4huqo4etq32cbsevjhnxwzqivzm";
  const ONE_ETH = ethers.parseEther("1");
  const DELIVERY_TIMEOUT = 60;
  const RESPONSE_TIMEOUT = 30;

  // wipe old data from MongoDB before starting fresh
  // console.log("=== Resetting database ===");
  // try {
  //   const res = await fetch(`${API_BASE}/reset`, { method: "DELETE" });
  //   const body = await res.json();
  //   console.log(`  ${body.message}\n`);
  // } catch {
  //   console.log("  ⚠ Backend not running — skipping DB reset\n");
  // }

  // connect to the already-deployed contract
  const contractAddress = getContractAddress();
  const Escrow = await ethers.getContractFactory("Escrow");
  const escrow = Escrow.attach(contractAddress);
  console.log(`Using contract at: ${contractAddress}`);

  const startId = Number(await escrow.nextEscrowId());
  console.log(`Next escrow ID: ${startId}\n`);
 
  // ─── Happy path (create → deliver → release) ───
  console.log(`=== Escrow #${startId}: Happy path ===`);

  console.log("  Creating escrow (1 ETH)...");
  let tx = await escrow.connect(buyer).createEscrow(
    seller.address, arbitrator.address, METADATA,
    DELIVERY_TIMEOUT, RESPONSE_TIMEOUT,
    { value: ONE_ETH }
  );
  await tx.wait();
  console.log("  ✓ EscrowCreated");

  console.log("  Seller marking as delivered...");
  tx = await escrow.connect(seller).markDelivered(startId);
  await tx.wait();
  console.log("  ✓ Delivered");

  console.log("  Buyer releasing funds...");
  tx = await escrow.connect(buyer).releaseFunds(startId);
  await tx.wait();
  console.log("  ✓ FundsReleased → seller got 1 ETH");

  let e = await escrow.getEscrow(startId);
  console.log(`  Final state: ${["Pending","Delivered","Disputed","Resolved","Cancelled"][Number(e.state)]}`);

  // ─── Dispute path (create → deliver → dispute → resolve with 50/50 split) ───
  const id1 = startId + 1;
  console.log(`\n=== Escrow #${id1}: Dispute path (50/50 split) ===`);

  tx = await escrow.connect(buyer).createEscrow(
    seller.address, arbitrator.address, METADATA,
    DELIVERY_TIMEOUT, RESPONSE_TIMEOUT,
    { value: ONE_ETH }
  );
  await tx.wait();
  console.log("  ✓ EscrowCreated");

  tx = await escrow.connect(seller).markDelivered(id1);
  await tx.wait();
  console.log("  ✓ Delivered");

  tx = await escrow.connect(buyer).raiseDispute(id1);
  await tx.wait();
  console.log("  ✓ DisputeOpened");

  const half = ONE_ETH / 2n;
  tx = await escrow.connect(arbitrator).resolveDispute(id1, half, half);
  await tx.wait();
  console.log("  ✓ DisputeResolved (0.5 ETH each)");

  e = await escrow.getEscrow(id1);
  console.log(`  Final state: ${["Pending","Delivered","Disputed","Resolved","Cancelled"][Number(e.state)]}`);

  // ─── Timeout cancellation (seller doesn't deliver) ───
  const id2 = startId + 2;
  console.log(`\n=== Escrow #${id2}: Buyer cancels after delivery timeout ===`);

  tx = await escrow.connect(buyer).createEscrow(
    seller.address, arbitrator.address, METADATA,
    DELIVERY_TIMEOUT, RESPONSE_TIMEOUT,
    { value: ONE_ETH }
  );
  await tx.wait();
  console.log("  ✓ EscrowCreated");

  console.log(`  Fast-forwarding ${DELIVERY_TIMEOUT + 1}s...`);
  await ethers.provider.send("evm_increaseTime", [DELIVERY_TIMEOUT + 1]);
  await ethers.provider.send("evm_mine");

  tx = await escrow.connect(buyer).cancelExpiredEscrow(id2);
  await tx.wait();
  console.log("  ✓ EscrowCancelled — buyer refunded");

  e = await escrow.getEscrow(id2);
  console.log(`  Final state: ${["Pending","Delivered","Disputed","Resolved","Cancelled"][Number(e.state)]}`);

  // ─── Seller claims after buyer goes silent ───
  const id3 = startId + 3;
  console.log(`\n=== Escrow #${id3}: Seller claims after response timeout ===`);

  tx = await escrow.connect(buyer).createEscrow(
    seller.address, arbitrator.address, METADATA,
    DELIVERY_TIMEOUT, RESPONSE_TIMEOUT,
    { value: ONE_ETH }
  );
  await tx.wait();
  console.log("  ✓ EscrowCreated");

  tx = await escrow.connect(seller).markDelivered(id3);
  await tx.wait();
  console.log("  ✓ Delivered");

  console.log(`  Fast-forwarding ${RESPONSE_TIMEOUT + 1}s...`);
  await ethers.provider.send("evm_increaseTime", [RESPONSE_TIMEOUT + 1]);
  await ethers.provider.send("evm_mine");

  tx = await escrow.connect(seller).claimAfterTimeout(id3);
  await tx.wait();
  console.log("  ✓ Seller claimed funds after buyer timeout");

  e = await escrow.getEscrow(id3);
  console.log(`  Final state: ${["Pending","Delivered","Disputed","Resolved","Cancelled"][Number(e.state)]}`);

  // ─── Check APIs ───
  console.log("\n=== Checking REST APIs ===");
  console.log("  Waiting 10s for event listener to catch up...");
  await sleep(10000);

  const allEscrows = await fetchApi("/escrows");
  if (allEscrows && Array.isArray(allEscrows)) {
    console.log(`  GET /escrows → ${allEscrows.length} escrow(s) found`);
    for (const esc of allEscrows) {
      console.log(`    #${esc.escrowId}: state=${esc.state}, events=${esc.events.length}`);
    }
  } else {
    console.log("  ⚠ Backend not running or returned unexpected data — skipping API checks");
    console.log("    Make sure 'node backend/server.js' is running");
    console.log("\n=== All done! ===");
    return;
  }

  console.log(`\n  GET /escrow/${id1} (dispute path):`);
  const single = await fetchApi(`/escrow/${id1}`);
  if (single && single.events) {
    console.log(`    state: ${single.state}`);
    console.log(`    events:`);
    for (const ev of single.events) {
      console.log(`      - ${ev.event} (block ${ev.blockNumber})`);
    }
  } else {
    console.log(`    response: ${JSON.stringify(single)}`);
  }

  console.log("\n  GET /escrow/999 (should 404):");
  const missing = await fetchApi("/escrow/999");
  console.log(`    response: ${JSON.stringify(missing)}`);

  console.log("\n=== All done! ===");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
