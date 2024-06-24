pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRewardEscrowV2.sol";

// https://docs.rwaone.io/contracts/RewardEscrow
contract ImportableRewardEscrowV2 is BaseRewardEscrowV2 {
    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_RWAONEETIX_BRIDGE_BASE = "RwaoneBridgeToBase";

    /* ========== CONSTRUCTOR ========== */

    constructor(address _owner, address _resolver) public BaseRewardEscrowV2(_owner, _resolver) {}

    /* ========== VIEWS ======================= */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRewardEscrowV2.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_RWAONEETIX_BRIDGE_BASE;
        return combineArrays(existingAddresses, newAddresses);
    }

    function tribeetixBridgeToBase() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_RWAONEETIX_BRIDGE_BASE);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function importVestingEntries(
        address account,
        uint256 escrowedAmount,
        VestingEntries.VestingEntry[] calldata vestingEntries
    ) external onlyRwaoneBridge {
        // add escrowedAmount to account and total aggregates
        state().updateEscrowAccountBalance(account, SafeCast.toInt256(escrowedAmount));

        // There must be enough balance in the contract to provide for the escrowed balance.
        require(
            totalEscrowedBalance() <= tribeetixERC20().balanceOf(address(this)),
            "Insufficient balance in the contract to provide for escrowed balance"
        );

        for (uint i = 0; i < vestingEntries.length; i++) {
            state().addVestingEntry(account, vestingEntries[i]);
        }
    }

    modifier onlyRwaoneBridge() {
        require(msg.sender == tribeetixBridgeToBase(), "Can only be invoked by RwaoneBridgeToBase contract");
        _;
    }
}
