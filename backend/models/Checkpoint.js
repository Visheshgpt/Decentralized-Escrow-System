const mongoose = require("mongoose");

// tracks the last block we've fully processed so we know where to resume from
const checkpointSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
});

module.exports = mongoose.model("Checkpoint", checkpointSchema);
