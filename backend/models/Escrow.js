const mongoose = require("mongoose");

const escrowSchema = new mongoose.Schema(
  {
    escrowId: { type: Number, required: true, unique: true, index: true },
    buyer: { type: String, required: true },
    seller: { type: String, required: true },
    arbitrator: { type: String, required: true },
    amount: { type: String, required: true },
    metadataHash: { type: String, required: true },
    state: {
      type: String,
      enum: ["Pending", "Delivered", "Disputed", "Resolved", "Cancelled"],
      default: "Pending",
    },

    // filled in as the escrow progresses
    deliveredAt: { type: Number },         // block number when seller marked delivered
    disputedAt: { type: Number },          // block number when buyer raised dispute
    resolvedAt: { type: Number },          // block number when resolved/cancelled
    buyerPayout: { type: String },         // how much buyer got (after dispute or cancel)
    sellerPayout: { type: String },        // how much seller got (after release or dispute)

    events: [
      {
        event: String,
        data: mongoose.Schema.Types.Mixed, // full event args
        transactionHash: String,
        blockNumber: Number,
        logIndex: Number,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Escrow", escrowSchema);
