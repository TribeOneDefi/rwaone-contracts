pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";
import "./interfaces/IIssuer.sol";

// Libraries
import "./SafeCast.sol";
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/ITribe.sol";
import "./interfaces/IRwaoneDebtShare.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/ICircuitBreaker.sol";
import "./interfaces/IHasBalance.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ILiquidator.sol";
import "./interfaces/ILiquidatorRewards.sol";
import "./interfaces/ITribeRedeemer.sol";
import "./interfaces/ISystemStatus.sol";
import "./Proxyable.sol";

import "@chainlink/contracts-0.0.10/src/v0.5/interfaces/AggregatorV2V3Interface.sol";

interface IProxy {
    function target() external view returns (address);
}

interface IIssuerInternalDebtCache {
    function updateCachedTribeDebtWithRate(bytes32 currencyKey, uint currencyRate) external;

    function updateCachedTribeDebtsWithRates(bytes32[] calldata currencyKeys, uint[] calldata currencyRates) external;

    function updateDebtCacheValidity(bool currentlyInvalid) external;

    function totalNonSnxBackedDebt() external view returns (uint excludedDebt, bool isInvalid);

    function cacheInfo() external view returns (uint cachedDebt, uint timestamp, bool isInvalid, bool isStale);

    function updateCachedrUSDDebt(int amount) external;
}

