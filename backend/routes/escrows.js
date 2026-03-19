const express = require("express");
const Escrow = require("../models/Escrow");
const Checkpoint = require("../models/Checkpoint");

const router = express.Router();

// DELETE /reset – wipe all escrow and checkpoint data (for testing)
router.delete("/reset", async (req, res) => {
  try {
    await Escrow.deleteMany({});
    await Checkpoint.deleteMany({});
    res.json({ message: "Database cleared" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /escrows – Fetch all escrows
router.get("/escrows", async (req, res) => {
  try {
    const escrows = await Escrow.find().sort({ escrowId: 1 });
    res.json(escrows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /escrow/:id – Fetch escrow details by ID
router.get("/escrow/:id", async (req, res) => {
  try {
    const escrow = await Escrow.findOne({ escrowId: Number(req.params.id) });
    if (!escrow) {
      return res.status(404).json({ error: "Escrow not found" });
    }
    res.json(escrow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
