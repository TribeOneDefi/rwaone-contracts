pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./interfaces/ISystemStatus.sol";

// https://docs.rwaone.io/contracts/source/contracts/systemstatus
contract SystemStatus is Owned, ISystemStatus {
    mapping(bytes32 => mapping(address => Status)) public accessControl;

    uint248 public constant SUSPENSION_REASON_UPGRADE = 1;

    bytes32 public constant SECTION_SYSTEM = "System";
    bytes32 public constant SECTION_ISSUANCE = "Issuance";
    bytes32 public constant SECTION_EXCHANGE = "Exchange";
    bytes32 public constant SECTION_FUTURES = "Futures";
    bytes32 public constant SECTION_RWAONE_EXCHANGE = "RwaExchange";
    bytes32 public constant SECTION_RWAONE = "Rwa";

    bytes32 public constant CONTRACT_NAME = "SystemStatus";

    Suspension public systemSuspension;

    Suspension public issuanceSuspension;

    Suspension public exchangeSuspension;

    Suspension public futuresSuspension;

    mapping(bytes32 => Suspension) public rwaExchangeSuspension;

    mapping(bytes32 => Suspension) public rwaSuspension;

    mapping(bytes32 => Suspension) public futuresMarketSuspension;

    constructor(address _owner) public Owned(_owner) {}

    /* ========== VIEWS ========== */
    function requireSystemActive() external view {
        _internalRequireSystemActive();
    }

    function systemSuspended() external view returns (bool) {
        return systemSuspension.suspended;
    }

    function requireIssuanceActive() external view {
        // Issuance requires the system be active
        _internalRequireSystemActive();

        // and issuance itself of course
        _internalRequireIssuanceActive();
    }

    function requireExchangeActive() external view {
        // Exchanging requires the system be active
        _internalRequireSystemActive();

        // and exchanging itself of course
        _internalRequireExchangeActive();
    }

    function requireRwaExchangeActive(bytes32 currencyKey) external view {
        // Rwa exchange and transfer requires the system be active
        _internalRequireSystemActive();
        _internalRequireRwaExchangeActive(currencyKey);
    }

    function requireFuturesActive() external view {
        _internalRequireSystemActive();
        _internalRequireExchangeActive();
        _internalRequireFuturesActive();
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function requireFuturesMarketActive(bytes32 marketKey) external view {
        _internalRequireSystemActive();
        _internalRequireExchangeActive(); // exchanging implicitely used
        _internalRequireFuturesActive(); // futures global flag
        _internalRequireFuturesMarketActive(marketKey); // specific futures market flag
    }

    function rwaSuspended(bytes32 currencyKey) external view returns (bool) {
        return systemSuspension.suspended || rwaSuspension[currencyKey].suspended;
    }

    function requireRwaActive(bytes32 currencyKey) external view {
        // Rwa exchange and transfer requires the system be active
        _internalRequireSystemActive();
        _internalRequireRwaActive(currencyKey);
    }

    function requireRwasActive(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey) external view {
        // Rwa exchange and transfer requires the system be active
        _internalRequireSystemActive();
        _internalRequireRwaActive(sourceCurrencyKey);
        _internalRequireRwaActive(destinationCurrencyKey);
    }

    function requireExchangeBetweenRwasAllowed(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey) external view {
        // Rwa exchange and transfer requires the system be active
        _internalRequireSystemActive();

        // and exchanging must be active
        _internalRequireExchangeActive();

        // and the rwa exchanging between the rwas must be active
        _internalRequireRwaExchangeActive(sourceCurrencyKey);
        _internalRequireRwaExchangeActive(destinationCurrencyKey);

        // and finally, the rwas cannot be suspended
        _internalRequireRwaActive(sourceCurrencyKey);
        _internalRequireRwaActive(destinationCurrencyKey);
    }

    function isSystemUpgrading() external view returns (bool) {
        return systemSuspension.suspended && systemSuspension.reason == SUSPENSION_REASON_UPGRADE;
    }

    function getRwaExchangeSuspensions(
        bytes32[] calldata rwas
    ) external view returns (bool[] memory exchangeSuspensions, uint256[] memory reasons) {
        exchangeSuspensions = new bool[](rwas.length);
        reasons = new uint256[](rwas.length);

        for (uint i = 0; i < rwas.length; i++) {
            exchangeSuspensions[i] = rwaExchangeSuspension[rwas[i]].suspended;
            reasons[i] = rwaExchangeSuspension[rwas[i]].reason;
        }
    }

    function getRwaSuspensions(
        bytes32[] calldata rwas
    ) external view returns (bool[] memory suspensions, uint256[] memory reasons) {
        suspensions = new bool[](rwas.length);
        reasons = new uint256[](rwas.length);

        for (uint i = 0; i < rwas.length; i++) {
            suspensions[i] = rwaSuspension[rwas[i]].suspended;
            reasons[i] = rwaSuspension[rwas[i]].reason;
        }
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function getFuturesMarketSuspensions(
        bytes32[] calldata marketKeys
    ) external view returns (bool[] memory suspensions, uint256[] memory reasons) {
        suspensions = new bool[](marketKeys.length);
        reasons = new uint256[](marketKeys.length);

        for (uint i = 0; i < marketKeys.length; i++) {
            suspensions[i] = futuresMarketSuspension[marketKeys[i]].suspended;
            reasons[i] = futuresMarketSuspension[marketKeys[i]].reason;
        }
    }

    /* ========== MUTATIVE FUNCTIONS ========== */
    function updateAccessControl(bytes32 section, address account, bool canSuspend, bool canResume) external onlyOwner {
        _internalUpdateAccessControl(section, account, canSuspend, canResume);
    }

    function updateAccessControls(
        bytes32[] calldata sections,
        address[] calldata accounts,
        bool[] calldata canSuspends,
        bool[] calldata canResumes
    ) external onlyOwner {
        require(
            sections.length == accounts.length &&
                accounts.length == canSuspends.length &&
                canSuspends.length == canResumes.length,
            "Input array lengths must match"
        );
        for (uint i = 0; i < sections.length; i++) {
            _internalUpdateAccessControl(sections[i], accounts[i], canSuspends[i], canResumes[i]);
        }
    }

    function suspendSystem(uint256 reason) external {
        _requireAccessToSuspend(SECTION_SYSTEM);
        systemSuspension.suspended = true;
        systemSuspension.reason = uint248(reason);
        emit SystemSuspended(systemSuspension.reason);
    }

    function resumeSystem() external {
        _requireAccessToResume(SECTION_SYSTEM);
        systemSuspension.suspended = false;
        emit SystemResumed(uint256(systemSuspension.reason));
        systemSuspension.reason = 0;
    }

    function suspendIssuance(uint256 reason) external {
        _requireAccessToSuspend(SECTION_ISSUANCE);
        issuanceSuspension.suspended = true;
        issuanceSuspension.reason = uint248(reason);
        emit IssuanceSuspended(reason);
    }

    function resumeIssuance() external {
        _requireAccessToResume(SECTION_ISSUANCE);
        issuanceSuspension.suspended = false;
        emit IssuanceResumed(uint256(issuanceSuspension.reason));
        issuanceSuspension.reason = 0;
    }

    function suspendExchange(uint256 reason) external {
        _requireAccessToSuspend(SECTION_EXCHANGE);
        exchangeSuspension.suspended = true;
        exchangeSuspension.reason = uint248(reason);
        emit ExchangeSuspended(reason);
    }

    function resumeExchange() external {
        _requireAccessToResume(SECTION_EXCHANGE);
        exchangeSuspension.suspended = false;
        emit ExchangeResumed(uint256(exchangeSuspension.reason));
        exchangeSuspension.reason = 0;
    }

    function suspendFutures(uint256 reason) external {
        _requireAccessToSuspend(SECTION_FUTURES);
        futuresSuspension.suspended = true;
        futuresSuspension.reason = uint248(reason);
        emit FuturesSuspended(reason);
    }

    function resumeFutures() external {
        _requireAccessToResume(SECTION_FUTURES);
        futuresSuspension.suspended = false;
        emit FuturesResumed(uint256(futuresSuspension.reason));
        futuresSuspension.reason = 0;
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function suspendFuturesMarket(bytes32 marketKey, uint256 reason) external {
        bytes32[] memory marketKeys = new bytes32[](1);
        marketKeys[0] = marketKey;
        _internalSuspendFuturesMarkets(marketKeys, reason);
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function suspendFuturesMarkets(bytes32[] calldata marketKeys, uint256 reason) external {
        _internalSuspendFuturesMarkets(marketKeys, reason);
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function resumeFuturesMarket(bytes32 marketKey) external {
        bytes32[] memory marketKeys = new bytes32[](1);
        marketKeys[0] = marketKey;
        _internalResumeFuturesMarkets(marketKeys);
    }

    /// @notice marketKey doesn't necessarily correspond to asset key
    function resumeFuturesMarkets(bytes32[] calldata marketKeys) external {
        _internalResumeFuturesMarkets(marketKeys);
    }

    function suspendRwaExchange(bytes32 currencyKey, uint256 reason) external {
        bytes32[] memory currencyKeys = new bytes32[](1);
        currencyKeys[0] = currencyKey;
        _internalSuspendRwaExchange(currencyKeys, reason);
    }

    function suspendRwasExchange(bytes32[] calldata currencyKeys, uint256 reason) external {
        _internalSuspendRwaExchange(currencyKeys, reason);
    }

    function resumeRwaExchange(bytes32 currencyKey) external {
        bytes32[] memory currencyKeys = new bytes32[](1);
        currencyKeys[0] = currencyKey;
        _internalResumeRwasExchange(currencyKeys);
    }

    function resumeRwasExchange(bytes32[] calldata currencyKeys) external {
        _internalResumeRwasExchange(currencyKeys);
    }

    function suspendRwa(bytes32 currencyKey, uint256 reason) external {
        bytes32[] memory currencyKeys = new bytes32[](1);
        currencyKeys[0] = currencyKey;
        _internalSuspendRwas(currencyKeys, reason);
    }

    function suspendRwas(bytes32[] calldata currencyKeys, uint256 reason) external {
        _internalSuspendRwas(currencyKeys, reason);
    }

    function resumeRwa(bytes32 currencyKey) external {
        bytes32[] memory currencyKeys = new bytes32[](1);
        currencyKeys[0] = currencyKey;
        _internalResumeRwas(currencyKeys);
    }

    function resumeRwas(bytes32[] calldata currencyKeys) external {
        _internalResumeRwas(currencyKeys);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _requireAccessToSuspend(bytes32 section) internal view {
        require(accessControl[section][msg.sender].canSuspend, "Restricted to access control list");
    }

    function _requireAccessToResume(bytes32 section) internal view {
        require(accessControl[section][msg.sender].canResume, "Restricted to access control list");
    }

    function _internalRequireSystemActive() internal view {
        require(
            !systemSuspension.suspended,
            systemSuspension.reason == SUSPENSION_REASON_UPGRADE
                ? "Rwaone is suspended, upgrade in progress... please stand by"
                : "Rwaone is suspended. Operation prohibited"
        );
    }

    function _internalRequireIssuanceActive() internal view {
        require(!issuanceSuspension.suspended, "Issuance is suspended. Operation prohibited");
    }

    function _internalRequireExchangeActive() internal view {
        require(!exchangeSuspension.suspended, "Exchange is suspended. Operation prohibited");
    }

    function _internalRequireFuturesActive() internal view {
        require(!futuresSuspension.suspended, "Futures markets are suspended. Operation prohibited");
    }

    function _internalRequireRwaExchangeActive(bytes32 currencyKey) internal view {
        require(!rwaExchangeSuspension[currencyKey].suspended, "Rwa exchange suspended. Operation prohibited");
    }

    function _internalRequireRwaActive(bytes32 currencyKey) internal view {
        require(!rwaSuspension[currencyKey].suspended, "Rwa is suspended. Operation prohibited");
    }

    function _internalRequireFuturesMarketActive(bytes32 marketKey) internal view {
        require(!futuresMarketSuspension[marketKey].suspended, "Market suspended");
    }

    function _internalSuspendRwas(bytes32[] memory currencyKeys, uint256 reason) internal {
        _requireAccessToSuspend(SECTION_RWAONE);
        for (uint i = 0; i < currencyKeys.length; i++) {
            bytes32 currencyKey = currencyKeys[i];
            rwaSuspension[currencyKey].suspended = true;
            rwaSuspension[currencyKey].reason = uint248(reason);
            emit RwaSuspended(currencyKey, reason);
        }
    }

    function _internalResumeRwas(bytes32[] memory currencyKeys) internal {
        _requireAccessToResume(SECTION_RWAONE);
        for (uint i = 0; i < currencyKeys.length; i++) {
            bytes32 currencyKey = currencyKeys[i];
            emit RwaResumed(currencyKey, uint256(rwaSuspension[currencyKey].reason));
            delete rwaSuspension[currencyKey];
        }
    }

    function _internalSuspendRwaExchange(bytes32[] memory currencyKeys, uint256 reason) internal {
        _requireAccessToSuspend(SECTION_RWAONE_EXCHANGE);
        for (uint i = 0; i < currencyKeys.length; i++) {
            bytes32 currencyKey = currencyKeys[i];
            rwaExchangeSuspension[currencyKey].suspended = true;
            rwaExchangeSuspension[currencyKey].reason = uint248(reason);
            emit RwaExchangeSuspended(currencyKey, reason);
        }
    }

    function _internalResumeRwasExchange(bytes32[] memory currencyKeys) internal {
        _requireAccessToResume(SECTION_RWAONE_EXCHANGE);
        for (uint i = 0; i < currencyKeys.length; i++) {
            bytes32 currencyKey = currencyKeys[i];
            emit RwaExchangeResumed(currencyKey, uint256(rwaExchangeSuspension[currencyKey].reason));
            delete rwaExchangeSuspension[currencyKey];
        }
    }

    function _internalSuspendFuturesMarkets(bytes32[] memory marketKeys, uint256 reason) internal {
        _requireAccessToSuspend(SECTION_FUTURES);
        for (uint i = 0; i < marketKeys.length; i++) {
            bytes32 marketKey = marketKeys[i];
            futuresMarketSuspension[marketKey].suspended = true;
            futuresMarketSuspension[marketKey].reason = uint248(reason);
            emit FuturesMarketSuspended(marketKey, reason);
        }
    }

    function _internalResumeFuturesMarkets(bytes32[] memory marketKeys) internal {
        _requireAccessToResume(SECTION_FUTURES);
        for (uint i = 0; i < marketKeys.length; i++) {
            bytes32 marketKey = marketKeys[i];
            emit FuturesMarketResumed(marketKey, uint256(futuresMarketSuspension[marketKey].reason));
            delete futuresMarketSuspension[marketKey];
        }
    }

    function _internalUpdateAccessControl(bytes32 section, address account, bool canSuspend, bool canResume) internal {
        require(
            section == SECTION_SYSTEM ||
                section == SECTION_ISSUANCE ||
                section == SECTION_EXCHANGE ||
                section == SECTION_FUTURES ||
                section == SECTION_RWAONE_EXCHANGE ||
                section == SECTION_RWAONE,
            "Invalid section supplied"
        );
        accessControl[section][account].canSuspend = canSuspend;
        accessControl[section][account].canResume = canResume;
        emit AccessControlUpdated(section, account, canSuspend, canResume);
    }

    /* ========== EVENTS ========== */

    event SystemSuspended(uint256 reason);
    event SystemResumed(uint256 reason);

    event IssuanceSuspended(uint256 reason);
    event IssuanceResumed(uint256 reason);

    event ExchangeSuspended(uint256 reason);
    event ExchangeResumed(uint256 reason);

    event FuturesSuspended(uint256 reason);
    event FuturesResumed(uint256 reason);

    event RwaExchangeSuspended(bytes32 currencyKey, uint256 reason);
    event RwaExchangeResumed(bytes32 currencyKey, uint256 reason);

    event RwaSuspended(bytes32 currencyKey, uint256 reason);
    event RwaResumed(bytes32 currencyKey, uint256 reason);

    event FuturesMarketSuspended(bytes32 marketKey, uint256 reason);
    event FuturesMarketResumed(bytes32 marketKey, uint256 reason);

    event AccessControlUpdated(bytes32 indexed section, address indexed account, bool canSuspend, bool canResume);
}