// https://docs.rwaone.io/contracts/source/contracts/issuer
contract Issuer is Owned, MixinSystemSettings, IIssuer {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 public constant CONTRACT_NAME = "Issuer";

    // Available Tribes which can be used with the system
    ITribe[] public availableTribes;
    mapping(bytes32 => ITribe) public tribes;
    mapping(address => bytes32) public tribesByAddress;

    /* ========== ENCODED NAMES ========== */

    bytes32 internal constant rUSD = "rUSD";
    bytes32 internal constant wHAKA = "wHAKA";

    // Flexible storage names

    bytes32 internal constant LAST_ISSUE_EVENT = "lastIssueEvent";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_RWAONEETIX = "Rwaone";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_CIRCUIT_BREAKER = "CircuitBreaker";
    bytes32 private constant CONTRACT_RWAONEETIXDEBTSHARE = "RwaoneDebtShare";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_REWARDESCROW_V2 = "RewardEscrowV2";
    bytes32 private constant CONTRACT_LIQUIDATOR = "Liquidator";
    bytes32 private constant CONTRACT_LIQUIDATOR_REWARDS = "LiquidatorRewards";
    bytes32 private constant CONTRACT_DEBTCACHE = "DebtCache";
    bytes32 private constant CONTRACT_RWAONEREDEEMER = "TribeRedeemer";
    bytes32 private constant CONTRACT_RWAONEETIXBRIDGETOOPTIMISM = "RwaoneBridgeToOptimism";
    bytes32 private constant CONTRACT_RWAONEETIXBRIDGETOBASE = "RwaoneBridgeToBase";
    bytes32 private constant CONTRACT_DEBT_MIGRATOR_ON_ETHEREUM = "DebtMigratorOnEthereum";
    bytes32 private constant CONTRACT_DEBT_MIGRATOR_ON_OPTIMISM = "DebtMigratorOnOptimism";

    bytes32 private constant CONTRACT_EXT_AGGREGATOR_ISSUED_RWAONES = "ext:AggregatorIssuedTribes";
    bytes32 private constant CONTRACT_EXT_AGGREGATOR_DEBT_RATIO = "ext:AggregatorDebtRatio";

    constructor(address _owner, address _resolver) public Owned(_owner) MixinSystemSettings(_resolver) {}

    /* ========== VIEWS ========== */
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](14);
        newAddresses[0] = CONTRACT_RWAONEETIX;
        newAddresses[1] = CONTRACT_EXCHANGER;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_CIRCUIT_BREAKER;
        newAddresses[4] = CONTRACT_RWAONEETIXDEBTSHARE;
        newAddresses[5] = CONTRACT_FEEPOOL;
        newAddresses[6] = CONTRACT_DELEGATEAPPROVALS;
        newAddresses[7] = CONTRACT_REWARDESCROW_V2;
        newAddresses[8] = CONTRACT_LIQUIDATOR;
        newAddresses[9] = CONTRACT_LIQUIDATOR_REWARDS;
        newAddresses[10] = CONTRACT_DEBTCACHE;
        newAddresses[11] = CONTRACT_RWAONEREDEEMER;
        newAddresses[12] = CONTRACT_EXT_AGGREGATOR_ISSUED_RWAONES;
        newAddresses[13] = CONTRACT_EXT_AGGREGATOR_DEBT_RATIO;
        return combineArrays(existingAddresses, newAddresses);
    }

    function tribeetixERC20() internal view returns (IERC20) {
        return IERC20(requireAndGetAddress(CONTRACT_RWAONEETIX));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(requireAndGetAddress(CONTRACT_EXCHANGER));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function circuitBreaker() internal view returns (ICircuitBreaker) {
        return ICircuitBreaker(requireAndGetAddress(CONTRACT_CIRCUIT_BREAKER));
    }

    function tribeetixDebtShare() internal view returns (IRwaoneDebtShare) {
        return IRwaoneDebtShare(requireAndGetAddress(CONTRACT_RWAONEETIXDEBTSHARE));
    }

    function liquidator() internal view returns (ILiquidator) {
        return ILiquidator(requireAndGetAddress(CONTRACT_LIQUIDATOR));
    }

    function liquidatorRewards() internal view returns (ILiquidatorRewards) {
        return ILiquidatorRewards(requireAndGetAddress(CONTRACT_LIQUIDATOR_REWARDS));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(requireAndGetAddress(CONTRACT_DELEGATEAPPROVALS));
    }

    function rewardEscrowV2() internal view returns (IHasBalance) {
        return IHasBalance(requireAndGetAddress(CONTRACT_REWARDESCROW_V2));
    }

    function debtCache() internal view returns (IIssuerInternalDebtCache) {
        return IIssuerInternalDebtCache(requireAndGetAddress(CONTRACT_DEBTCACHE));
    }

    function tribeRedeemer() internal view returns (ITribeRedeemer) {
        return ITribeRedeemer(requireAndGetAddress(CONTRACT_RWAONEREDEEMER));
    }

    function allNetworksDebtInfo() public view returns (uint256 debt, uint256 sharesSupply, bool isStale) {
        (, int256 rawIssuedTribes, , uint issuedTribesUpdatedAt, ) = _latestRoundData(
            requireAndGetAddress(CONTRACT_EXT_AGGREGATOR_ISSUED_RWAONES)
        );

        (uint rawRatio, uint ratioUpdatedAt) = _rawDebtRatioAndUpdatedAt();

        debt = uint(rawIssuedTribes);
        sharesSupply = rawRatio == 0 ? 0 : debt.divideDecimalRoundPrecise(uint(rawRatio));

        uint stalePeriod = getRateStalePeriod();

        isStale =
            stalePeriod < block.timestamp &&
            (block.timestamp - stalePeriod > issuedTribesUpdatedAt || block.timestamp - stalePeriod > ratioUpdatedAt);
    }

    function issuanceRatio() external view returns (uint) {
        return getIssuanceRatio();
    }

    function _rateAndInvalid(bytes32 currencyKey) internal view returns (uint, bool) {
        return exchangeRates().rateAndInvalid(currencyKey);
    }

    function _latestRoundData(address aggregator) internal view returns (uint80, int256, uint256, uint256, uint80) {
        return AggregatorV2V3Interface(aggregator).latestRoundData();
    }

    function _rawDebtRatioAndUpdatedAt() internal view returns (uint, uint) {
        (, int256 rawRatioInt, , uint ratioUpdatedAt, ) = _latestRoundData(
            requireAndGetAddress(CONTRACT_EXT_AGGREGATOR_DEBT_RATIO)
        );
        return (uint(rawRatioInt), ratioUpdatedAt);
    }

    function _sharesForDebt(uint debtAmount) internal view returns (uint) {
        (uint rawRatio, ) = _rawDebtRatioAndUpdatedAt();
        return rawRatio == 0 ? 0 : debtAmount.divideDecimalRoundPrecise(rawRatio);
    }

    function _debtForShares(uint sharesAmount) internal view returns (uint) {
        (uint rawRatio, ) = _rawDebtRatioAndUpdatedAt();
        return sharesAmount.multiplyDecimalRoundPrecise(rawRatio);
    }

    function _debtShareBalanceOf(address account) internal view returns (uint) {
        return tribeetixDebtShare().balanceOf(account);
    }

    function _snxBalanceOf(address account) internal view returns (uint) {
        return tribeetixERC20().balanceOf(account);
    }

    function _rewardEscrowBalanceOf(address account) internal view returns (uint) {
        return rewardEscrowV2().balanceOf(account);
    }

    function _availableCurrencyKeysWithOptionalHAKA(bool withHAKA) internal view returns (bytes32[] memory) {
        bytes32[] memory currencyKeys = new bytes32[](availableTribes.length + (withHAKA ? 1 : 0));

        for (uint i = 0; i < availableTribes.length; i++) {
            currencyKeys[i] = tribesByAddress[address(availableTribes[i])];
        }

        if (withHAKA) {
            currencyKeys[availableTribes.length] = wHAKA;
        }

        return currencyKeys;
    }

    // Returns the total value of the debt pool in currency specified by `currencyKey`.
    // To return only the wHAKA-backed debt, set `excludeCollateral` to true.
    function _totalIssuedTribes(
        bytes32 currencyKey,
        bool excludeCollateral
    ) internal view returns (uint totalIssued, bool anyRateIsInvalid) {
        (uint debt, , bool cacheIsInvalid, bool cacheIsStale) = debtCache().cacheInfo();
        anyRateIsInvalid = cacheIsInvalid || cacheIsStale;

        // Add total issued tribes from non snx collateral back into the total if not excluded
        if (!excludeCollateral) {
            (uint nonSnxDebt, bool invalid) = debtCache().totalNonSnxBackedDebt();
            debt = debt.add(nonSnxDebt);
            anyRateIsInvalid = anyRateIsInvalid || invalid;
        }

        if (currencyKey == rUSD) {
            return (debt, anyRateIsInvalid);
        }

        (uint currencyRate, bool currencyRateInvalid) = _rateAndInvalid(currencyKey);
        return (debt.divideDecimalRound(currencyRate), anyRateIsInvalid || currencyRateInvalid);
    }

    function _debtBalanceOfAndTotalDebt(
        uint debtShareBalance,
        bytes32 currencyKey
    ) internal view returns (uint debtBalance, uint totalSystemValue, bool anyRateIsInvalid) {
        // What's the total value of the system excluding ETH backed tribes in their requested currency?
        (uint snxBackedAmount, , bool debtInfoStale) = allNetworksDebtInfo();

        if (debtShareBalance == 0) {
            return (0, snxBackedAmount, debtInfoStale);
        }

        // existing functionality requires for us to convert into the exchange rate specified by `currencyKey`
        (uint currencyRate, bool currencyRateInvalid) = _rateAndInvalid(currencyKey);

        debtBalance = _debtForShares(debtShareBalance).divideDecimalRound(currencyRate);
        totalSystemValue = snxBackedAmount;

        anyRateIsInvalid = currencyRateInvalid || debtInfoStale;
    }

    function _canBurnTribes(address account) internal view returns (bool) {
        return now >= _lastIssueEvent(account).add(getMinimumStakeTime());
    }

    function _lastIssueEvent(address account) internal view returns (uint) {
        //  Get the timestamp of the last issue this account made
        return flexibleStorage().getUIntValue(CONTRACT_NAME, keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)));
    }

    function _remainingIssuableTribes(
        address _issuer
    ) internal view returns (uint maxIssuable, uint alreadyIssued, uint totalSystemDebt, bool anyRateIsInvalid) {
        (alreadyIssued, totalSystemDebt, anyRateIsInvalid) = _debtBalanceOfAndTotalDebt(_debtShareBalanceOf(_issuer), rUSD);
        (uint issuable, bool isInvalid) = _maxIssuableTribes(_issuer);
        maxIssuable = issuable;
        anyRateIsInvalid = anyRateIsInvalid || isInvalid;

        if (alreadyIssued >= maxIssuable) {
            maxIssuable = 0;
        } else {
            maxIssuable = maxIssuable.sub(alreadyIssued);
        }
    }

    function _snxToUSD(uint amount, uint snxRate) internal pure returns (uint) {
        return amount.multiplyDecimalRound(snxRate);
    }

    function _usdToSnx(uint amount, uint snxRate) internal pure returns (uint) {
        return amount.divideDecimalRound(snxRate);
    }

    function _maxIssuableTribes(address _issuer) internal view returns (uint, bool) {
        // What is the value of their wHAKA balance in rUSD
        (uint snxRate, bool isInvalid) = _rateAndInvalid(wHAKA);
        uint destinationValue = _snxToUSD(_collateral(_issuer), snxRate);

        // They're allowed to issue up to issuanceRatio of that value
        return (destinationValue.multiplyDecimal(getIssuanceRatio()), isInvalid);
    }

    function _collateralisationRatio(address _issuer) internal view returns (uint, bool) {
        uint totalOwnedRwaone = _collateral(_issuer);

        (uint debtBalance, , bool anyRateIsInvalid) = _debtBalanceOfAndTotalDebt(_debtShareBalanceOf(_issuer), wHAKA);

        // it's more gas intensive to put this check here if they have 0 wHAKA, but it complies with the interface
        if (totalOwnedRwaone == 0) return (0, anyRateIsInvalid);

        return (debtBalance.divideDecimalRound(totalOwnedRwaone), anyRateIsInvalid);
    }

    function _collateral(address account) internal view returns (uint) {
        return _snxBalanceOf(account).add(_rewardEscrowBalanceOf(account)).add(liquidatorRewards().earned(account));
    }

    function minimumStakeTime() external view returns (uint) {
        return getMinimumStakeTime();
    }

    function canBurnTribes(address account) external view returns (bool) {
        return _canBurnTribes(account);
    }

    function availableCurrencyKeys() external view returns (bytes32[] memory) {
        return _availableCurrencyKeysWithOptionalHAKA(false);
    }

    function availableTribeCount() external view returns (uint) {
        return availableTribes.length;
    }

    function anyTribeOrHAKARateIsInvalid() external view returns (bool anyRateInvalid) {
        (, anyRateInvalid) = exchangeRates().ratesAndInvalidForCurrencies(_availableCurrencyKeysWithOptionalHAKA(true));
    }

    function totalIssuedTribes(bytes32 currencyKey, bool excludeOtherCollateral) external view returns (uint totalIssued) {
        (totalIssued, ) = _totalIssuedTribes(currencyKey, excludeOtherCollateral);
    }

    function lastIssueEvent(address account) external view returns (uint) {
        return _lastIssueEvent(account);
    }

    function collateralisationRatio(address _issuer) external view returns (uint cratio) {
        (cratio, ) = _collateralisationRatio(_issuer);
    }

    function collateralisationRatioAndAnyRatesInvalid(
        address _issuer
    ) external view returns (uint cratio, bool anyRateIsInvalid) {
        return _collateralisationRatio(_issuer);
    }

    function collateral(address account) external view returns (uint) {
        return _collateral(account);
    }

    function debtBalanceOf(address _issuer, bytes32 currencyKey) external view returns (uint debtBalance) {
        // What was their initial debt ownership?
        uint debtShareBalance = _debtShareBalanceOf(_issuer);

        // If it's zero, they haven't issued, and they have no debt.
        if (debtShareBalance == 0) return 0;

        (debtBalance, , ) = _debtBalanceOfAndTotalDebt(debtShareBalance, currencyKey);
    }

    function remainingIssuableTribes(
        address _issuer
    ) external view returns (uint maxIssuable, uint alreadyIssued, uint totalSystemDebt) {
        (maxIssuable, alreadyIssued, totalSystemDebt, ) = _remainingIssuableTribes(_issuer);
    }

    function maxIssuableTribes(address _issuer) external view returns (uint) {
        (uint maxIssuable, ) = _maxIssuableTribes(_issuer);
        return maxIssuable;
    }

    function transferableRwaoneAndAnyRateIsInvalid(
        address account,
        uint balance
    ) external view returns (uint transferable, bool anyRateIsInvalid) {
        // How many wHAKA do they have, excluding escrow?
        // Note: We're excluding escrow here because we're interested in their transferable amount
        // and escrowed wHAKA are not transferable.

        // How many of those will be locked by the amount they've issued?
        // Assuming issuance ratio is 20%, then issuing 20 wHAKA of value would require
        // 100 wHAKA to be locked in their wallet to maintain their collateralisation ratio
        // The locked rwaone value can exceed their balance.
        uint debtBalance;
        (debtBalance, , anyRateIsInvalid) = _debtBalanceOfAndTotalDebt(_debtShareBalanceOf(account), wHAKA);
        uint lockedRwaoneValue = debtBalance.divideDecimalRound(getIssuanceRatio());

        // If we exceed the balance, no wHAKA are transferable, otherwise the difference is.
        if (lockedRwaoneValue >= balance) {
            transferable = 0;
        } else {
            transferable = balance.sub(lockedRwaoneValue);
        }
    }

    function getTribes(bytes32[] calldata currencyKeys) external view returns (ITribe[] memory) {
        uint numKeys = currencyKeys.length;
        ITribe[] memory addresses = new ITribe[](numKeys);

        for (uint i = 0; i < numKeys; i++) {
            addresses[i] = tribes[currencyKeys[i]];
        }

        return addresses;
    }

    /// @notice Provide the results that would be returned by the mutative liquidateAccount() method (that's reserved to Rwaone)
    /// @param account The account to be liquidated
    /// @param isSelfLiquidation boolean to determine if this is a forced or self-invoked liquidation
    /// @return totalRedeemed the total amount of collateral (wHAKA) to redeem (liquid and escrow)
    /// @return debtToRemove the amount of debt (rUSD) to burn in order to fix the account's c-ratio
    /// @return escrowToLiquidate the amount of escrow wHAKA that will be revoked during liquidation
    /// @return initialDebtBalance the amount of initial (rUSD) debt the account has
    function liquidationAmounts(
        address account,
        bool isSelfLiquidation
    ) external view returns (uint totalRedeemed, uint debtToRemove, uint escrowToLiquidate, uint initialDebtBalance) {
        return _liquidationAmounts(account, isSelfLiquidation);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _addTribe(ITribe tribe) internal {
        bytes32 currencyKey = tribe.currencyKey();
        require(tribes[currencyKey] == ITribe(0), "Tribe exists");
        require(tribesByAddress[address(tribe)] == bytes32(0), "Tribe address already exists");

        availableTribes.push(tribe);
        tribes[currencyKey] = tribe;
        tribesByAddress[address(tribe)] = currencyKey;

        emit TribeAdded(currencyKey, address(tribe));
    }

    function addTribe(ITribe tribe) external onlyOwner {
        _addTribe(tribe);
        // Invalidate the cache to force a snapshot to be recomputed. If a tribe were to be added
        // back to the system and it still somehow had cached debt, this would force the value to be
        // updated.
        debtCache().updateDebtCacheValidity(true);
    }

    function addTribes(ITribe[] calldata tribesToAdd) external onlyOwner {
        uint numTribes = tribesToAdd.length;
        for (uint i = 0; i < numTribes; i++) {
            _addTribe(tribesToAdd[i]);
        }

        // Invalidate the cache to force a snapshot to be recomputed.
        debtCache().updateDebtCacheValidity(true);
    }

    function _removeTribe(bytes32 currencyKey) internal {
        address tribeToRemove = address(tribes[currencyKey]);
        require(tribeToRemove != address(0), "Tribe does not exist");
        require(currencyKey != rUSD, "Cannot remove tribe");

        uint tribeSupply = IERC20(tribeToRemove).totalSupply();

        if (tribeSupply > 0) {
            (uint amountOfrUSD, uint rateToRedeem, ) = exchangeRates().effectiveValueAndRates(
                currencyKey,
                tribeSupply,
                "rUSD"
            );
            require(rateToRedeem > 0, "Cannot remove without rate");
            ITribeRedeemer _tribeRedeemer = tribeRedeemer();
            tribes[rUSD].issue(address(_tribeRedeemer), amountOfrUSD);
            // ensure the debt cache is aware of the new rUSD issued
            debtCache().updateCachedrUSDDebt(SafeCast.toInt256(amountOfrUSD));
            _tribeRedeemer.deprecate(IERC20(address(Proxyable(tribeToRemove).proxy())), rateToRedeem);
        }

        // Remove the tribe from the availableTribes array.
        for (uint i = 0; i < availableTribes.length; i++) {
            if (address(availableTribes[i]) == tribeToRemove) {
                delete availableTribes[i];

                // Copy the last tribe into the place of the one we just deleted
                // If there's only one tribe, this is tribes[0] = tribes[0].
                // If we're deleting the last one, it's also a NOOP in the same way.
                availableTribes[i] = availableTribes[availableTribes.length - 1];

                // Decrease the size of the array by one.
                availableTribes.length--;

                break;
            }
        }

        // And remove it from the tribes mapping
        delete tribesByAddress[tribeToRemove];
        delete tribes[currencyKey];

        emit TribeRemoved(currencyKey, tribeToRemove);
    }

    function removeTribe(bytes32 currencyKey) external onlyOwner {
        // Remove its contribution from the debt pool snapshot, and
        // invalidate the cache to force a new snapshot.
        IIssuerInternalDebtCache cache = debtCache();
        cache.updateCachedTribeDebtWithRate(currencyKey, 0);
        cache.updateDebtCacheValidity(true);

        _removeTribe(currencyKey);
    }

    function removeTribes(bytes32[] calldata currencyKeys) external onlyOwner {
        uint numKeys = currencyKeys.length;

        // Remove their contributions from the debt pool snapshot, and
        // invalidate the cache to force a new snapshot.
        IIssuerInternalDebtCache cache = debtCache();
        uint[] memory zeroRates = new uint[](numKeys);
        cache.updateCachedTribeDebtsWithRates(currencyKeys, zeroRates);
        cache.updateDebtCacheValidity(true);

        for (uint i = 0; i < numKeys; i++) {
            _removeTribe(currencyKeys[i]);
        }
    }

    function issueTribesWithoutDebt(
        bytes32 currencyKey,
        address to,
        uint amount
    ) external onlyTrustedMinters returns (bool rateInvalid) {
        require(address(tribes[currencyKey]) != address(0), "tribe doesn't exist");
        require(amount > 0, "cannot issue 0 tribes");

        // record issue timestamp
        _setLastIssueEvent(to);

        // Create their tribes
        tribes[currencyKey].issue(to, amount);

        // Account for the issued debt in the cache
        (uint rate, bool rateInvalid) = _rateAndInvalid(currencyKey);
        debtCache().updateCachedrUSDDebt(SafeCast.toInt256(amount.multiplyDecimal(rate)));

        // returned so that the caller can decide what to do if the rate is invalid
        return rateInvalid;
    }

    function burnTribesWithoutDebt(
        bytes32 currencyKey,
        address from,
        uint amount
    ) external onlyTrustedMinters returns (bool rateInvalid) {
        require(address(tribes[currencyKey]) != address(0), "tribe doesn't exist");
        require(amount > 0, "cannot issue 0 tribes");

        exchanger().settle(from, currencyKey);

        // Burn some tribes
        tribes[currencyKey].burn(from, amount);

        // Account for the burnt debt in the cache. If rate is invalid, the user won't be able to exchange
        (uint rate, bool rateInvalid) = _rateAndInvalid(currencyKey);
        debtCache().updateCachedrUSDDebt(-SafeCast.toInt256(amount.multiplyDecimal(rate)));

        // returned so that the caller can decide what to do if the rate is invalid
        return rateInvalid;
    }

    /**
     * SIP-237: Debt Migration
     * Function used for the one-way migration of all debt and liquid + escrowed wHAKA from L1 -> L2
     * @param account The address of the account that is being migrated
     * @param amount The amount of debt shares moving across layers
     */
    function modifyDebtSharesForMigration(address account, uint amount) external onlyTrustedMigrators {
        IRwaoneDebtShare sds = tribeetixDebtShare();

        if (msg.sender == resolver.getAddress(CONTRACT_DEBT_MIGRATOR_ON_ETHEREUM)) {
            sds.burnShare(account, amount);
        } else if (msg.sender == resolver.getAddress(CONTRACT_DEBT_MIGRATOR_ON_OPTIMISM)) {
            sds.mintShare(account, amount);
        }
    }

    /**
     * Function used to migrate balances from the CollateralShort contract
     * @param short The address of the CollateralShort contract to be upgraded
     * @param amount The amount of rUSD collateral to be burnt
     */
    function upgradeCollateralShort(address short, uint amount) external onlyOwner {
        require(short == resolver.getAddress("CollateralShortLegacy"), "wrong address");
        require(amount > 0, "cannot burn 0 tribes");

        exchanger().settle(short, rUSD);

        tribes[rUSD].burn(short, amount);
    }

    function issueTribes(address from, uint amount) external onlyRwaone {
        require(amount > 0, "cannot issue 0 tribes");

        _issueTribes(from, amount, false);
    }

    function issueMaxTribes(address from) external onlyRwaone {
        _issueTribes(from, 0, true);
    }

    function issueTribesOnBehalf(address issueForAddress, address from, uint amount) external onlyRwaone {
        _requireCanIssueOnBehalf(issueForAddress, from);
        _issueTribes(issueForAddress, amount, false);
    }

    function issueMaxTribesOnBehalf(address issueForAddress, address from) external onlyRwaone {
        _requireCanIssueOnBehalf(issueForAddress, from);
        _issueTribes(issueForAddress, 0, true);
    }

    function burnTribes(address from, uint amount) external onlyRwaone {
        _voluntaryBurnTribes(from, amount, false);
    }

    function burnTribesOnBehalf(address burnForAddress, address from, uint amount) external onlyRwaone {
        _requireCanBurnOnBehalf(burnForAddress, from);
        _voluntaryBurnTribes(burnForAddress, amount, false);
    }

    function burnTribesToTarget(address from) external onlyRwaone {
        _voluntaryBurnTribes(from, 0, true);
    }

    function burnTribesToTargetOnBehalf(address burnForAddress, address from) external onlyRwaone {
        _requireCanBurnOnBehalf(burnForAddress, from);
        _voluntaryBurnTribes(burnForAddress, 0, true);
    }

    function burnForRedemption(address deprecatedTribeProxy, address account, uint balance) external onlyTribeRedeemer {
        ITribe(IProxy(deprecatedTribeProxy).target()).burn(account, balance);
    }

    // SIP-148: Upgraded Liquidation Mechanism
    /// @notice This is where the core internal liquidation logic resides. This function can only be invoked by Rwaone.
    /// Reverts if liquidator().isLiquidationOpen() returns false (e.g. c-ratio is too high, delay hasn't passed,
    ///     account wasn't flagged etc)
    /// @param account The account to be liquidated
    /// @param isSelfLiquidation boolean to determine if this is a forced or self-invoked liquidation
    /// @return totalRedeemed the total amount of collateral (wHAKA) to redeem (liquid and escrow)
    /// @return debtRemoved the amount of debt (rUSD) to burn in order to fix the account's c-ratio
    /// @return escrowToLiquidate the amount of escrow wHAKA that will be revoked during liquidation
    function liquidateAccount(
        address account,
        bool isSelfLiquidation
    ) external onlyRwaone returns (uint totalRedeemed, uint debtRemoved, uint escrowToLiquidate) {
        require(liquidator().isLiquidationOpen(account, isSelfLiquidation), "Not open for liquidation");

        // liquidationAmounts checks isLiquidationOpen for the account
        uint initialDebtBalance;
        (totalRedeemed, debtRemoved, escrowToLiquidate, initialDebtBalance) = _liquidationAmounts(
            account,
            isSelfLiquidation
        );

        // Reduce debt shares by amount to liquidate.
        _removeFromDebtRegister(account, debtRemoved, initialDebtBalance);

        if (!isSelfLiquidation) {
            // In case of forced liquidation only, remove the liquidation flag.
            liquidator().removeAccountInLiquidation(account);
        }
        // Note: To remove the flag after self liquidation, burn to target and then call Liquidator.checkAndRemoveAccountInLiquidation(account).
    }

    function _liquidationAmounts(
        address account,
        bool isSelfLiquidation
    ) internal view returns (uint totalRedeemed, uint debtToRemove, uint escrowToLiquidate, uint debtBalance) {
        // Get the account's debt balance
        bool anyRateIsInvalid;
        (debtBalance, , anyRateIsInvalid) = _debtBalanceOfAndTotalDebt(_debtShareBalanceOf(account), rUSD);

        // Get the wHAKA rate
        (uint snxRate, bool snxRateInvalid) = _rateAndInvalid(wHAKA);
        _requireRatesNotInvalid(anyRateIsInvalid || snxRateInvalid);

        uint penalty;
        if (isSelfLiquidation) {
            // Get self liquidation penalty
            penalty = getSelfLiquidationPenalty();

            // Calculate the amount of debt to remove and wHAKA to redeem for a self liquidation
            debtToRemove = liquidator().calculateAmountToFixCollateral(
                debtBalance,
                _snxToUSD(_collateral(account), snxRate),
                penalty
            );

            // Get the minimum values for both totalRedeemed and debtToRemove
            totalRedeemed = _getMinValue(
                _usdToSnx(debtToRemove, snxRate).multiplyDecimal(SafeDecimalMath.unit().add(penalty)),
                _snxBalanceOf(account)
            );
            debtToRemove = _getMinValue(
                _snxToUSD(totalRedeemed, snxRate).divideDecimal(SafeDecimalMath.unit().add(penalty)),
                debtToRemove
            );

            // Return escrow as zero since it cannot be self liquidated
            return (totalRedeemed, debtToRemove, 0, debtBalance);
        } else {
            // In the case of forced Liquidation
            // Get the forced liquidation penalty and sum of the flag and liquidate rewards.
            penalty = getSnxLiquidationPenalty();
            uint rewardsSum = getLiquidateReward().add(getFlagReward());

            // Get the total USD value of their wHAKA collateral (including escrow and rewards minus the flag and liquidate rewards)
            uint collateralForAccountUSD = _snxToUSD(_collateral(account).sub(rewardsSum), snxRate);

            // Calculate the amount of debt to remove and the rUSD value of the wHAKA required to liquidate.
            debtToRemove = liquidator().calculateAmountToFixCollateral(debtBalance, collateralForAccountUSD, penalty);
            uint redeemTarget = _usdToSnx(debtToRemove, snxRate).multiplyDecimal(SafeDecimalMath.unit().add(penalty));

            if (redeemTarget.add(rewardsSum) >= _collateral(account)) {
                // need to wipe out the account
                debtToRemove = debtBalance;
                totalRedeemed = _collateral(account).sub(rewardsSum);
                escrowToLiquidate = _rewardEscrowBalanceOf(account);
                return (totalRedeemed, debtToRemove, escrowToLiquidate, debtBalance);
            } else {
                // normal forced liquidation
                (totalRedeemed, escrowToLiquidate) = _redeemableCollateralForTarget(account, redeemTarget, rewardsSum);
                return (totalRedeemed, debtToRemove, escrowToLiquidate, debtBalance);
            }
        }
    }

    // SIP-252
    // calculates the amount of wHAKA that can be force liquidated (redeemed)
    // for the various cases of transferrable & escrowed collateral
    function _redeemableCollateralForTarget(
        address account,
        uint redeemTarget,
        uint rewardsSum
    ) internal view returns (uint totalRedeemed, uint escrowToLiquidate) {
        // The balanceOf here can be considered "transferable" since it's not escrowed,
        // and it is the only wHAKA that can potentially be transfered if unstaked.
        uint transferable = _snxBalanceOf(account);
        if (redeemTarget.add(rewardsSum) <= transferable) {
            // transferable is enough
            return (redeemTarget, 0);
        } else {
            // if transferable is not enough
            // need only part of the escrow, add the needed part to redeemed
            escrowToLiquidate = redeemTarget.add(rewardsSum).sub(transferable);
            return (redeemTarget, escrowToLiquidate);
        }
    }

    function _getMinValue(uint x, uint y) internal pure returns (uint) {
        return x < y ? x : y;
    }

    function setCurrentPeriodId(uint128 periodId) external {
        require(msg.sender == requireAndGetAddress(CONTRACT_FEEPOOL), "Must be fee pool");

        IRwaoneDebtShare sds = tribeetixDebtShare();

        if (sds.currentPeriodId() < periodId) {
            sds.takeSnapshot(periodId);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _requireRatesNotInvalid(bool anyRateIsInvalid) internal pure {
        require(!anyRateIsInvalid, "A tribe or wHAKA rate is invalid");
    }

    function _requireCanIssueOnBehalf(address issueForAddress, address from) internal view {
        require(delegateApprovals().canIssueFor(issueForAddress, from), "Not approved to act on behalf");
    }

    function _requireCanBurnOnBehalf(address burnForAddress, address from) internal view {
        require(delegateApprovals().canBurnFor(burnForAddress, from), "Not approved to act on behalf");
    }

    function _issueTribes(address from, uint amount, bool issueMax) internal {
        if (_verifyCircuitBreakers()) {
            return;
        }

        (uint maxIssuable, , , bool anyRateIsInvalid) = _remainingIssuableTribes(from);
        _requireRatesNotInvalid(anyRateIsInvalid);

        if (!issueMax) {
            require(amount <= maxIssuable, "Amount too large");
        } else {
            amount = maxIssuable;
        }

        // Keep track of the debt they're about to create
        _addToDebtRegister(from, amount);

        // record issue timestamp
        _setLastIssueEvent(from);

        // Create their tribes
        tribes[rUSD].issue(from, amount);

        // Account for the issued debt in the cache
        debtCache().updateCachedrUSDDebt(SafeCast.toInt256(amount));
    }

    function _burnTribes(
        address debtAccount,
        address burnAccount,
        uint amount,
        uint existingDebt
    ) internal returns (uint amountBurnt) {
        if (_verifyCircuitBreakers()) {
            return 0;
        }

        // liquidation requires rUSD to be already settled / not in waiting period

        // If they're trying to burn more debt than they actually owe, rather than fail the transaction, let's just
        // clear their debt and leave them be.
        amountBurnt = existingDebt < amount ? existingDebt : amount;

        // Remove liquidated debt from the ledger
        _removeFromDebtRegister(debtAccount, amountBurnt, existingDebt);

        // tribe.burn does a safe subtraction on balance (so it will revert if there are not enough tribes).
        tribes[rUSD].burn(burnAccount, amountBurnt);

        // Account for the burnt debt in the cache.
        debtCache().updateCachedrUSDDebt(-SafeCast.toInt256(amountBurnt));
    }

    // If burning to target, `amount` is ignored, and the correct quantity of rUSD is burnt to reach the target
    // c-ratio, allowing fees to be claimed. In this case, pending settlements will be skipped as the user
    // will still have debt remaining after reaching their target.
    function _voluntaryBurnTribes(address from, uint amount, bool burnToTarget) internal {
        if (_verifyCircuitBreakers()) {
            return;
        }

        if (!burnToTarget) {
            // If not burning to target, then burning requires that the minimum stake time has elapsed.
            require(_canBurnTribes(from), "Minimum stake time not reached");
            // First settle anything pending into rUSD as burning or issuing impacts the size of the debt pool
            (, uint refunded, uint numEntriesSettled) = exchanger().settle(from, rUSD);
            if (numEntriesSettled > 0) {
                amount = exchanger().calculateAmountAfterSettlement(from, rUSD, amount, refunded);
            }
        }

        (uint existingDebt, , bool anyRateIsInvalid) = _debtBalanceOfAndTotalDebt(_debtShareBalanceOf(from), rUSD);
        (uint maxIssuableTribesForAccount, bool snxRateInvalid) = _maxIssuableTribes(from);
        _requireRatesNotInvalid(anyRateIsInvalid || snxRateInvalid);
        require(existingDebt > 0, "No debt to forgive");

        if (burnToTarget) {
            amount = existingDebt.sub(maxIssuableTribesForAccount);
        }

        uint amountBurnt = _burnTribes(from, from, amount, existingDebt);

        // Check and remove liquidation if existingDebt after burning is <= maxIssuableTribes
        // Issuance ratio is fixed so should remove any liquidations
        if (existingDebt.sub(amountBurnt) <= maxIssuableTribesForAccount) {
            liquidator().removeAccountInLiquidation(from);
        }
    }

    function _setLastIssueEvent(address account) internal {
        // Set the timestamp of the last issueTribes
        flexibleStorage().setUIntValue(
            CONTRACT_NAME,
            keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)),
            block.timestamp
        );
    }

    function _addToDebtRegister(address from, uint amount) internal {
        // important: this has to happen before any updates to user's debt shares
        liquidatorRewards().updateEntry(from);

        IRwaoneDebtShare sds = tribeetixDebtShare();

        // it is possible (eg in tests, system initialized with extra debt) to have issued debt without any shares issued
        // in which case, the first account to mint gets the debt. yw.
        uint debtShares = _sharesForDebt(amount);
        if (debtShares == 0) {
            sds.mintShare(from, amount);
        } else {
            sds.mintShare(from, debtShares);
        }
    }

    function _removeFromDebtRegister(address from, uint debtToRemove, uint existingDebt) internal {
        // important: this has to happen before any updates to user's debt shares
        liquidatorRewards().updateEntry(from);

        IRwaoneDebtShare sds = tribeetixDebtShare();

        uint currentDebtShare = _debtShareBalanceOf(from);

        if (debtToRemove == existingDebt) {
            sds.burnShare(from, currentDebtShare);
        } else {
            uint sharesToRemove = _sharesForDebt(debtToRemove);
            sds.burnShare(from, sharesToRemove < currentDebtShare ? sharesToRemove : currentDebtShare);
        }
    }

    // trips the breaker and returns boolean, where true means the breaker has tripped state
    function _verifyCircuitBreakers() internal returns (bool) {
        address debtRatioAggregator = requireAndGetAddress(CONTRACT_EXT_AGGREGATOR_DEBT_RATIO);
        (, int256 rawRatio, , , ) = AggregatorV2V3Interface(debtRatioAggregator).latestRoundData();
        (, bool broken, ) = exchangeRates().rateWithSafetyChecks(wHAKA);

        return circuitBreaker().probeCircuitBreaker(debtRatioAggregator, uint(rawRatio)) || broken;
    }

    /* ========== MODIFIERS ========== */
    modifier onlyRwaone() {
        require(msg.sender == address(tribeetixERC20()), "Only Rwaone");
        _;
    }

    modifier onlyTrustedMinters() {
        address bridgeL1 = resolver.getAddress(CONTRACT_RWAONEETIXBRIDGETOOPTIMISM);
        address bridgeL2 = resolver.getAddress(CONTRACT_RWAONEETIXBRIDGETOBASE);
        address feePool = resolver.getAddress(CONTRACT_FEEPOOL);
        require(msg.sender == bridgeL1 || msg.sender == bridgeL2 || msg.sender == feePool, "only trusted minters");
        _;
    }

    modifier onlyTrustedMigrators() {
        address migratorL1 = resolver.getAddress(CONTRACT_DEBT_MIGRATOR_ON_ETHEREUM);
        address migratorL2 = resolver.getAddress(CONTRACT_DEBT_MIGRATOR_ON_OPTIMISM);
        require(msg.sender == migratorL1 || msg.sender == migratorL2, "only trusted migrators");
        require(migratorL1 == address(0) || migratorL2 == address(0), "one migrator must be 0x0");
        _;
    }

    function _onlyTribeRedeemer() internal view {
        require(msg.sender == address(tribeRedeemer()), "Only TribeRedeemer");
    }

    modifier onlyTribeRedeemer() {
        _onlyTribeRedeemer();
        _;
    }

    /* ========== EVENTS ========== */

    event TribeAdded(bytes32 currencyKey, address tribe);
    event TribeRemoved(bytes32 currencyKey, address tribe);
}
