// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Escrow
/// @notice Handles the full lifecycle of a buyer-seller deal with an arbitrator for disputes.
/// @dev Gas notes:
///   - EscrowData fields are ordered for tight slot packing (addresses + enum + uint32s share slots)
///   - uint32 for timestamps instead of uint256 — good until 2106, saves 28 bytes each
///   - custom errors over require strings — cheaper on deploy and on revert
///   - only the changed fields get written on each state transition
contract Escrow is ReentrancyGuard {
    enum State {
        Pending,
        Delivered,
        Disputed,
        Resolved,
        Cancelled
    }

    /// @dev Fields ordered for slot packing — buyer + state + two uint32 deadlines share one 32-byte slot, etc.
    struct EscrowData {
        address buyer;
        State state;
        uint32 deliveryDeadline;
        uint32 responseDeadline;
        address seller;
        uint32 createdAt;
        address arbitrator;
        uint256 amount;
        string metadataHash; // IPFS CID e.g. "QmXy..."
    }

    uint256 public nextEscrowId;
    mapping(uint256 => EscrowData) public escrows;

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        address arbitrator,
        uint256 amount,
        string metadataHash
    );
    event Delivered(uint256 indexed escrowId);
    event DisputeOpened(uint256 indexed escrowId);
    event DisputeResolved(
        uint256 indexed escrowId,
        uint256 buyerAmount,
        uint256 sellerAmount
    );
    event FundsReleased(uint256 indexed escrowId, address indexed to, uint256 amount);
    event EscrowCancelled(uint256 indexed escrowId);

    error OnlyBuyer();
    error OnlySeller();
    error OnlyArbitrator();
    error InvalidState(State current, State expected);
    error InvalidAddress();
    error InvalidAmount();
    error DeadlineTooShort();
    error DeliveryDeadlineNotReached();
    error ResponseDeadlineNotReached();
    error TransferFailed();
    error InvalidSplit();

    modifier onlyBuyer(uint256 escrowId) {
        if (msg.sender != escrows[escrowId].buyer) revert OnlyBuyer();
        _;
    }

    modifier onlySeller(uint256 escrowId) {
        if (msg.sender != escrows[escrowId].seller) revert OnlySeller();
        _;
    }

    modifier onlyArbitrator(uint256 escrowId) {
        if (msg.sender != escrows[escrowId].arbitrator) revert OnlyArbitrator();
        _;
    }

    modifier inState(uint256 escrowId, State expected) {
        State current = escrows[escrowId].state;
        if (current != expected) revert InvalidState(current, expected);
        _;
    }

    /// @notice Buyer kicks off a new escrow — ETH gets deposited with this call.
    /// @param seller who's on the other side of the deal
    /// @param arbitrator neutral third party in case things go wrong
    /// @param metadataHash IPFS hash pointing to the order details
    /// @param deliveryTimeout how long (seconds) the seller has to deliver
    /// @param responseTimeout how long (seconds) the buyer has to respond after delivery
    /// @return escrowId the id assigned to this escrow
    function createEscrow(
        address seller,
        address arbitrator,
        string calldata metadataHash,
        uint32 deliveryTimeout,
        uint32 responseTimeout
    ) external payable returns (uint256 escrowId) {
        if (seller == address(0) || arbitrator == address(0)) revert InvalidAddress();
        if (seller == msg.sender || arbitrator == msg.sender || seller == arbitrator)
            revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();
        if (deliveryTimeout == 0 || responseTimeout == 0) revert DeadlineTooShort();

        escrowId = nextEscrowId++;

        uint32 now32 = uint32(block.timestamp);

        EscrowData storage e = escrows[escrowId];
        e.buyer = msg.sender;
        e.seller = seller;
        e.arbitrator = arbitrator;
        e.amount = msg.value;
        e.metadataHash = metadataHash;
        e.state = State.Pending;
        e.createdAt = now32;
        e.deliveryDeadline = now32 + deliveryTimeout;
        e.responseDeadline = now32 + deliveryTimeout + responseTimeout;

        emit EscrowCreated(escrowId, msg.sender, seller, arbitrator, msg.value, metadataHash);
    }

    /// @notice Seller says "I've delivered" — the buyer's response clock starts from here.
    /// @param escrowId which escrow to mark as delivered
    function markDelivered(uint256 escrowId)
        external
        onlySeller(escrowId)
        inState(escrowId, State.Pending)
    {
        EscrowData storage e = escrows[escrowId];
        e.state = State.Delivered;
        // restart the response timer from now, not from when the escrow was created
        e.responseDeadline = uint32(block.timestamp) + (e.responseDeadline - e.deliveryDeadline);

        emit Delivered(escrowId);
    }

    /// @notice Buyer is happy with the delivery — sends the ETH over to the seller.
    /// @param escrowId which escrow to release funds for
    function releaseFunds(uint256 escrowId)
        external
        nonReentrant
        onlyBuyer(escrowId)
        inState(escrowId, State.Delivered)
    {
        EscrowData storage e = escrows[escrowId];
        uint256 amt = e.amount;
        e.amount = 0;
        e.state = State.Resolved;

        emit FundsReleased(escrowId, e.seller, amt);

        _safeTransfer(e.seller, amt);
    }

    /// @notice Buyer isn't satisfied with what they got — flags it for the arbitrator to look at.
    /// @param escrowId which escrow to open a dispute on
    function raiseDispute(uint256 escrowId)
        external
        onlyBuyer(escrowId)
        inState(escrowId, State.Delivered)
    {
        escrows[escrowId].state = State.Disputed;

        emit DisputeOpened(escrowId);
    }

    /// @notice Arbitrator makes the final call — can do full refund, full payout, or any split in between.
    /// @param escrowId which escrow dispute to resolve
    /// @param buyerAmount how much goes back to the buyer
    /// @param sellerAmount how much goes to the seller (must add up to the total)
    function resolveDispute(uint256 escrowId, uint256 buyerAmount, uint256 sellerAmount)
        external
        nonReentrant
        onlyArbitrator(escrowId)
        inState(escrowId, State.Disputed)
    {
        EscrowData storage e = escrows[escrowId];
        if (buyerAmount + sellerAmount != e.amount) revert InvalidSplit();

        e.amount = 0;
        e.state = State.Resolved;

        emit DisputeResolved(escrowId, buyerAmount, sellerAmount);

        // state is already zeroed out above, so it's safe to send ETH now (CEI pattern)
        if (buyerAmount > 0) {
            emit FundsReleased(escrowId, e.buyer, buyerAmount);
            _safeTransfer(e.buyer, buyerAmount);
        }
        if (sellerAmount > 0) {
            emit FundsReleased(escrowId, e.seller, sellerAmount);
            _safeTransfer(e.seller, sellerAmount);
        }
    }

    /// @notice Seller took too long to deliver — buyer gets their ETH back.
    /// @param escrowId which escrow to cancel
    function cancelExpiredEscrow(uint256 escrowId)
        external
        nonReentrant
        onlyBuyer(escrowId)
        inState(escrowId, State.Pending)
    {
        EscrowData storage e = escrows[escrowId];
        if (block.timestamp < e.deliveryDeadline) revert DeliveryDeadlineNotReached();

        uint256 amt = e.amount;
        e.amount = 0;
        e.state = State.Cancelled;

        emit EscrowCancelled(escrowId);
        emit FundsReleased(escrowId, e.buyer, amt);

        _safeTransfer(e.buyer, amt);
    }

    /// @notice Buyer went silent after delivery — seller can grab the funds once the timeout passes.
    /// @param escrowId which escrow to claim from
    function claimAfterTimeout(uint256 escrowId)
        external
        nonReentrant
        onlySeller(escrowId)
        inState(escrowId, State.Delivered)
    {
        EscrowData storage e = escrows[escrowId];
        if (block.timestamp < e.responseDeadline) revert ResponseDeadlineNotReached();

        uint256 amt = e.amount;
        e.amount = 0;
        e.state = State.Resolved;

        emit FundsReleased(escrowId, e.seller, amt);

        _safeTransfer(e.seller, amt);
    }

    /// @notice Grab all the details for a given escrow.
    /// @param escrowId which escrow to look up
    /// @return the full EscrowData struct
    function getEscrow(uint256 escrowId) external view returns (EscrowData memory) {
        return escrows[escrowId];
    }

    /// @dev low-level ETH transfer — reverts if the send fails
    function _safeTransfer(address to, uint256 amt) private {
        (bool ok, ) = payable(to).call{value: amt}("");
        if (!ok) revert TransferFailed();
    }
}
