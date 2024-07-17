pragma solidity >=0.4.24;

import "./IIssuer.sol";

interface IDebtCache {
    // Views

    function cachedDebt() external view returns (uint);

    function cachedRwaDebt(bytes32 currencyKey) external view returns (uint);

    function cacheTimestamp() external view returns (uint);

    function cacheInvalid() external view returns (bool);

    function cacheStale() external view returns (bool);

    function isInitialized() external view returns (bool);

    function currentRwaDebts(
        bytes32[] calldata currencyKeys
    ) external view returns (uint[] memory debtValues, uint futuresDebt, uint excludedDebt, bool anyRateIsInvalid);

    function cachedRwaDebts(bytes32[] calldata currencyKeys) external view returns (uint[] memory debtValues);

    function totalNonRwaxBackedDebt() external view returns (uint excludedDebt, bool isInvalid);

    function currentDebt() external view returns (uint debt, bool anyRateIsInvalid);

    function cacheInfo() external view returns (uint debt, uint timestamp, bool isInvalid, bool isStale);

    function excludedIssuedDebts(bytes32[] calldata currencyKeys) external view returns (uint[] memory excludedDebts);

    // Mutative functions

    function updateCachedRwaDebts(bytes32[] calldata currencyKeys) external;

    function updateCachedRwaDebtWithRate(bytes32 currencyKey, uint currencyRate) external;

    function updateCachedRwaDebtsWithRates(bytes32[] calldata currencyKeys, uint[] calldata currencyRates) external;

    function updateDebtCacheValidity(bool currentlyInvalid) external;

    function purgeCachedRwaDebt(bytes32 currencyKey) external;

    function takeDebtSnapshot() external;

    function recordExcludedDebtChange(bytes32 currencyKey, int256 delta) external;

    function updateCachedrUSDDebt(int amount) external;

    function importExcludedIssuedDebts(IDebtCache prevDebtCache, IIssuer prevIssuer) external;
}
