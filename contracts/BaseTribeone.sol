pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./interfaces/IERC20.sol";
import "./ExternStateToken.sol";
import "./MixinResolver.sol";
import "./interfaces/ITribeone.sol";

// Internal references
import "./interfaces/ITribe.sol";
import "./TokenState.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IRewardsDistribution.sol";
import "./interfaces/ILiquidator.sol";
import "./interfaces/ILiquidatorRewards.sol";
import "./interfaces/IVirtualTribe.sol";
import "./interfaces/IRewardEscrowV2.sol";

contract BaseTribeone is IERC20, ExternStateToken, MixinResolver, ITribeone {
    // ========== STATE VARIABLES ==========

    // Available Tribes which can be used with the system
    string public constant TOKEN_NAME = "Tribeone Network Wrap Token";
    string public constant TOKEN_SYMBOL = "wHAKA";
    uint8 public constant DECIMALS = 18;
    bytes32 public constant hUSD = "hUSD";

    // ========== ADDRESS RESOLVER CONFIGURATION ==========
    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_REWARDSDISTRIBUTION = "RewardsDistribution";
    bytes32 private constant CONTRACT_LIQUIDATORREWARDS = "LiquidatorRewards";
    bytes32 private constant CONTRACT_LIQUIDATOR = "Liquidator";
    bytes32 private constant CONTRACT_REWARDESCROW_V2 = "RewardEscrowV2";
    bytes32 private constant CONTRACT_V3_LEGACYMARKET = "LegacyMarket";
    bytes32 private constant CONTRACT_DEBT_MIGRATOR_ON_ETHEREUM = "DebtMigratorOnEthereum";

    // ========== CONSTRUCTOR ==========

    constructor(
        address payable _proxy,
        TokenState _tokenState,
        address _owner,
        uint _totalSupply,
        address _resolver
    )
        public
        ExternStateToken(_proxy, _tokenState, TOKEN_NAME, TOKEN_SYMBOL, _totalSupply, DECIMALS, _owner)
        MixinResolver(_resolver)
    {}

    // ========== VIEWS ==========

    // Note: use public visibility so that it can be invoked in a subclass
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        addresses = new bytes32[](7);
        addresses[0] = CONTRACT_SYSTEMSTATUS;
        addresses[1] = CONTRACT_EXCHANGER;
        addresses[2] = CONTRACT_ISSUER;
        addresses[3] = CONTRACT_REWARDSDISTRIBUTION;
        addresses[4] = CONTRACT_LIQUIDATORREWARDS;
        addresses[5] = CONTRACT_LIQUIDATOR;
        addresses[6] = CONTRACT_REWARDESCROW_V2;
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(requireAndGetAddress(CONTRACT_EXCHANGER));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function rewardsDistribution() internal view returns (IRewardsDistribution) {
        return IRewardsDistribution(requireAndGetAddress(CONTRACT_REWARDSDISTRIBUTION));
    }

    function liquidatorRewards() internal view returns (ILiquidatorRewards) {
        return ILiquidatorRewards(requireAndGetAddress(CONTRACT_LIQUIDATORREWARDS));
    }

    function rewardEscrowV2() internal view returns (IRewardEscrowV2) {
        return IRewardEscrowV2(requireAndGetAddress(CONTRACT_REWARDESCROW_V2));
    }

    function liquidator() internal view returns (ILiquidator) {
        return ILiquidator(requireAndGetAddress(CONTRACT_LIQUIDATOR));
    }

    function debtBalanceOf(address account, bytes32 currencyKey) external view returns (uint) {
        return issuer().debtBalanceOf(account, currencyKey);
    }

    function totalIssuedTribes(bytes32 currencyKey) external view returns (uint) {
        return issuer().totalIssuedTribes(currencyKey, false);
    }

    function totalIssuedTribesExcludeOtherCollateral(bytes32 currencyKey) external view returns (uint) {
        return issuer().totalIssuedTribes(currencyKey, true);
    }

    function availableCurrencyKeys() external view returns (bytes32[] memory) {
        return issuer().availableCurrencyKeys();
    }

    function availableTribeCount() external view returns (uint) {
        return issuer().availableTribeCount();
    }

    function availableTribes(uint index) external view returns (ITribe) {
        return issuer().availableTribes(index);
    }

    function tribes(bytes32 currencyKey) external view returns (ITribe) {
        return issuer().tribes(currencyKey);
    }

    function tribesByAddress(address tribeAddress) external view returns (bytes32) {
        return issuer().tribesByAddress(tribeAddress);
    }

    function isWaitingPeriod(bytes32 currencyKey) external view returns (bool) {
        return exchanger().maxSecsLeftInWaitingPeriod(messageSender, currencyKey) > 0;
    }

    function anyTribeOrHAKARateIsInvalid() external view returns (bool anyRateInvalid) {
        return issuer().anyTribeOrHAKARateIsInvalid();
    }

    function maxIssuableTribes(address account) external view returns (uint maxIssuable) {
        return issuer().maxIssuableTribes(account);
    }

    function remainingIssuableTribes(address account)
        external
        view
        returns (
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt
        )
    {
        return issuer().remainingIssuableTribes(account);
    }

    function collateralisationRatio(address _issuer) external view returns (uint) {
        return issuer().collateralisationRatio(_issuer);
    }

    function collateral(address account) external view returns (uint) {
        return issuer().collateral(account);
    }

    function transferableTribeone(address account) external view returns (uint transferable) {
        (transferable, ) = issuer().transferableTribeoneAndAnyRateIsInvalid(account, tokenState.balanceOf(account));
    }

    /// the index of the first non zero RewardEscrowV2 entry for an account in order of iteration over accountVestingEntryIDs.
    /// This is intended as a convenience off-chain view for liquidators to calculate the startIndex to pass
    /// into liquidateDelinquentAccountEscrowIndex to save gas.
    function getFirstNonZeroEscrowIndex(address account) external view returns (uint) {
        uint numIds = rewardEscrowV2().numVestingEntries(account);
        uint entryID;
        VestingEntries.VestingEntry memory entry;
        for (uint i = 0; i < numIds; i++) {
            entryID = rewardEscrowV2().accountVestingEntryIDs(account, i);
            entry = rewardEscrowV2().vestingSchedules(account, entryID);
            if (entry.escrowAmount > 0) {
                return i;
            }
        }
        revert("all entries are zero");
    }

    function _canTransfer(address account, uint value) internal view returns (bool) {
        // Always allow legacy market to transfer
        // note if legacy market is not yet available this will just return 0 address and it  will never be true
        address legacyMarketAddress = resolver.getAddress(CONTRACT_V3_LEGACYMARKET);
        if ((messageSender != address(0) && messageSender == legacyMarketAddress) || account == legacyMarketAddress) {
            return true;
        }

        if (issuer().debtBalanceOf(account, hUSD) > 0) {
            (uint transferable, bool anyRateIsInvalid) =
                issuer().transferableTribeoneAndAnyRateIsInvalid(account, tokenState.balanceOf(account));
            require(value <= transferable, "Cannot transfer staked or escrowed wHAKA");
            require(!anyRateIsInvalid, "A tribe or wHAKA rate is invalid");
        }

        return true;
    }

    // ========== MUTATIVE FUNCTIONS ==========

    function exchange(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        (amountReceived, ) = exchanger().exchange(
            messageSender,
            messageSender,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            messageSender,
            false,
            messageSender,
            bytes32(0)
        );
    }

    function exchangeOnBehalf(
        address exchangeForAddress,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        (amountReceived, ) = exchanger().exchange(
            exchangeForAddress,
            messageSender,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            exchangeForAddress,
            false,
            exchangeForAddress,
            bytes32(0)
        );
    }

    function settle(bytes32 currencyKey)
        external
        optionalProxy
        returns (
            uint reclaimed,
            uint refunded,
            uint numEntriesSettled
        )
    {
        return exchanger().settle(messageSender, currencyKey);
    }

    function exchangeWithTracking(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        (amountReceived, ) = exchanger().exchange(
            messageSender,
            messageSender,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            messageSender,
            false,
            rewardAddress,
            trackingCode
        );
    }

    function exchangeOnBehalfWithTracking(
        address exchangeForAddress,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        (amountReceived, ) = exchanger().exchange(
            exchangeForAddress,
            messageSender,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            exchangeForAddress,
            false,
            rewardAddress,
            trackingCode
        );
    }

    function transfer(address to, uint value) external onlyProxyOrInternal systemActive returns (bool) {
        // Ensure they're not trying to exceed their locked amount -- only if they have debt.
        _canTransfer(messageSender, value);

        // Perform the transfer: if there is a problem an exception will be thrown in this call.
        _transferByProxy(messageSender, to, value);

        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint value
    ) external onlyProxyOrInternal systemActive returns (bool) {
        // Ensure they're not trying to exceed their locked amount -- only if they have debt.
        _canTransfer(from, value);

        // Perform the transfer: if there is a problem,
        // an exception will be thrown in this call.
        return _transferFromByProxy(messageSender, from, to, value);
    }

    // SIP-252: migration of wHAKA token balance from old to new escrow rewards contract
    function migrateEscrowContractBalance() external onlyOwner {
        address from = resolver.requireAndGetAddress("RewardEscrowV2Frozen", "Old escrow address unset");
        // technically the below could use `rewardEscrowV2()`, but in the case of a migration it's better to avoid
        // using the cached value and read the most updated one directly from the resolver
        address to = resolver.requireAndGetAddress("RewardEscrowV2", "New escrow address unset");
        require(to != from, "cannot migrate to same address");

        uint currentBalance = tokenState.balanceOf(from);
        // allow no-op for idempotent migration steps in case action was performed already
        if (currentBalance > 0) {
            _internalTransfer(from, to, currentBalance);
        }
    }

    function issueTribes(uint amount) external issuanceActive optionalProxy {
        return issuer().issueTribes(messageSender, amount);
    }

    function issueTribesOnBehalf(address issueForAddress, uint amount) external issuanceActive optionalProxy {
        return issuer().issueTribesOnBehalf(issueForAddress, messageSender, amount);
    }

    function issueMaxTribes() external issuanceActive optionalProxy {
        return issuer().issueMaxTribes(messageSender);
    }

    function issueMaxTribesOnBehalf(address issueForAddress) external issuanceActive optionalProxy {
        return issuer().issueMaxTribesOnBehalf(issueForAddress, messageSender);
    }

    function burnTribes(uint amount) external issuanceActive optionalProxy {
        return issuer().burnTribes(messageSender, amount);
    }

    function burnTribesOnBehalf(address burnForAddress, uint amount) external issuanceActive optionalProxy {
        return issuer().burnTribesOnBehalf(burnForAddress, messageSender, amount);
    }

    function burnTribesToTarget() external issuanceActive optionalProxy {
        return issuer().burnTribesToTarget(messageSender);
    }

    function burnTribesToTargetOnBehalf(address burnForAddress) external issuanceActive optionalProxy {
        return issuer().burnTribesToTargetOnBehalf(burnForAddress, messageSender);
    }

    /// @notice Force liquidate a delinquent account and distribute the redeemed wHAKA rewards amongst the appropriate recipients.
    /// @dev The wHAKA transfers will revert if the amount to send is more than balanceOf account (i.e. due to escrowed balance).
    function liquidateDelinquentAccount(address account) external systemActive optionalProxy returns (bool) {
        return _liquidateDelinquentAccount(account, 0, messageSender);
    }

    /// @param escrowStartIndex: index into the account's vesting entries list to start iterating from
    /// when liquidating from escrow in order to save gas (the default method uses 0 as default)
    function liquidateDelinquentAccountEscrowIndex(address account, uint escrowStartIndex)
        external
        systemActive
        optionalProxy
        returns (bool)
    {
        return _liquidateDelinquentAccount(account, escrowStartIndex, messageSender);
    }

    /// @notice Force liquidate a delinquent account and distribute the redeemed wHAKA rewards amongst the appropriate recipients.
    /// @dev The wHAKA transfers will revert if the amount to send is more than balanceOf account (i.e. due to escrowed balance).
    function _liquidateDelinquentAccount(
        address account,
        uint escrowStartIndex,
        address liquidatorAccount
    ) internal returns (bool) {
        // ensure the user has no liquidation rewards (also counted towards collateral) outstanding
        liquidatorRewards().getReward(account);

        (uint totalRedeemed, uint debtToRemove, uint escrowToLiquidate) = issuer().liquidateAccount(account, false);

        // This transfers the to-be-liquidated part of escrow to the account (!) as liquid wHAKA.
        // It is transferred to the account instead of to the rewards because of the liquidator / flagger
        // rewards that may need to be paid (so need to be transferrable, to avoid edge cases)
        if (escrowToLiquidate > 0) {
            rewardEscrowV2().revokeFrom(account, account, escrowToLiquidate, escrowStartIndex);
        }

        emitAccountLiquidated(account, totalRedeemed, debtToRemove, liquidatorAccount);

        // First, pay out the flag and liquidate rewards.
        uint flagReward = liquidator().flagReward();
        uint liquidateReward = liquidator().liquidateReward();

        // Transfer the flagReward to the account who flagged this account for liquidation.
        address flagger = liquidator().getLiquidationCallerForAccount(account);
        bool flagRewardTransferSucceeded = _transferByProxy(account, flagger, flagReward);
        require(flagRewardTransferSucceeded, "Flag reward transfer did not succeed");

        // Transfer the liquidateReward to liquidator (the account who invoked this liquidation).
        bool liquidateRewardTransferSucceeded = _transferByProxy(account, liquidatorAccount, liquidateReward);
        require(liquidateRewardTransferSucceeded, "Liquidate reward transfer did not succeed");

        if (totalRedeemed > 0) {
            // Send the remaining wHAKA to the LiquidatorRewards contract.
            bool liquidatorRewardTransferSucceeded = _transferByProxy(account, address(liquidatorRewards()), totalRedeemed);
            require(liquidatorRewardTransferSucceeded, "Transfer to LiquidatorRewards failed");

            // Inform the LiquidatorRewards contract about the incoming wHAKA rewards.
            liquidatorRewards().notifyRewardAmount(totalRedeemed);
        }

        return true;
    }

    /// @notice Allows an account to self-liquidate anytime its c-ratio is below the target issuance ratio.
    function liquidateSelf() external systemActive optionalProxy returns (bool) {
        // must store liquidated account address because below functions may attempt to transfer wHAKA which changes messageSender
        address liquidatedAccount = messageSender;

        // ensure the user has no liquidation rewards (also counted towards collateral) outstanding
        liquidatorRewards().getReward(liquidatedAccount);

        // Self liquidate the account (`isSelfLiquidation` flag must be set to `true`).
        // escrowToLiquidate is unused because it cannot be used for self-liquidations
        (uint totalRedeemed, uint debtRemoved, ) = issuer().liquidateAccount(liquidatedAccount, true);
        require(debtRemoved > 0, "cannot self liquidate");

        emitAccountLiquidated(liquidatedAccount, totalRedeemed, debtRemoved, liquidatedAccount);

        // Transfer the redeemed wHAKA to the LiquidatorRewards contract.
        // Reverts if amount to redeem is more than balanceOf account (i.e. due to escrowed balance).
        bool success = _transferByProxy(liquidatedAccount, address(liquidatorRewards()), totalRedeemed);
        require(success, "Transfer to LiquidatorRewards failed");

        // Inform the LiquidatorRewards contract about the incoming wHAKA rewards.
        liquidatorRewards().notifyRewardAmount(totalRedeemed);

        return success;
    }

    /**
     * @notice allows for migration from v2x to v3 when an account has pending escrow entries
     */
    function revokeAllEscrow(address account) external systemActive {
        address legacyMarketAddress = resolver.getAddress(CONTRACT_V3_LEGACYMARKET);
        require(msg.sender == legacyMarketAddress, "Only LegacyMarket can revoke escrow");
        rewardEscrowV2().revokeFrom(account, legacyMarketAddress, rewardEscrowV2().totalEscrowedAccountBalance(account), 0);
    }

    function migrateAccountBalances(address account)
        external
        systemActive
        returns (uint totalEscrowRevoked, uint totalLiquidBalance)
    {
        address debtMigratorOnEthereum = resolver.getAddress(CONTRACT_DEBT_MIGRATOR_ON_ETHEREUM);
        require(msg.sender == debtMigratorOnEthereum, "Only L1 DebtMigrator");

        // get their liquid wHAKA balance and transfer it to the migrator contract
        totalLiquidBalance = tokenState.balanceOf(account);
        if (totalLiquidBalance > 0) {
            bool succeeded = _transferByProxy(account, debtMigratorOnEthereum, totalLiquidBalance);
            require(succeeded, "snx transfer failed");
        }

        // get their escrowed wHAKA balance and revoke it all
        totalEscrowRevoked = rewardEscrowV2().totalEscrowedAccountBalance(account);
        if (totalEscrowRevoked > 0) {
            rewardEscrowV2().revokeFrom(account, debtMigratorOnEthereum, totalEscrowRevoked, 0);
        }
    }

    function exchangeWithTrackingForInitiator(
        bytes32,
        uint,
        bytes32,
        address,
        bytes32
    ) external returns (uint) {
        _notImplemented();
    }

    function exchangeWithVirtual(
        bytes32,
        uint,
        bytes32,
        bytes32
    ) external returns (uint, IVirtualTribe) {
        _notImplemented();
    }

    function exchangeAtomically(
        bytes32,
        uint,
        bytes32,
        bytes32,
        uint
    ) external returns (uint) {
        _notImplemented();
    }

    function mint() external returns (bool) {
        _notImplemented();
    }

    function mintSecondary(address, uint) external {
        _notImplemented();
    }

    function mintSecondaryRewards(uint) external {
        _notImplemented();
    }

    function burnSecondary(address, uint) external {
        _notImplemented();
    }

    function _notImplemented() internal pure {
        revert("Cannot be run on this layer");
    }

    // ========== MODIFIERS ==========

    modifier systemActive() {
        _systemActive();
        _;
    }

    function _systemActive() private view {
        systemStatus().requireSystemActive();
    }

    modifier issuanceActive() {
        _issuanceActive();
        _;
    }

    function _issuanceActive() private view {
        systemStatus().requireIssuanceActive();
    }

    modifier exchangeActive(bytes32 src, bytes32 dest) {
        _exchangeActive(src, dest);
        _;
    }

    function _exchangeActive(bytes32 src, bytes32 dest) private view {
        systemStatus().requireExchangeBetweenTribesAllowed(src, dest);
    }

    modifier onlyExchanger() {
        _onlyExchanger();
        _;
    }

    function _onlyExchanger() private view {
        require(msg.sender == address(exchanger()), "Only Exchanger can invoke this");
    }

    modifier onlyProxyOrInternal {
        _onlyProxyOrInternal();
        _;
    }

    function _onlyProxyOrInternal() internal {
        if (msg.sender == address(proxy)) {
            // allow proxy through, messageSender should be already set correctly
            return;
        } else if (_isInternalTransferCaller(msg.sender)) {
            // optionalProxy behaviour only for the internal legacy contracts
            messageSender = msg.sender;
        } else {
            revert("Only the proxy can call");
        }
    }

    /// some legacy internal contracts use transfer methods directly on implementation
    /// which isn't supported due to SIP-238 for other callers
    function _isInternalTransferCaller(address caller) internal view returns (bool) {
        // These entries are not required or cached in order to allow them to not exist (==address(0))
        // e.g. due to not being available on L2 or at some future point in time.
        return
            // ordered to reduce gas for more frequent calls, bridge first, vesting and migrating after, legacy last
            caller == resolver.getAddress("TribeoneBridgeToOptimism") ||
            caller == resolver.getAddress("RewardEscrowV2") ||
            caller == resolver.getAddress("DebtMigratorOnOptimism") ||
            // legacy contracts
            caller == resolver.getAddress("RewardEscrow") ||
            caller == resolver.getAddress("TribeoneEscrow") ||
            caller == resolver.getAddress("Depot");
    }

    // ========== EVENTS ==========
    event AccountLiquidated(address indexed account, uint snxRedeemed, uint amountLiquidated, address liquidator);
    bytes32 internal constant ACCOUNTLIQUIDATED_SIG = keccak256("AccountLiquidated(address,uint256,uint256,address)");

    function emitAccountLiquidated(
        address account,
        uint256 snxRedeemed,
        uint256 amountLiquidated,
        address liquidator
    ) internal {
        proxy._emit(
            abi.encode(snxRedeemed, amountLiquidated, liquidator),
            2,
            ACCOUNTLIQUIDATED_SIG,
            addressToBytes32(account),
            0,
            0
        );
    }

    event TribeExchange(
        address indexed account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    );
    bytes32 internal constant TRIBEONE_EXCHANGE_SIG =
        keccak256("TribeExchange(address,bytes32,uint256,bytes32,uint256,address)");

    function emitTribeExchange(
        address account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    ) external onlyExchanger {
        proxy._emit(
            abi.encode(fromCurrencyKey, fromAmount, toCurrencyKey, toAmount, toAddress),
            2,
            TRIBEONE_EXCHANGE_SIG,
            addressToBytes32(account),
            0,
            0
        );
    }

    event ExchangeTracking(bytes32 indexed trackingCode, bytes32 toCurrencyKey, uint256 toAmount, uint256 fee);
    bytes32 internal constant EXCHANGE_TRACKING_SIG = keccak256("ExchangeTracking(bytes32,bytes32,uint256,uint256)");

    function emitExchangeTracking(
        bytes32 trackingCode,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        uint256 fee
    ) external onlyExchanger {
        proxy._emit(abi.encode(toCurrencyKey, toAmount, fee), 2, EXCHANGE_TRACKING_SIG, trackingCode, 0, 0);
    }

    event ExchangeReclaim(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 internal constant EXCHANGERECLAIM_SIG = keccak256("ExchangeReclaim(address,bytes32,uint256)");

    function emitExchangeReclaim(
        address account,
        bytes32 currencyKey,
        uint256 amount
    ) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGERECLAIM_SIG, addressToBytes32(account), 0, 0);
    }

    event ExchangeRebate(address indexed account, bytes32 currencyKey, uint amount);
    bytes32 internal constant EXCHANGEREBATE_SIG = keccak256("ExchangeRebate(address,bytes32,uint256)");

    function emitExchangeRebate(
        address account,
        bytes32 currencyKey,
        uint256 amount
    ) external onlyExchanger {
        proxy._emit(abi.encode(currencyKey, amount), 2, EXCHANGEREBATE_SIG, addressToBytes32(account), 0, 0);
    }
}
