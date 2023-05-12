pragma solidity >=0.4.24;
pragma experimental ABIEncoderV2;

interface ITribeoneBridgeToOptimism {
    function closeFeePeriod(uint hakaBackedDebt, uint debtSharesSupply) external;

    function migrateEscrow(uint256[][] calldata entryIDs) external;

    function depositTo(address to, uint amount) external;

    function depositReward(uint amount) external;

    function depositAndMigrateEscrow(uint256 depositAmount, uint256[][] calldata entryIDs) external;
}
