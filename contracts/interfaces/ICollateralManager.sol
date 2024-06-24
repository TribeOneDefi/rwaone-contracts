pragma solidity >=0.4.24;

interface ICollateralManager {
    // Manager information
    function hasCollateral(address collateral) external view returns (bool);

    function isTribeManaged(bytes32 currencyKey) external view returns (bool);

    // State information
    function long(bytes32 tribe) external view returns (uint amount);

    function short(bytes32 tribe) external view returns (uint amount);

    function totalLong() external view returns (uint rusdValue, bool anyRateIsInvalid);

    function totalShort() external view returns (uint rusdValue, bool anyRateIsInvalid);

    function getBorrowRate() external view returns (uint borrowRate, bool anyRateIsInvalid);

    function getShortRate(bytes32 tribe) external view returns (uint shortRate, bool rateIsInvalid);

    function getRatesAndTime(
        uint index
    ) external view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex);

    function getShortRatesAndTime(
        bytes32 currency,
        uint index
    ) external view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex);

    function exceedsDebtLimit(uint amount, bytes32 currency) external view returns (bool canIssue, bool anyRateIsInvalid);

    function areTribesAndCurrenciesSet(
        bytes32[] calldata requiredTribeNamesInResolver,
        bytes32[] calldata tribeKeys
    ) external view returns (bool);

    function areShortableTribesSet(
        bytes32[] calldata requiredTribeNamesInResolver,
        bytes32[] calldata tribeKeys
    ) external view returns (bool);

    // Loans
    function getNewLoanId() external returns (uint id);

    // Manager mutative
    function addCollaterals(address[] calldata collaterals) external;

    function removeCollaterals(address[] calldata collaterals) external;

    function addTribes(bytes32[] calldata tribeNamesInResolver, bytes32[] calldata tribeKeys) external;

    function removeTribes(bytes32[] calldata tribes, bytes32[] calldata tribeKeys) external;

    function addShortableTribes(bytes32[] calldata requiredTribeNamesInResolver, bytes32[] calldata tribeKeys) external;

    function removeShortableTribes(bytes32[] calldata tribes) external;

    // State mutative

    function incrementLongs(bytes32 tribe, uint amount) external;

    function decrementLongs(bytes32 tribe, uint amount) external;

    function incrementShorts(bytes32 tribe, uint amount) external;

    function decrementShorts(bytes32 tribe, uint amount) external;

    function accrueInterest(
        uint interestIndex,
        bytes32 currency,
        bool isShort
    ) external returns (uint difference, uint index);

    function updateBorrowRatesCollateral(uint rate) external;

    function updateShortRatesCollateral(bytes32 currency, uint rate) external;
}
