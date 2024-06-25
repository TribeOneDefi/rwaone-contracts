pragma solidity >=0.4.24;

interface ICollateralManager {
    // Manager information
    function hasCollateral(address collateral) external view returns (bool);

    function isRwaManaged(bytes32 currencyKey) external view returns (bool);

    // State information
    function long(bytes32 rwa) external view returns (uint amount);

    function short(bytes32 rwa) external view returns (uint amount);

    function totalLong() external view returns (uint rusdValue, bool anyRateIsInvalid);

    function totalShort() external view returns (uint rusdValue, bool anyRateIsInvalid);

    function getBorrowRate() external view returns (uint borrowRate, bool anyRateIsInvalid);

    function getShortRate(bytes32 rwa) external view returns (uint shortRate, bool rateIsInvalid);

    function getRatesAndTime(
        uint index
    ) external view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex);

    function getShortRatesAndTime(
        bytes32 currency,
        uint index
    ) external view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex);

    function exceedsDebtLimit(uint amount, bytes32 currency) external view returns (bool canIssue, bool anyRateIsInvalid);

    function areRwasAndCurrenciesSet(
        bytes32[] calldata requiredRwaNamesInResolver,
        bytes32[] calldata rwaKeys
    ) external view returns (bool);

    function areShortableRwasSet(
        bytes32[] calldata requiredRwaNamesInResolver,
        bytes32[] calldata rwaKeys
    ) external view returns (bool);

    // Loans
    function getNewLoanId() external returns (uint id);

    // Manager mutative
    function addCollaterals(address[] calldata collaterals) external;

    function removeCollaterals(address[] calldata collaterals) external;

    function addRwas(bytes32[] calldata rwaNamesInResolver, bytes32[] calldata rwaKeys) external;

    function removeRwas(bytes32[] calldata rwas, bytes32[] calldata rwaKeys) external;

    function addShortableRwas(bytes32[] calldata requiredRwaNamesInResolver, bytes32[] calldata rwaKeys) external;

    function removeShortableRwas(bytes32[] calldata rwas) external;

    // State mutative

    function incrementLongs(bytes32 rwa, uint amount) external;

    function decrementLongs(bytes32 rwa, uint amount) external;

    function incrementShorts(bytes32 rwa, uint amount) external;

    function decrementShorts(bytes32 rwa, uint amount) external;

    function accrueInterest(
        uint interestIndex,
        bytes32 currency,
        bool isShort
    ) external returns (uint difference, uint index);

    function updateBorrowRatesCollateral(uint rate) external;

    function updateShortRatesCollateral(bytes32 currency, uint rate) external;
}
