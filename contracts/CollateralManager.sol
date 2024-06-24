pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./Pausable.sol";
import "./MixinResolver.sol";
import "./interfaces/ICollateralManager.sol";

// Libraries
import "./AddressSetLib.sol";
import "./Bytes32SetLib.sol";
import "./SafeDecimalMath.sol";

// Internal references
import "./CollateralManagerState.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ITribe.sol";

contract CollateralManager is ICollateralManager, Owned, Pausable, MixinResolver {
    /* ========== LIBRARIES ========== */
    using SafeMath for uint;
    using SafeDecimalMath for uint;
    using AddressSetLib for AddressSetLib.AddressSet;
    using Bytes32SetLib for Bytes32SetLib.Bytes32Set;

    /* ========== CONSTANTS ========== */

    bytes32 private constant rUSD = "rUSD";

    uint private constant SECONDS_IN_A_YEAR = 31556926 * 1e18;

    // Flexible storage names
    bytes32 public constant CONTRACT_NAME = "CollateralManager";
    bytes32 internal constant COLLATERAL_RWAONES = "collateralTribe";

    /* ========== STATE VARIABLES ========== */

    // Stores debt balances and borrow rates.
    CollateralManagerState public state;

    // The set of all collateral contracts.
    AddressSetLib.AddressSet internal _collaterals;

    // The set of all available currency keys.
    Bytes32SetLib.Bytes32Set internal _currencyKeys;

    // The set of all tribes issuable by the various collateral contracts
    Bytes32SetLib.Bytes32Set internal _tribes;

    // Map from currency key to tribe contract name.
    mapping(bytes32 => bytes32) public tribesByKey;

    // The set of all tribes that are shortable.
    Bytes32SetLib.Bytes32Set internal _shortableTribes;

    mapping(bytes32 => bytes32) public shortableTribesByKey;

    // The factor that will scale the utilisation ratio.
    uint public utilisationMultiplier = 1e18;

    // The maximum amount of debt in rUSD that can be issued by non snx collateral.
    uint public maxDebt;

    // The rate that determines the skew limit maximum.
    uint public maxSkewRate;

    // The base interest rate applied to all borrows.
    uint public baseBorrowRate;

    // The base interest rate applied to all shorts.
    uint public baseShortRate;

    /* ---------- Address Resolver Configuration ---------- */

    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";

    bytes32[24] private addressesToCache = [CONTRACT_ISSUER, CONTRACT_EXRATES];

    /* ========== CONSTRUCTOR ========== */
    constructor(
        CollateralManagerState _state,
        address _owner,
        address _resolver,
        uint _maxDebt,
        uint _maxSkewRate,
        uint _baseBorrowRate,
        uint _baseShortRate
    ) public Owned(_owner) Pausable() MixinResolver(_resolver) {
        owner = msg.sender;
        state = _state;

        setMaxDebt(_maxDebt);
        setMaxSkewRate(_maxSkewRate);
        setBaseBorrowRate(_baseBorrowRate);
        setBaseShortRate(_baseShortRate);

        owner = _owner;
    }

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory staticAddresses = new bytes32[](2);
        staticAddresses[0] = CONTRACT_ISSUER;
        staticAddresses[1] = CONTRACT_EXRATES;

        bytes32[] memory shortAddresses;
        uint length = _shortableTribes.elements.length;

        if (length > 0) {
            shortAddresses = new bytes32[](length);

            for (uint i = 0; i < length; i++) {
                shortAddresses[i] = _shortableTribes.elements[i];
            }
        }

        bytes32[] memory tribeAddresses = combineArrays(shortAddresses, _tribes.elements);

        if (tribeAddresses.length > 0) {
            addresses = combineArrays(tribeAddresses, staticAddresses);
        } else {
            addresses = staticAddresses;
        }
    }

    // helper function to check whether tribe "by key" is a collateral issued by multi-collateral
    function isTribeManaged(bytes32 currencyKey) external view returns (bool) {
        return tribesByKey[currencyKey] != bytes32(0);
    }

    /* ---------- Related Contracts ---------- */

    function _issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function _exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function _tribe(bytes32 tribeName) internal view returns (ITribe) {
        return ITribe(requireAndGetAddress(tribeName));
    }

    /* ---------- Manager Information ---------- */

    function hasCollateral(address collateral) public view returns (bool) {
        return _collaterals.contains(collateral);
    }

    function hasAllCollaterals(address[] memory collaterals) public view returns (bool) {
        for (uint i = 0; i < collaterals.length; i++) {
            if (!hasCollateral(collaterals[i])) {
                return false;
            }
        }
        return true;
    }

    /* ---------- State Information ---------- */

    function long(bytes32 tribe) external view returns (uint amount) {
        return state.long(tribe);
    }

    function short(bytes32 tribe) external view returns (uint amount) {
        return state.short(tribe);
    }

    function totalLong() public view returns (uint rusdValue, bool anyRateIsInvalid) {
        bytes32[] memory tribes = _currencyKeys.elements;

        if (tribes.length > 0) {
            for (uint i = 0; i < tribes.length; i++) {
                bytes32 tribe = tribes[i];
                if (tribe == rUSD) {
                    rusdValue = rusdValue.add(state.long(tribe));
                } else {
                    (uint rate, bool invalid) = _exchangeRates().rateAndInvalid(tribe);
                    uint amount = state.long(tribe).multiplyDecimal(rate);
                    rusdValue = rusdValue.add(amount);
                    if (invalid) {
                        anyRateIsInvalid = true;
                    }
                }
            }
        }
    }

    function totalShort() public view returns (uint rusdValue, bool anyRateIsInvalid) {
        bytes32[] memory tribes = _shortableTribes.elements;

        if (tribes.length > 0) {
            for (uint i = 0; i < tribes.length; i++) {
                bytes32 tribe = _tribe(tribes[i]).currencyKey();
                (uint rate, bool invalid) = _exchangeRates().rateAndInvalid(tribe);
                uint amount = state.short(tribe).multiplyDecimal(rate);
                rusdValue = rusdValue.add(amount);
                if (invalid) {
                    anyRateIsInvalid = true;
                }
            }
        }
    }

    function totalLongAndShort() public view returns (uint rusdValue, bool anyRateIsInvalid) {
        bytes32[] memory currencyKeys = _currencyKeys.elements;

        if (currencyKeys.length > 0) {
            (uint[] memory rates, bool invalid) = _exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);
            for (uint i = 0; i < rates.length; i++) {
                uint longAmount = state.long(currencyKeys[i]).multiplyDecimal(rates[i]);
                uint shortAmount = state.short(currencyKeys[i]).multiplyDecimal(rates[i]);
                rusdValue = rusdValue.add(longAmount).add(shortAmount);
                if (invalid) {
                    anyRateIsInvalid = true;
                }
            }
        }
    }

    function getBorrowRate() public view returns (uint borrowRate, bool anyRateIsInvalid) {
        // get the snx backed debt.
        uint snxDebt = _issuer().totalIssuedTribes(rUSD, true);

        // now get the non snx backed debt.
        (uint nonSnxDebt, bool ratesInvalid) = totalLong();

        // the total.
        uint totalDebt = snxDebt.add(nonSnxDebt);

        // now work out the utilisation ratio, and divide through to get a per second value.
        uint utilisation = nonSnxDebt.divideDecimal(totalDebt).divideDecimal(SECONDS_IN_A_YEAR);

        // scale it by the utilisation multiplier.
        uint scaledUtilisation = utilisation.multiplyDecimal(utilisationMultiplier);

        // finally, add the base borrow rate.
        borrowRate = scaledUtilisation.add(baseBorrowRate);

        anyRateIsInvalid = ratesInvalid;
    }

    function getShortRate(bytes32 tribeKey) public view returns (uint shortRate, bool rateIsInvalid) {
        rateIsInvalid = _exchangeRates().rateIsInvalid(tribeKey);

        // Get the long and short supply.
        uint longSupply = IERC20(address(_tribe(shortableTribesByKey[tribeKey]))).totalSupply();
        uint shortSupply = state.short(tribeKey);

        // In this case, the market is skewed long so its free to short.
        if (longSupply > shortSupply) {
            return (0, rateIsInvalid);
        }

        // Otherwise workout the skew towards the short side.
        uint skew = shortSupply.sub(longSupply);

        // Divide through by the size of the market.
        uint proportionalSkew = skew.divideDecimal(longSupply.add(shortSupply)).divideDecimal(SECONDS_IN_A_YEAR);

        // Enforce a skew limit maximum.
        uint maxSkewLimit = proportionalSkew.multiplyDecimal(maxSkewRate);

        // Finally, add the base short rate.
        shortRate = maxSkewLimit.add(baseShortRate);
    }

    function getRatesAndTime(
        uint index
    ) public view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex) {
        (entryRate, lastRate, lastUpdated, newIndex) = state.getRatesAndTime(index);
    }

    function getShortRatesAndTime(
        bytes32 currency,
        uint index
    ) public view returns (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex) {
        (entryRate, lastRate, lastUpdated, newIndex) = state.getShortRatesAndTime(currency, index);
    }

    function exceedsDebtLimit(uint amount, bytes32 currency) external view returns (bool canIssue, bool anyRateIsInvalid) {
        uint usdAmount = _exchangeRates().effectiveValue(currency, amount, rUSD);

        (uint longAndShortValue, bool invalid) = totalLongAndShort();

        return (longAndShortValue.add(usdAmount) <= maxDebt, invalid);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /* ---------- SETTERS ---------- */

    function setUtilisationMultiplier(uint _utilisationMultiplier) public onlyOwner {
        require(_utilisationMultiplier > 0, "Must be greater than 0");
        utilisationMultiplier = _utilisationMultiplier;
        emit UtilisationMultiplierUpdated(utilisationMultiplier);
    }

    function setMaxDebt(uint _maxDebt) public onlyOwner {
        require(_maxDebt > 0, "Must be greater than 0");
        maxDebt = _maxDebt;
        emit MaxDebtUpdated(maxDebt);
    }

    function setMaxSkewRate(uint _maxSkewRate) public onlyOwner {
        maxSkewRate = _maxSkewRate;
        emit MaxSkewRateUpdated(maxSkewRate);
    }

    function setBaseBorrowRate(uint _baseBorrowRate) public onlyOwner {
        baseBorrowRate = _baseBorrowRate;
        emit BaseBorrowRateUpdated(baseBorrowRate);
    }

    function setBaseShortRate(uint _baseShortRate) public onlyOwner {
        baseShortRate = _baseShortRate;
        emit BaseShortRateUpdated(baseShortRate);
    }

    /* ---------- LOANS ---------- */

    function getNewLoanId() external onlyCollateral returns (uint id) {
        id = state.incrementTotalLoans();
    }

    /* ---------- MANAGER ---------- */

    function addCollaterals(address[] calldata collaterals) external onlyOwner {
        for (uint i = 0; i < collaterals.length; i++) {
            if (!_collaterals.contains(collaterals[i])) {
                _collaterals.add(collaterals[i]);
                emit CollateralAdded(collaterals[i]);
            }
        }
    }

    function removeCollaterals(address[] calldata collaterals) external onlyOwner {
        for (uint i = 0; i < collaterals.length; i++) {
            if (_collaterals.contains(collaterals[i])) {
                _collaterals.remove(collaterals[i]);
                emit CollateralRemoved(collaterals[i]);
            }
        }
    }

    function addTribes(bytes32[] calldata tribeNamesInResolver, bytes32[] calldata tribeKeys) external onlyOwner {
        require(tribeNamesInResolver.length == tribeKeys.length, "Input array length mismatch");

        for (uint i = 0; i < tribeNamesInResolver.length; i++) {
            if (!_tribes.contains(tribeNamesInResolver[i])) {
                bytes32 tribeName = tribeNamesInResolver[i];
                _tribes.add(tribeName);
                _currencyKeys.add(tribeKeys[i]);
                tribesByKey[tribeKeys[i]] = tribeName;
                emit TribeAdded(tribeName);
            }
        }

        rebuildCache();
    }

    function areTribesAndCurrenciesSet(
        bytes32[] calldata requiredTribeNamesInResolver,
        bytes32[] calldata tribeKeys
    ) external view returns (bool) {
        if (_tribes.elements.length != requiredTribeNamesInResolver.length) {
            return false;
        }

        for (uint i = 0; i < requiredTribeNamesInResolver.length; i++) {
            if (!_tribes.contains(requiredTribeNamesInResolver[i])) {
                return false;
            }
            if (tribesByKey[tribeKeys[i]] != requiredTribeNamesInResolver[i]) {
                return false;
            }
        }

        return true;
    }

    function removeTribes(bytes32[] calldata tribeNamesInResolver, bytes32[] calldata tribeKeys) external onlyOwner {
        require(tribeNamesInResolver.length == tribeKeys.length, "Input array length mismatch");

        for (uint i = 0; i < tribeNamesInResolver.length; i++) {
            if (_tribes.contains(tribeNamesInResolver[i])) {
                // Remove it from the the address set lib.
                _tribes.remove(tribeNamesInResolver[i]);
                _currencyKeys.remove(tribeKeys[i]);
                delete tribesByKey[tribeKeys[i]];

                emit TribeRemoved(tribeNamesInResolver[i]);
            }
        }
    }

    function addShortableTribes(
        bytes32[] calldata requiredTribeNamesInResolver,
        bytes32[] calldata tribeKeys
    ) external onlyOwner {
        require(requiredTribeNamesInResolver.length == tribeKeys.length, "Input array length mismatch");

        for (uint i = 0; i < requiredTribeNamesInResolver.length; i++) {
            bytes32 tribe = requiredTribeNamesInResolver[i];

            if (!_shortableTribes.contains(tribe)) {
                // Add it to the address set lib.
                _shortableTribes.add(tribe);

                shortableTribesByKey[tribeKeys[i]] = tribe;

                emit ShortableTribeAdded(tribe);

                // now the associated tribe key to the CollateralManagerState
                state.addShortCurrency(tribeKeys[i]);
            }
        }

        rebuildCache();
    }

    function areShortableTribesSet(
        bytes32[] calldata requiredTribeNamesInResolver,
        bytes32[] calldata tribeKeys
    ) external view returns (bool) {
        require(requiredTribeNamesInResolver.length == tribeKeys.length, "Input array length mismatch");

        if (_shortableTribes.elements.length != requiredTribeNamesInResolver.length) {
            return false;
        }

        // now check everything added to external state contract
        for (uint i = 0; i < tribeKeys.length; i++) {
            if (state.getShortRatesLength(tribeKeys[i]) == 0) {
                return false;
            }
        }

        return true;
    }

    function removeShortableTribes(bytes32[] calldata tribes) external onlyOwner {
        for (uint i = 0; i < tribes.length; i++) {
            if (_shortableTribes.contains(tribes[i])) {
                // Remove it from the the address set lib.
                _shortableTribes.remove(tribes[i]);

                bytes32 tribeKey = _tribe(tribes[i]).currencyKey();

                delete shortableTribesByKey[tribeKey];

                state.removeShortCurrency(tribeKey);

                emit ShortableTribeRemoved(tribes[i]);
            }
        }
    }

    /* ---------- STATE MUTATIONS ---------- */

    function updateBorrowRates(uint rate) internal {
        state.updateBorrowRates(rate);
    }

    function updateShortRates(bytes32 currency, uint rate) internal {
        state.updateShortRates(currency, rate);
    }

    function updateBorrowRatesCollateral(uint rate) external onlyCollateral {
        state.updateBorrowRates(rate);
    }

    function updateShortRatesCollateral(bytes32 currency, uint rate) external onlyCollateral {
        state.updateShortRates(currency, rate);
    }

    function incrementLongs(bytes32 tribe, uint amount) external onlyCollateral {
        state.incrementLongs(tribe, amount);
    }

    function decrementLongs(bytes32 tribe, uint amount) external onlyCollateral {
        state.decrementLongs(tribe, amount);
    }

    function incrementShorts(bytes32 tribe, uint amount) external onlyCollateral {
        state.incrementShorts(tribe, amount);
    }

    function decrementShorts(bytes32 tribe, uint amount) external onlyCollateral {
        state.decrementShorts(tribe, amount);
    }

    function accrueInterest(
        uint interestIndex,
        bytes32 currency,
        bool isShort
    ) external onlyCollateral returns (uint difference, uint index) {
        // 1. Get the rates we need.
        (uint entryRate, uint lastRate, uint lastUpdated, uint newIndex) = isShort
            ? getShortRatesAndTime(currency, interestIndex)
            : getRatesAndTime(interestIndex);

        // 2. Get the instantaneous rate.
        (uint rate, bool invalid) = isShort ? getShortRate(currency) : getBorrowRate();

        require(!invalid, "Invalid rate");

        // 3. Get the time since we last updated the rate.
        // TODO: consider this in the context of l2 time.
        uint timeDelta = block.timestamp.sub(lastUpdated).mul(1e18);

        // 4. Get the latest cumulative rate. F_n+1 = F_n + F_last
        uint latestCumulative = lastRate.add(rate.multiplyDecimal(timeDelta));

        // 5. Return the rate differential and the new interest index.
        difference = latestCumulative.sub(entryRate);
        index = newIndex;

        // 5. Update rates with the lastest cumulative rate. This also updates the time.
        isShort ? updateShortRates(currency, latestCumulative) : updateBorrowRates(latestCumulative);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyCollateral() {
        bool isMultiCollateral = hasCollateral(msg.sender);

        require(isMultiCollateral, "Only collateral contracts");
        _;
    }

    // ========== EVENTS ==========
    event MaxDebtUpdated(uint maxDebt);
    event MaxSkewRateUpdated(uint maxSkewRate);
    event LiquidationPenaltyUpdated(uint liquidationPenalty);
    event BaseBorrowRateUpdated(uint baseBorrowRate);
    event BaseShortRateUpdated(uint baseShortRate);
    event UtilisationMultiplierUpdated(uint utilisationMultiplier);

    event CollateralAdded(address collateral);
    event CollateralRemoved(address collateral);

    event TribeAdded(bytes32 tribe);
    event TribeRemoved(bytes32 tribe);

    event ShortableTribeAdded(bytes32 tribe);
    event ShortableTribeRemoved(bytes32 tribe);
}
