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

    // This function exists in case a tribe is ever somehow removed without its snapshot being updated.
    function purgeCachedTribeDebt(bytes32 currencyKey) external onlyOwner {
        require(issuer().tribes(currencyKey) == ITribe(0), "Tribe exists");
        delete _cachedTribeDebt[currencyKey];
    }

    function takeDebtSnapshot() external requireSystemActiveIfNotOwner {
        bytes32[] memory currencyKeys = issuer().availableCurrencyKeys();
        (uint[] memory values, uint futuresDebt, uint excludedDebt, bool isInvalid) = _currentTribeDebts(currencyKeys);

        // The total wHAKA-backed debt is the debt of futures markets plus the debt of circulating tribes.
        uint snxCollateralDebt = futuresDebt;
        _cachedTribeDebt[FUTURES_DEBT_KEY] = futuresDebt;
        uint numValues = values.length;
        for (uint i; i < numValues; i++) {
            uint value = values[i];
            snxCollateralDebt = snxCollateralDebt.add(value);
            _cachedTribeDebt[currencyKeys[i]] = value;
        }

        // Subtract out the excluded non-wHAKA backed debt from our total
        _cachedTribeDebt[EXCLUDED_DEBT_KEY] = excludedDebt;
        uint newDebt = snxCollateralDebt.floorsub(excludedDebt);
        _cachedDebt = newDebt;
        _cacheTimestamp = block.timestamp;
        emit DebtCacheUpdated(newDebt);
        emit DebtCacheSnapshotTaken(block.timestamp);

        // (in)validate the cache if necessary
        _updateDebtCacheValidity(isInvalid);
    }

    function updateCachedTribeDebts(bytes32[] calldata currencyKeys) external requireSystemActiveIfNotOwner {
        (uint[] memory rates, bool anyRateInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);
        _updateCachedTribeDebtsWithRates(currencyKeys, rates, anyRateInvalid);
    }

    function updateCachedTribeDebtWithRate(bytes32 currencyKey, uint currencyRate) external onlyIssuer {
        bytes32[] memory tribeKeyArray = new bytes32[](1);
        tribeKeyArray[0] = currencyKey;
        uint[] memory tribeRateArray = new uint[](1);
        tribeRateArray[0] = currencyRate;
        _updateCachedTribeDebtsWithRates(tribeKeyArray, tribeRateArray, false);
    }

    function updateCachedTribeDebtsWithRates(
        bytes32[] calldata currencyKeys,
        uint[] calldata currencyRates
    ) external onlyIssuerOrExchanger {
        _updateCachedTribeDebtsWithRates(currencyKeys, currencyRates, false);
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
            _cachedTribeDebt[rUSD] = _cachedTribeDebt[rUSD].add(delta);
            _cachedDebt = _cachedDebt.add(delta);
        } else {
            _cachedTribeDebt[rUSD] = _cachedTribeDebt[rUSD].sub(delta);
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

    // Updated the global debt according to a rate/supply change in a subset of issued tribes.
    function _updateCachedTribeDebtsWithRates(
        bytes32[] memory currencyKeys,
        uint[] memory currentRates,
        bool anyRateIsInvalid
    ) internal {
        uint numKeys = currencyKeys.length;
        require(numKeys == currentRates.length, "Input array lengths differ");

        // Compute the cached and current debt sum for the subset of tribes provided.
        uint cachedSum;
        uint currentSum;
        uint[] memory currentValues = _issuedTribeValues(currencyKeys, currentRates);

        for (uint i = 0; i < numKeys; i++) {
            bytes32 key = currencyKeys[i];
            uint currentTribeDebt = currentValues[i];

            cachedSum = cachedSum.add(_cachedTribeDebt[key]);
            currentSum = currentSum.add(currentTribeDebt);

            _cachedTribeDebt[key] = currentTribeDebt;
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
