pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRwaoneBridge.sol";
import "./interfaces/IRwaoneBridgeToOptimism.sol";
import "@eth-optimism/contracts/iOVM/bridge/tokens/iOVM_L1TokenGateway.sol";

// Internal references
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/SafeERC20.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IRwaoneBridgeToBase.sol";
import "@eth-optimism/contracts/iOVM/bridge/tokens/iOVM_L2DepositedToken.sol";

contract RwaoneBridgeToOptimism is BaseRwaoneBridge, IRwaoneBridgeToOptimism, iOVM_L1TokenGateway {
    using SafeERC20 for IERC20;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_REWARDSDISTRIBUTION = "RewardsDistribution";
    bytes32 private constant CONTRACT_OVM_RWAONEBRIDGETOBASE = "ovm:RwaoneBridgeToBase";
    bytes32 private constant CONTRACT_RWAONEBRIDGEESCROW = "RwaoneBridgeEscrow";

    uint8 private constant MAX_ENTRIES_MIGRATED_PER_MESSAGE = 26;

    function CONTRACT_NAME() public pure returns (bytes32) {
        return "RwaoneBridgeToOptimism";
    }

    // ========== CONSTRUCTOR ==========

    constructor(address _owner, address _resolver) public BaseRwaoneBridge(_owner, _resolver) {}

    // ========== INTERNALS ============

    function rwaoneERC20() internal view returns (IERC20) {
        return IERC20(requireAndGetAddress(CONTRACT_RWAONE));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function rewardsDistribution() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_REWARDSDISTRIBUTION);
    }

    function rwaoneBridgeToBase() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_OVM_RWAONEBRIDGETOBASE);
    }

    function rwaoneBridgeEscrow() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_RWAONEBRIDGEESCROW);
    }

    function hasZeroDebt() internal view {
        require(issuer().debtBalanceOf(msg.sender, "rUSD") == 0, "Cannot deposit or migrate with debt");
    }

    function counterpart() internal view returns (address) {
        return rwaoneBridgeToBase();
    }

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRwaoneBridge.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](4);
        newAddresses[0] = CONTRACT_ISSUER;
        newAddresses[1] = CONTRACT_REWARDSDISTRIBUTION;
        newAddresses[2] = CONTRACT_OVM_RWAONEBRIDGETOBASE;
        newAddresses[3] = CONTRACT_RWAONEBRIDGEESCROW;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    // ========== MODIFIERS ============

    modifier requireZeroDebt() {
        hasZeroDebt();
        _;
    }

    // ========== PUBLIC FUNCTIONS =========

    function deposit(uint256 amount) external requireInitiationActive requireZeroDebt {
        _initiateDeposit(msg.sender, amount);
    }

    function depositTo(address to, uint amount) external requireInitiationActive requireZeroDebt {
        _initiateDeposit(to, amount);
    }

    function migrateEscrow(uint256[][] memory entryIDs) public requireInitiationActive requireZeroDebt {
        _migrateEscrow(entryIDs);
    }

    // invoked by a generous user on L1
    function depositReward(uint amount) external requireInitiationActive {
        // move the wRWAX into the deposit escrow
        rwaoneERC20().transferFrom(msg.sender, rwaoneBridgeEscrow(), amount);

        _depositReward(msg.sender, amount);
    }

    // forward any accidental tokens sent here to the escrow
    function forwardTokensToEscrow(address token) external {
        IERC20 erc20 = IERC20(token);
        erc20.safeTransfer(rwaoneBridgeEscrow(), erc20.balanceOf(address(this)));
    }

    // ========= RESTRICTED FUNCTIONS ==============

    function closeFeePeriod(uint snxBackedAmount, uint totalDebtShares) external requireInitiationActive {
        require(msg.sender == address(feePool()), "Only the fee pool can call this");

        IRwaoneBridgeToBase bridgeToBase;
        bytes memory messageData = abi.encodeWithSelector(
            bridgeToBase.finalizeFeePeriodClose.selector,
            snxBackedAmount,
            totalDebtShares
        );

        // relay the message to this contract on L2 via L1 Messenger
        messenger().sendMessage(
            rwaoneBridgeToBase(),
            messageData,
            uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.CloseFeePeriod))
        );

        emit FeePeriodClosed(snxBackedAmount, totalDebtShares);
    }

    // invoked by Messenger on L1 after L2 waiting period elapses
    function finalizeWithdrawal(address to, uint256 amount) external onlyCounterpart {
        // transfer amount back to user
        rwaoneERC20().transferFrom(rwaoneBridgeEscrow(), to, amount);

        // no escrow actions - escrow remains on L2
        emit iOVM_L1TokenGateway.WithdrawalFinalized(to, amount);
    }

    // invoked by RewardsDistribution on L1 (takes wRWAX)
    function notifyRewardAmount(uint256 amount) external {
        require(msg.sender == address(rewardsDistribution()), "Caller is not RewardsDistribution contract");

        // NOTE: transfer wRWAX to rwaoneBridgeEscrow because RewardsDistribution transfers them initially to this contract.
        rwaoneERC20().transfer(rwaoneBridgeEscrow(), amount);

        // to be here means I've been given an amount of wRWAX to distribute onto L2
        _depositReward(msg.sender, amount);
    }

    function depositAndMigrateEscrow(
        uint256 depositAmount,
        uint256[][] memory entryIDs
    ) public requireInitiationActive requireZeroDebt {
        if (entryIDs.length > 0) {
            _migrateEscrow(entryIDs);
        }

        if (depositAmount > 0) {
            _initiateDeposit(msg.sender, depositAmount);
        }
    }

    // ========== PRIVATE/INTERNAL FUNCTIONS =========

    function _depositReward(address _from, uint256 _amount) internal {
        // create message payload for L2
        IRwaoneBridgeToBase bridgeToBase;
        bytes memory messageData = abi.encodeWithSelector(bridgeToBase.finalizeRewardDeposit.selector, _from, _amount);

        // relay the message to this contract on L2 via L1 Messenger
        messenger().sendMessage(
            rwaoneBridgeToBase(),
            messageData,
            uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.Reward))
        );

        emit RewardDepositInitiated(_from, _amount);
    }

    function _initiateDeposit(address _to, uint256 _depositAmount) private {
        // Transfer wRWAX to L2
        // First, move the wRWAX into the deposit escrow
        rwaoneERC20().transferFrom(msg.sender, rwaoneBridgeEscrow(), _depositAmount);
        // create message payload for L2
        iOVM_L2DepositedToken bridgeToBase;
        bytes memory messageData = abi.encodeWithSelector(bridgeToBase.finalizeDeposit.selector, _to, _depositAmount);

        // relay the message to this contract on L2 via L1 Messenger
        messenger().sendMessage(
            rwaoneBridgeToBase(),
            messageData,
            uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.Deposit))
        );

        emit iOVM_L1TokenGateway.DepositInitiated(msg.sender, _to, _depositAmount);
    }

    function _migrateEscrow(uint256[][] memory _entryIDs) private {
        // loop through the entryID array
        for (uint256 i = 0; i < _entryIDs.length; i++) {
            // Cannot send more than MAX_ENTRIES_MIGRATED_PER_MESSAGE entries due to ovm gas restrictions
            require(_entryIDs[i].length <= MAX_ENTRIES_MIGRATED_PER_MESSAGE, "Exceeds max entries per migration");
            // Burn their reward escrow first
            // Note: escrowSummary would lose the fidelity of the weekly escrows, so this may not be sufficient
            uint256 escrowedAccountBalance;
            VestingEntries.VestingEntry[] memory vestingEntries;
            (escrowedAccountBalance, vestingEntries) = rewardEscrowV2().burnForMigration(msg.sender, _entryIDs[i]);

            // if there is an escrow amount to be migrated
            if (escrowedAccountBalance > 0) {
                // NOTE: transfer wRWAX to rwaoneBridgeEscrow because burnForMigration() transfers them to this contract.
                rwaoneERC20().transfer(rwaoneBridgeEscrow(), escrowedAccountBalance);
                // create message payload for L2
                IRwaoneBridgeToBase bridgeToBase;
                bytes memory messageData = abi.encodeWithSelector(
                    bridgeToBase.finalizeEscrowMigration.selector,
                    msg.sender,
                    escrowedAccountBalance,
                    vestingEntries
                );
                // relay the message to this contract on L2 via L1 Messenger
                messenger().sendMessage(
                    rwaoneBridgeToBase(),
                    messageData,
                    uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.Escrow))
                );

                emit ExportedVestingEntries(msg.sender, escrowedAccountBalance, vestingEntries);
            }
        }
    }

    // ========== EVENTS ==========

    event ExportedVestingEntries(
        address indexed account,
        uint256 escrowedAccountBalance,
        VestingEntries.VestingEntry[] vestingEntries
    );

    event RewardDepositInitiated(address indexed account, uint256 amount);

    event FeePeriodClosed(uint snxBackedDebt, uint totalDebtShares);
}
