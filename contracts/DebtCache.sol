pragma solidity ^0.5.16;

// Libraries
import "./SafeDecimalMath.sol";

// Inheritance
import "./BaseDebtCache.sol";

// https://docs.rwaone.io/contracts/source/contracts/debtcache
contract DebtCache is BaseDebtCache {
    using SafeDecimalMath for uint;

    bytes32 public constant CONTRACT_NAME = "DebtCache";

    constructor(address _owner, address _resolver) public BaseDebtCache(_owner, _resolver) {}

    bytes32 internal constant EXCLUDED_DEBT_KEY = "EXCLUDED_DEBT";
    bytes32 internal constant FUTURES_DEBT_KEY = "FUTURES_DEBT";

    /* ========== MUTATIVE FUNCTIONS ========== */

    // This function exists in case a rwa is ever somehow removed without its snapshot being updated.
    function purgeCachedRwaDebt(bytes32 currencyKey) external onlyOwner {
        require(issuer().rwas(currencyKey) == IRwa(0), "Rwa exists");
        delete _cachedRwaDebt[currencyKey];
    }

    function takeDebtSnapshot() external requireSystemActiveIfNotOwner {
        bytes32[] memory currencyKeys = issuer().availableCurrencyKeys();
        (uint[] memory values, uint futuresDebt, uint excludedDebt, bool isInvalid) = _currentRwaDebts(currencyKeys);

        // The total wRWAX-backed debt is the debt of futures markets plus the debt of circulating rwas.
        uint snxCollateralDebt = futuresDebt;
        _cachedRwaDebt[FUTURES_DEBT_KEY] = futuresDebt;
        uint numValues = values.length;
        for (uint i; i < numValues; i++) {
            uint value = values[i];
            snxCollateralDebt = snxCollateralDebt.add(value);
            _cachedRwaDebt[currencyKeys[i]] = value;
        }

        // Subtract out the excluded non-wRWAX backed debt from our total
        _cachedRwaDebt[EXCLUDED_DEBT_KEY] = excludedDebt;
        uint newDebt = snxCollateralDebt.floorsub(excludedDebt);
        _cachedDebt = newDebt;
        _cacheTimestamp = block.timestamp;
        emit DebtCacheUpdated(newDebt);
        emit DebtCacheSnapshotTaken(block.timestamp);

        // (in)validate the cache if necessary
        _updateDebtCacheValidity(isInvalid);
    }

    function updateCachedRwaDebts(bytes32[] calldata currencyKeys) external requireSystemActiveIfNotOwner {
        (uint[] memory rates, bool anyRateInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);
        _updateCachedRwaDebtsWithRates(currencyKeys, rates, anyRateInvalid);
    }

    function updateCachedRwaDebtWithRate(bytes32 currencyKey, uint currencyRate) external onlyIssuer {
        bytes32[] memory rwaKeyArray = new bytes32[](1);
        rwaKeyArray[0] = currencyKey;
        uint[] memory rwaRateArray = new uint[](1);
        rwaRateArray[0] = currencyRate;
        _updateCachedRwaDebtsWithRates(rwaKeyArray, rwaRateArray, false);
    }

    function updateCachedRwaDebtsWithRates(
        bytes32[] calldata currencyKeys,
        uint[] calldata currencyRates
    ) external onlyIssuerOrExchanger {
        _updateCachedRwaDebtsWithRates(currencyKeys, currencyRates, false);
    }

    function updateDebtCacheValidity(bool currentlyInvalid) external onlyIssuer {
        _updateDebtCacheValidity(currentlyInvalid);
    }

    function recordExcludedDebtChange(bytes32 currencyKey, int256 delta) external onlyDebtIssuer {
        int256 newExcludedDebt = int256(_excludedIssuedDebt[currencyKey]) + delta;

        require(newExcludedDebt >= 0, "Excluded debt cannot become negative");

        _excludedIssuedDebt[currencyKey] = uint(newExcludedDebt);
    }

    function updateCachedrUSDDebt(int amount) external onlyIssuer {
        uint delta = SafeDecimalMath.abs(amount);
        if (amount > 0) {
            _cachedRwaDebt[rUSD] = _cachedRwaDebt[rUSD].add(delta);
            _cachedDebt = _cachedDebt.add(delta);
        } else {
            _cachedRwaDebt[rUSD] = _cachedRwaDebt[rUSD].sub(delta);
            _cachedDebt = _cachedDebt.sub(delta);
        }

        emit DebtCacheUpdated(_cachedDebt);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _updateDebtCacheValidity(bool currentlyInvalid) internal {
        if (_cacheInvalid != currentlyInvalid) {
            _cacheInvalid = currentlyInvalid;
            emit DebtCacheValidityChanged(currentlyInvalid);
        }
    }

    // Updated the global debt according to a rate/supply change in a subset of issued rwas.
    function _updateCachedRwaDebtsWithRates(
        bytes32[] memory currencyKeys,
        uint[] memory currentRates,
        bool anyRateIsInvalid
    ) internal {
        uint numKeys = currencyKeys.length;
        require(numKeys == currentRates.length, "Input array lengths differ");

        // Compute the cached and current debt sum for the subset of rwas provided.
        uint cachedSum;
        uint currentSum;
        uint[] memory currentValues = _issuedRwaValues(currencyKeys, currentRates);

        for (uint i = 0; i < numKeys; i++) {
            bytes32 key = currencyKeys[i];
            uint currentRwaDebt = currentValues[i];

            cachedSum = cachedSum.add(_cachedRwaDebt[key]);
            currentSum = currentSum.add(currentRwaDebt);

            _cachedRwaDebt[key] = currentRwaDebt;
        }

        // Apply the debt update.
        if (cachedSum != currentSum) {
            uint debt = _cachedDebt;
            // apply the delta between the cachedSum and currentSum
            // add currentSum before sub cachedSum to prevent overflow as cachedSum > debt for large amount of excluded debt
            debt = debt.add(currentSum).sub(cachedSum);
            _cachedDebt = debt;
            emit DebtCacheUpdated(debt);
        }

        // Invalidate the cache if necessary
        if (anyRateIsInvalid) {
            _updateDebtCacheValidity(anyRateIsInvalid);
        }
    }

    /* ========== EVENTS ========== */

    event DebtCacheUpdated(uint cachedDebt);
    event DebtCacheSnapshotTaken(uint timestamp);
    event DebtCacheValidityChanged(bool indexed isInvalid);
}
