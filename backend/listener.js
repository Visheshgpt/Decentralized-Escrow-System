const { ethers } = require("ethers");
const Escrow = require("./models/Escrow");
const Checkpoint = require("./models/Checkpoint");
const artifact = require("../artifacts/contracts/Escrow.sol/Escrow.json");

const CHECKPOINT_KEY = "lastProcessedBlock";

// ─── simple sequential queue ───
// events get pushed here and processed one at a time, in order.

const queue = [];
let processing = false;

function enqueue(task) {
  queue.push(task);
  if (!processing) drain();
}

async function drain() {
  processing = true;
  while (queue.length > 0) {
    const task = queue.shift();
    try {
      await task();
    } catch (err) {
      console.error("[Queue] task failed:", err.message);
    }
  }
  processing = false;
}

// ─── checkpoint ───

async function getCheckpoint() {
  const cp = await Checkpoint.findOne({ key: CHECKPOINT_KEY });
  return cp ? cp.blockNumber : 0;
}

async function saveCheckpoint(blockNumber) {
  await Checkpoint.findOneAndUpdate(
    { key: CHECKPOINT_KEY },
    { blockNumber },
    { upsert: true }
  );
}

// ─── write one event to the DB ───

async function handleEvent(name, args, log) {
  // deduplicate using txHash + logIndex
  // multiple events of the same type in one tx (e.g. two FundsReleased in resolveDispute)
  const alreadyExists = await Escrow.findOne({
    "events.transactionHash": log.transactionHash,
    "events.logIndex": log.index,
  });
  if (alreadyExists) return;

  switch (name) {
    case "EscrowCreated": {
      const [escrowId, buyer, seller, arbitrator, amount, metadataHash] = args;
      const entry = {
        event: name,
        data: { escrowId: Number(escrowId), buyer, seller, arbitrator, amount: amount.toString(), metadataHash },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      await Escrow.findOneAndUpdate(
        { escrowId: Number(escrowId) },
        {
          escrowId: Number(escrowId),
          buyer, seller, arbitrator,
          amount: amount.toString(),
          metadataHash,
          state: "Pending",
          $push: { events: entry },
        },
        { upsert: true, new: true }
      );
      break;
    }
    case "Delivered": {
      const escrowId = Number(args[0]);
      const entry = {
        event: name,
        data: { escrowId },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      await Escrow.findOneAndUpdate(
        { escrowId },
        { state: "Delivered", deliveredAt: log.blockNumber, $push: { events: entry } }
      );
      break;
    }
    case "DisputeOpened": {
      const escrowId = Number(args[0]);
      const entry = {
        event: name,
        data: { escrowId },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      await Escrow.findOneAndUpdate(
        { escrowId },
        { state: "Disputed", disputedAt: log.blockNumber, $push: { events: entry } }
      );
      break;
    }
    case "DisputeResolved": {
      const [escrowId, buyerAmount, sellerAmount] = args;
      const entry = {
        event: name,
        data: { escrowId: Number(escrowId), buyerAmount: buyerAmount.toString(), sellerAmount: sellerAmount.toString() },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      await Escrow.findOneAndUpdate(
        { escrowId: Number(escrowId) },
        {
          state: "Resolved",
          resolvedAt: log.blockNumber,
          buyerPayout: buyerAmount.toString(),
          sellerPayout: sellerAmount.toString(),
          $push: { events: entry },
        }
      );
      break;
    }
    case "FundsReleased": {
      const [escrowId, to, amount] = args;
      const entry = {
        event: name,
        data: { escrowId: Number(escrowId), to, amount: amount.toString() },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      // figure out if the recipient is the buyer or seller and record the payout
      const doc = await Escrow.findOne({ escrowId: Number(escrowId) });
      const update = { $push: { events: entry } };
      if (doc) {
        if (to.toLowerCase() === doc.seller.toLowerCase()) {
          update.sellerPayout = amount.toString();
        } else if (to.toLowerCase() === doc.buyer.toLowerCase()) {
          update.buyerPayout = amount.toString();
        }
        // if it came from releaseFunds or claimAfterTimeout, mark resolved
        if (doc.state === "Delivered") {
          update.state = "Resolved";
          update.resolvedAt = log.blockNumber;
        }
      }
      await Escrow.findOneAndUpdate({ escrowId: Number(escrowId) }, update);
      break;
    }
    case "EscrowCancelled": {
      const escrowId = Number(args[0]);
      const entry = {
        event: name,
        data: { escrowId },
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      await Escrow.findOneAndUpdate(
        { escrowId },
        { state: "Cancelled", resolvedAt: log.blockNumber, $push: { events: entry } }
      );
      break;
    }
    default:
      return;
  }

  console.log(`[Event] ${name} #${args[0]}`);
  await saveCheckpoint(log.blockNumber);
}

// ─── replay missed events from a given block ───

async function replayFrom(contract, provider, fromBlock) {
  const toBlock = await provider.getBlockNumber();
  if (fromBlock > toBlock) return;

  console.log(`[Replay] Catching up blocks ${fromBlock} → ${toBlock}...`);
  const logs = await provider.getLogs({
    address: await contract.getAddress(),
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
    if (parsed) {
      await handleEvent(parsed.name, parsed.args, log);
    }
  }
  console.log(`[Replay] Done — processed ${logs.length} log(s)`);
}

// ─── main entry: live listeners + one-time catch-up ───

function startListener(contractAddress, provider) {
  const contract = new ethers.Contract(contractAddress, artifact.abi, provider);

  // all live events go through the queue so they're processed one at a time
  contract.on("EscrowCreated", (escrowId, buyer, seller, arbitrator, amount, metadataHash, ev) => {
    enqueue(() => handleEvent("EscrowCreated", [escrowId, buyer, seller, arbitrator, amount, metadataHash], ev.log));
  });

  contract.on("Delivered", (escrowId, ev) => {
    enqueue(() => handleEvent("Delivered", [escrowId], ev.log));
  });

  contract.on("DisputeOpened", (escrowId, ev) => {
    enqueue(() => handleEvent("DisputeOpened", [escrowId], ev.log));
  });

  contract.on("DisputeResolved", (escrowId, buyerAmount, sellerAmount, ev) => {
    enqueue(() => handleEvent("DisputeResolved", [escrowId, buyerAmount, sellerAmount], ev.log));
  });

  contract.on("FundsReleased", (escrowId, to, amount, ev) => {
    enqueue(() => handleEvent("FundsReleased", [escrowId, to, amount], ev.log));
  });

  contract.on("EscrowCancelled", (escrowId, ev) => {
    enqueue(() => handleEvent("EscrowCancelled", [escrowId], ev.log));
  });

  console.log(`[Listener] Watching events on ${contractAddress}`);

  // on startup, replay anything we missed while offline
  getCheckpoint().then((lastBlock) => {

    console.log("lastBlock", lastBlock);
    
    if (lastBlock >= 0) {
      return replayFrom(contract, provider, lastBlock + 1);
    }
  }).catch((err) => console.error("[Replay] Startup catch-up failed:", err.message));

  return contract;
}

module.exports = { startListener };
