pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRwaoneBridge.sol";
import "./interfaces/IRwaoneBridgeToBase.sol";
import "@eth-optimism/contracts/iOVM/bridge/tokens/iOVM_L2DepositedToken.sol";

// Internal references
import "@eth-optimism/contracts/iOVM/bridge/tokens/iOVM_L1TokenGateway.sol";

contract RwaoneBridgeToBase is BaseRwaoneBridge, IRwaoneBridgeToBase, iOVM_L2DepositedToken {
    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_BASE_RWAONEBRIDGETOOPTIMISM = "base:RwaoneBridgeToOptimism";

    function CONTRACT_NAME() public pure returns (bytes32) {
        return "RwaoneBridgeToBase";
    }

    // ========== CONSTRUCTOR ==========

    constructor(address _owner, address _resolver) public BaseRwaoneBridge(_owner, _resolver) {}

    // ========== INTERNALS ============

    function rwaoneBridgeToOptimism() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_BASE_RWAONEBRIDGETOOPTIMISM);
    }

    function counterpart() internal view returns (address) {
        return rwaoneBridgeToOptimism();
    }

    // ========== VIEWS ==========

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRwaoneBridge.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_BASE_RWAONEBRIDGETOOPTIMISM;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    // ========== PUBLIC FUNCTIONS =========

    // invoked by user on L2
    function withdraw(uint amount) external requireInitiationActive {
        _initiateWithdraw(msg.sender, amount);
    }

    function withdrawTo(address to, uint amount) external requireInitiationActive {
        _initiateWithdraw(to, amount);
    }

    function _initiateWithdraw(address to, uint amount) private {
        require(rwaone().transferableRwaone(msg.sender) >= amount, "Not enough transferable wRWAX");

        // instruct L2 Rwaone to burn this supply
        rwaone().burnSecondary(msg.sender, amount);

        // create message payload for L1
        iOVM_L1TokenGateway bridgeToOptimism;
        bytes memory messageData = abi.encodeWithSelector(bridgeToOptimism.finalizeWithdrawal.selector, to, amount);

        // relay the message to Bridge on L1 via L2 Messenger
        messenger().sendMessage(
            rwaoneBridgeToOptimism(),
            messageData,
            uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.Withdrawal))
        );

        emit iOVM_L2DepositedToken.WithdrawalInitiated(msg.sender, to, amount);
    }

    // ========= RESTRICTED FUNCTIONS ==============

    function finalizeEscrowMigration(
        address account,
        uint256 escrowedAmount,
        VestingEntries.VestingEntry[] calldata vestingEntries
    ) external onlyCounterpart {
        IRewardEscrowV2 rewardEscrow = rewardEscrowV2();
        // First, mint the escrowed wRWAX that are being migrated
        rwaone().mintSecondary(address(rewardEscrow), escrowedAmount);
        rewardEscrow.importVestingEntries(account, escrowedAmount, vestingEntries);

        emit ImportedVestingEntries(account, escrowedAmount, vestingEntries);
    }

    // invoked by Messenger on L2
    function finalizeDeposit(address to, uint256 amount) external onlyCounterpart {
        // now tell Rwaone to mint these tokens, deposited in L1, into the specified account for L2
        rwaone().mintSecondary(to, amount);

        emit iOVM_L2DepositedToken.DepositFinalized(to, amount);
    }

    // invoked by Messenger on L2
    function finalizeRewardDeposit(address from, uint256 amount) external onlyCounterpart {
        // now tell Rwaone to mint these tokens, deposited in L1, into reward escrow on L2
        rwaone().mintSecondaryRewards(amount);

        emit RewardDepositFinalized(from, amount);
    }

    // invoked by Messenger on L2
    function finalizeFeePeriodClose(uint256 snxBackedAmount, uint256 totalDebtShares) external onlyCounterpart {
        // now tell Rwaone to mint these tokens, deposited in L1, into reward escrow on L2
        feePool().closeSecondary(snxBackedAmount, totalDebtShares);

        emit FeePeriodCloseFinalized(snxBackedAmount, totalDebtShares);
    }

    // ========== EVENTS ==========
    event ImportedVestingEntries(
        address indexed account,
        uint256 escrowedAmount,
        VestingEntries.VestingEntry[] vestingEntries
    );

    event RewardDepositFinalized(address from, uint256 amount);
    event FeePeriodCloseFinalized(uint snxBackedAmount, uint totalDebtShares);
}
