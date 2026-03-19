const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Escrow", function () {
  let escrow;
  let buyer, seller, arbitrator, other;
  const DELIVERY_TIMEOUT = 7 * 24 * 3600; // 7 days
  const RESPONSE_TIMEOUT = 3 * 24 * 3600; // 3 days
  const DEPOSIT = ethers.parseEther("1");
  const METADATA = "bafkreihicvybv63casb2k37lg4dd37h4huqo4etq32cbsevjhnxwzqivzm";

  beforeEach(async function () {
    [buyer, seller, arbitrator, other] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("Escrow");
    escrow = await Escrow.deploy();
  });

  describe("Escrow Creation", function () {
    it("should create an escrow with correct parameters", async function () {
      const tx = await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT,
        { value: DEPOSIT } 
      );

      await expect(tx).to.emit(escrow, "EscrowCreated")
        .withArgs(0, buyer.address, seller.address, arbitrator.address, DEPOSIT, METADATA);

      const e = await escrow.getEscrow(0);
      expect(e.buyer).to.equal(buyer.address);
      expect(e.seller).to.equal(seller.address);
      expect(e.arbitrator).to.equal(arbitrator.address);
      expect(e.amount).to.equal(DEPOSIT);
      expect(e.state).to.equal(0); // Pending
    });

    it("should reject zero value", async function () {
      await expect(
        escrow.connect(buyer).createEscrow(
          seller.address, arbitrator.address, METADATA,
          DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: 0 }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("should reject zero address for seller", async function () {
      await expect(
        escrow.connect(buyer).createEscrow(
          ethers.ZeroAddress, arbitrator.address, METADATA,
          DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("should reject buyer == seller", async function () {
      await expect(
        escrow.connect(buyer).createEscrow(
          buyer.address, arbitrator.address, METADATA,
          DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("should reject zero timeout", async function () {
      await expect(
        escrow.connect(buyer).createEscrow(
          seller.address, arbitrator.address, METADATA,
          0, RESPONSE_TIMEOUT, { value: DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "DeadlineTooShort");
    });

    it("should increment escrow IDs", async function () {
      await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
      const tx = await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
      await expect(tx).to.emit(escrow, "EscrowCreated").withArgs(
        1, buyer.address, seller.address, arbitrator.address, DEPOSIT, METADATA
      );
    });
  });

  describe("Delivery Confirmation", function () {
    beforeEach(async function () {
      await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
    });

    it("should allow seller to mark as delivered", async function () {
      const tx = await escrow.connect(seller).markDelivered(0);
      await expect(tx).to.emit(escrow, "Delivered").withArgs(0);

      const e = await escrow.getEscrow(0);
      expect(e.state).to.equal(1); // Delivered
    });

    it("should reject non-seller marking delivery", async function () {
      await expect(
        escrow.connect(buyer).markDelivered(0)
      ).to.be.revertedWithCustomError(escrow, "OnlySeller");
    });

    it("should reject marking delivery twice", async function () {
      await escrow.connect(seller).markDelivered(0);
      await expect(
        escrow.connect(seller).markDelivered(0)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
  });

  describe("Fund Release", function () {
    beforeEach(async function () {
      await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
      await escrow.connect(seller).markDelivered(0);
    });

    it("should allow buyer to release funds to seller", async function () {
      const balBefore = await ethers.provider.getBalance(seller.address);
      const tx = await escrow.connect(buyer).releaseFunds(0);
      await expect(tx).to.emit(escrow, "FundsReleased").withArgs(0, seller.address, DEPOSIT);

      const balAfter = await ethers.provider.getBalance(seller.address);
      expect(balAfter - balBefore).to.equal(DEPOSIT);

      const e = await escrow.getEscrow(0);
      expect(e.state).to.equal(3); // Resolved
      expect(e.amount).to.equal(0);
    });

    it("should reject non-buyer releasing funds", async function () {
      await expect(
        escrow.connect(seller).releaseFunds(0)
      ).to.be.revertedWithCustomError(escrow, "OnlyBuyer");
    });
  });

  describe("Dispute Mechanism", function () {
    beforeEach(async function () {
      await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
      await escrow.connect(seller).markDelivered(0);
    });

    it("should allow buyer to raise a dispute", async function () {
      const tx = await escrow.connect(buyer).raiseDispute(0);
      await expect(tx).to.emit(escrow, "DisputeOpened").withArgs(0);
      const e = await escrow.getEscrow(0);
      expect(e.state).to.equal(2); // Disputed
    });

    it("should reject non-buyer raising dispute", async function () {
      await expect(
        escrow.connect(seller).raiseDispute(0)
      ).to.be.revertedWithCustomError(escrow, "OnlyBuyer");
    });

    it("should allow arbitrator to fully refund buyer", async function () {
      await escrow.connect(buyer).raiseDispute(0);

      const balBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await escrow.connect(arbitrator).resolveDispute(0, DEPOSIT, 0);
      await expect(tx).to.emit(escrow, "DisputeResolved").withArgs(0, DEPOSIT, 0);
      await expect(tx).to.emit(escrow, "FundsReleased").withArgs(0, buyer.address, DEPOSIT);

      const balAfter = await ethers.provider.getBalance(buyer.address);
      expect(balAfter - balBefore).to.equal(DEPOSIT);
    });

    it("should allow arbitrator to fully pay seller", async function () {
      await escrow.connect(buyer).raiseDispute(0);

      const balBefore = await ethers.provider.getBalance(seller.address);
      await escrow.connect(arbitrator).resolveDispute(0, 0, DEPOSIT);
      const balAfter = await ethers.provider.getBalance(seller.address);
      expect(balAfter - balBefore).to.equal(DEPOSIT);
    });

    it("should allow arbitrator to split funds", async function () {
      await escrow.connect(buyer).raiseDispute(0);

      const half = DEPOSIT / 2n;
      const buyerBal = await ethers.provider.getBalance(buyer.address);
      const sellerBal = await ethers.provider.getBalance(seller.address);

      await escrow.connect(arbitrator).resolveDispute(0, half, half);

      expect(await ethers.provider.getBalance(buyer.address) - buyerBal).to.equal(half);
      expect(await ethers.provider.getBalance(seller.address) - sellerBal).to.equal(half);
    });

    it("should reject invalid split amounts", async function () {
      await escrow.connect(buyer).raiseDispute(0);
      await expect(
        escrow.connect(arbitrator).resolveDispute(0, DEPOSIT, DEPOSIT)
      ).to.be.revertedWithCustomError(escrow, "InvalidSplit");
    });

    it("should reject non-arbitrator resolving", async function () {
      await escrow.connect(buyer).raiseDispute(0);
      await expect(
        escrow.connect(buyer).resolveDispute(0, DEPOSIT, 0)
      ).to.be.revertedWithCustomError(escrow, "OnlyArbitrator");
    });
  });

  describe("Time-Based Safety Mechanisms", function () {
    beforeEach(async function () {
      await escrow.connect(buyer).createEscrow(
        seller.address, arbitrator.address, METADATA,
        DELIVERY_TIMEOUT, RESPONSE_TIMEOUT, { value: DEPOSIT }
      );
    });

    describe("Buyer cancellation (seller failed to deliver)", function () {
      it("should allow buyer to cancel after delivery deadline", async function () {
        await time.increase(DELIVERY_TIMEOUT + 1);

        const balBefore = await ethers.provider.getBalance(buyer.address);
        const tx = await escrow.connect(buyer).cancelExpiredEscrow(0);
        await expect(tx).to.emit(escrow, "EscrowCancelled").withArgs(0);

        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed * receipt.gasPrice;
        const balAfter = await ethers.provider.getBalance(buyer.address);
        expect(balAfter + gasUsed - balBefore).to.equal(DEPOSIT);

        const e = await escrow.getEscrow(0);
        expect(e.state).to.equal(4); // Cancelled
      });

      it("should reject cancellation before delivery deadline", async function () {
        await expect(
          escrow.connect(buyer).cancelExpiredEscrow(0)
        ).to.be.revertedWithCustomError(escrow, "DeliveryDeadlineNotReached");
      });
    });

    describe("Seller claim (buyer unresponsive after delivery)", function () {
      it("should allow seller to claim after response deadline", async function () {
        await escrow.connect(seller).markDelivered(0);
        await time.increase(RESPONSE_TIMEOUT + 1);

        const balBefore = await ethers.provider.getBalance(seller.address);
        const tx = await escrow.connect(seller).claimAfterTimeout(0);
        await expect(tx).to.emit(escrow, "FundsReleased").withArgs(0, seller.address, DEPOSIT);

        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed * receipt.gasPrice;
        const balAfter = await ethers.provider.getBalance(seller.address);
        expect(balAfter + gasUsed - balBefore).to.equal(DEPOSIT);
      });

      it("should reject seller claim before response deadline", async function () {
        await escrow.connect(seller).markDelivered(0);
        await expect(
          escrow.connect(seller).claimAfterTimeout(0)
        ).to.be.revertedWithCustomError(escrow, "ResponseDeadlineNotReached");
      });
    });
  });

});
