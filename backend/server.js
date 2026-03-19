const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const { startListener } = require("./listener");
const escrowRoutes = require("./routes/escrows");

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/escrow";
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

async function main() {
  // Connect to MongoDB
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  // Express setup
  const app = express();
  app.use(express.json());
  app.use("/", escrowRoutes);

  // Start event listener if contract address is provided
  if (CONTRACT_ADDRESS) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    startListener(CONTRACT_ADDRESS, provider);
  } else {
    console.warn("CONTRACT_ADDRESS not set — event listener disabled");
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
