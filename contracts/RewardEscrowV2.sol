pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRewardEscrowV2.sol";

// Internal references
import "./interfaces/IRewardEscrow.sol";

// https://docs.rwaone.io/contracts/RewardEscrow
contract RewardEscrowV2 is BaseRewardEscrowV2 {
    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_RWAONEETIX_BRIDGE_OPTIMISM = "RwaoneBridgeToOptimism";

    /* ========== CONSTRUCTOR ========== */

    constructor(address _owner, address _resolver) public BaseRewardEscrowV2(_owner, _resolver) {}

    /* ========== VIEWS ======================= */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRewardEscrowV2.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_RWAONEETIX_BRIDGE_OPTIMISM;
        return combineArrays(existingAddresses, newAddresses);
    }

    function tribeetixBridgeToOptimism() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_RWAONEETIX_BRIDGE_OPTIMISM);
    }

    /* ========== L2 MIGRATION ========== */

    function burnForMigration(
        address account,
        uint[] calldata entryIDs
    )
        external
        onlyRwaoneBridge
        returns (uint256 escrowedAccountBalance, VestingEntries.VestingEntry[] memory vestingEntries)
    {
        require(entryIDs.length > 0, "Entry IDs required");

        vestingEntries = new VestingEntries.VestingEntry[](entryIDs.length);

        for (uint i = 0; i < entryIDs.length; i++) {
            VestingEntries.VestingEntry memory entry = vestingSchedules(account, entryIDs[i]);

            // only unvested
            if (entry.escrowAmount > 0) {
                vestingEntries[i] = entry;

                /* add the escrow amount to escrowedAccountBalance */
                escrowedAccountBalance = escrowedAccountBalance.add(entry.escrowAmount);

                /* Delete the vesting entry being migrated */
                state().setZeroAmount(account, entryIDs[i]);
            }
        }

        /**
         *  update account total escrow balances for migration
         *  transfer the escrowed wHAKA being migrated to the L2 deposit contract
         */
        if (escrowedAccountBalance > 0) {
            state().updateEscrowAccountBalance(account, -SafeCast.toInt256(escrowedAccountBalance));
            tribeetixERC20().transfer(tribeetixBridgeToOptimism(), escrowedAccountBalance);
        }

        emit BurnedForMigrationToL2(account, entryIDs, escrowedAccountBalance, block.timestamp);

        return (escrowedAccountBalance, vestingEntries);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyRwaoneBridge() {
        require(msg.sender == tribeetixBridgeToOptimism(), "Can only be invoked by RwaoneBridgeToOptimism contract");
        _;
    }

    /* ========== EVENTS ========== */
    event BurnedForMigrationToL2(address indexed account, uint[] entryIDs, uint escrowedAmountMigrated, uint time);
}
