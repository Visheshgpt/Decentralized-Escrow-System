# Decentralized Escrow System

An on-chain escrow between a buyer and seller, with an arbitrator who steps in if things go sideways. There's also a small Node.js backend that indexes contract events into MongoDB and serves them over REST.

## Quick start

```bash
npm install
npx hardhat compile
npx hardhat test
```

You'll need Node >= 18 and MongoDB running if you want to use the backend.

## Project layout

```
contracts/
  Escrow.sol              – the main contract
test/
  Escrow.js               – 22 tests
ignition/modules/
  Escrow.js               – Hardhat Ignition deploy script
backend/
  server.js               – Express + Mongo entry point
  listener.js             – listens to on-chain events and writes to DB
  models/Escrow.js        – Mongoose schema
  routes/escrows.js       – API routes
  .env.example            – copy this to .env and fill in values
```

## Deploy locally

In one terminal, spin up a local node:

```bash
npx hardhat node
```

In another, deploy:

```bash
npx hardhat ignition deploy ignition/modules/Escrow.js --network localhost
```

Grab the contract address from the output — we'll need it for the backend.

## Backend setup

```bash
cp backend/.env.example backend/.env
```

Fill in `.env`:

```
PORT=3000
MONGO_URI=mongodb://localhost:27017/escrow
RPC_URL=http://127.0.0.1:8545
CONTRACT_ADDRESS=0x...   # paste the deployed address here
```

Then run:

```bash
node backend/server.js
```

### API

**GET /escrows** — returns all escrows

**GET /escrow/:id** — returns a single escrow with its event history

Example response for `/escrow/0`:

```json
{
  "_id": "69baee7122fb1173f2cd4e42",
  "escrowId": 0,
  "__v": 0,
  "amount": "1000000000000000000",
  "arbitrator": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "buyer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "createdAt": "2026-03-18T18:26:57.097Z",
  "events": [
    {
      "event": "EscrowCreated",
      "data": {
        "escrowId": 0,
        "buyer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "seller": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "arbitrator": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        "amount": "1000000000000000000",
        "metadataHash": "bafkreihicvybv63casb2k37lg4dd37h4huqo4etq32cbsevjhnxwzqivzm"
      },
      "transactionHash": "0x15c146a8c153e111d359c941a221864705b6fc598d8a7d2f42142fcf7f1c8fdd",
      "blockNumber": 2,
      "logIndex": 0,
      "_id": "69baee714be6db088636b219"
    }, {},{}
  ],
  "metadataHash": "bafkreihicvybv63casb2k37lg4dd37h4huqo4etq32cbsevjhnxwzqivzm",
  "seller": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "state": "Resolved",
  "updatedAt": "2026-03-18T18:26:57.148Z",
  "deliveredAt": 3,
  "resolvedAt": 4,
  "sellerPayout": "1000000000000000000"
}
```

## One-command deploy

Instead of using Hardhat Ignition separately, the deploy script deploys the contract **and** patches `backend/.env` with the new contract address automatically:

```bash
# terminal 1 — local node
npx hardhat node

# terminal 2 — deploy + auto-configure backend
cp backend/.env.example backend/.env   # first time only
npx hardhat run scripts/deploy.js --network localhost
```

After deploying, start the backend:

```bash
node backend/server.js
```

## End-to-end test

The e2e script exercises all four escrow flows (happy path, dispute, delivery timeout cancellation, response timeout claim) against the deployed contract, then verifies the REST API returns the correct data.

**Prerequisites:** the local node, deployed contract, and backend must all be running

```bash
npx hardhat run scripts/e2e-test.js --network localhost
```

What it covers:

1. **Happy path** — create escrow, seller delivers, buyer releases funds
2. **Dispute (50/50 split)** — create, deliver, buyer disputes, arbitrator splits evenly
3. **Delivery timeout** — seller never delivers, buyer cancels after deadline
4. **Response timeout** — buyer goes silent after delivery, seller claims funds
5. **REST API checks** — `GET /escrows` and `GET /escrow/:id` return expected data

## How the contract works

The flow looks like this:

```
Pending ──> Delivered ──> Resolved       (buyer happy, releases funds)
   |             |
   |             |──> Disputed ──> Resolved   (arbitrator decides the split)
   |             |
   |             └──> Resolved       (buyer ghosted, seller claims after timeout)
   |
   └──> Cancelled       (seller never delivered, buyer cancels)
```

**Who can do what:**

- **Buyer** creates the escrow (deposits ETH), releases funds after delivery, or raises a dispute
- **Seller** marks the order as delivered, or claims funds if the buyer goes silent
- **Arbitrator** resolves disputes — can do a full refund, full payout, or any split in between

### Timeouts

Two time-based safeguards protect both parties:

1. The seller has `deliveryTimeout` seconds to deliver. If they don't, the buyer can call `cancelExpiredEscrow()` and get their ETH back.
2. After delivery, the buyer has `responseTimeout` seconds to either release or dispute. If they do nothing, the seller can call `claimAfterTimeout()`.

I used `uint32` for timestamps (good until 2106). The timeouts are meant to be days/weeks long, so the few-second drift miners can introduce to `block.timestamp` isn't a real concern here.

## Security

**Reentrancy** — the contract inherits OpenZeppelin's `ReentrancyGuard`. Every function that sends ETH is marked `nonReentrant`. On top of that, I follow the checks-effects-interactions pattern: state gets zeroed out (amount = 0, state = Resolved) before any `.call{value}` happens. So even without the guard, there'd be nothing to re-enter for.

**Access control** — each function is gated behind `onlyBuyer`, `onlySeller`, or `onlyArbitrator` modifiers. The `inState` modifier makes sure we can't skip steps (e.g., you can't release funds on a Pending escrow).

**Validation** — buyer/seller/arbitrator must all be different non-zero addresses. Deposit can't be zero. Timeouts can't be zero. The arbitrator's split must add up exactly to the escrowed amount.

**Overflow** — Solidity 0.8 handles this natively. The one place where arithmetic matters (`buyerAmount + sellerAmount`) is explicitly checked against `e.amount`.

**Front-running** — not really a concern since every state transition is role-gated. Nobody can front-run the arbitrator's decision because only the arbitrator can call `resolveDispute`.

## Gas optimizations

A few choices I made:

- **Struct packing** — `EscrowData` fields are ordered so addresses (20 bytes) share slots with the `State` enum (1 byte) and `uint32` timestamps (4 bytes). This brings the struct down from 7+ slots to 5.
- **uint32 timestamps** — 28 bytes smaller than uint256, which makes the packing above possible.
- **One mapping** — all escrow data lives in a single `mapping(uint256 => EscrowData)` instead of spreading fields across multiple mappings.
- **Custom errors** — `OnlyBuyer()`, `InvalidSplit()`, etc. are much cheaper than `require("only buyer")` strings, both at deploy time and on revert.
- **Minimal writes** — each state transition only touches the fields that actually change. For example, `raiseDispute` writes one storage slot (just the state).

## Tests

22 tests covering:

- Escrow creation (params, validation, ID increment, events)
- Happy path (deliver → release funds)
- Disputes (full refund, full payout, partial split, bad split, wrong caller)
- Timeouts (cancel after deadline, claim after timeout, premature attempts blocked)

```bash
npx hardhat test

# with gas report
REPORT_GAS=true npx hardhat test
```
