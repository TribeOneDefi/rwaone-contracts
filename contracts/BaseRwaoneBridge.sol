pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";
import "./interfaces/IBaseRwaoneBridge.sol";

// Libraries
import "./Math.sol";
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IRwaone.sol";
import "./interfaces/IRewardEscrowV2.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/ISystemStatus.sol";
import "@eth-optimism/contracts/iOVM/bridge/messaging/iAbs_BaseCrossDomainMessenger.sol";

contract BaseRwaoneBridge is Owned, MixinSystemSettings, IBaseRwaoneBridge {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_EXT_MESSENGER = "ext:Messenger";
    bytes32 internal constant CONTRACT_RWAONE = "Rwaone";
    bytes32 private constant CONTRACT_REWARDESCROW = "RewardEscrowV2";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_FLEXIBLESTORAGE = "FlexibleStorage";
    bytes32 private constant CONTRACT_EXCHANGERATES = "ExchangeRates";
    bytes32 private constant CONTRACT_SYSTEM_STATUS = "SystemStatus";

    // have to define this function like this here because contract name is required for FlexibleStorage
    function CONTRACT_NAME() public pure returns (bytes32);

    bool public initiationActive;

    bytes32 private constant RWAONE_TRANSFER_NAMESPACE = "RwaTransfer";
    bytes32 private constant RWAONE_TRANSFER_SENT = "Sent";
    bytes32 private constant RWAONE_TRANSFER_RECV = "Recv";

    // ========== CONSTRUCTOR ==========

    constructor(address _owner, address _resolver) public Owned(_owner) MixinSystemSettings(_resolver) {
        initiationActive = true;
    }

    // ========== INTERNALS ============

    function messenger() internal view returns (iAbs_BaseCrossDomainMessenger) {
        return iAbs_BaseCrossDomainMessenger(requireAndGetAddress(CONTRACT_EXT_MESSENGER));
    }

    function rwaone() internal view returns (IRwaone) {
        return IRwaone(requireAndGetAddress(CONTRACT_RWAONE));
    }

    function rewardEscrowV2() internal view returns (IRewardEscrowV2) {
        return IRewardEscrowV2(requireAndGetAddress(CONTRACT_REWARDESCROW));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(requireAndGetAddress(CONTRACT_FEEPOOL));
    }

    function flexibleStorage() internal view returns (IFlexibleStorage) {
        return IFlexibleStorage(requireAndGetAddress(CONTRACT_FLEXIBLESTORAGE));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXCHANGERATES));
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEM_STATUS));
    }

    function initiatingActive() internal view {
        require(initiationActive, "Initiation deactivated");
    }

    function counterpart() internal view returns (address);

    function onlyAllowFromCounterpart() internal view {
        // ensure function only callable from the L2 bridge via messenger (aka relayer)
        iAbs_BaseCrossDomainMessenger _messenger = messenger();
        require(msg.sender == address(_messenger), "Only the relayer can call this");
        require(_messenger.xDomainMessageSender() == counterpart(), "Only a counterpart bridge can invoke");
    }

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](8);
        newAddresses[0] = CONTRACT_EXT_MESSENGER;
        newAddresses[1] = CONTRACT_RWAONE;
        newAddresses[2] = CONTRACT_REWARDESCROW;
        newAddresses[3] = CONTRACT_ISSUER;
        newAddresses[4] = CONTRACT_FEEPOOL;
        newAddresses[5] = CONTRACT_FLEXIBLESTORAGE;
        newAddresses[6] = CONTRACT_EXCHANGERATES;
        newAddresses[7] = CONTRACT_SYSTEM_STATUS;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function rwaTransferSent() external view returns (uint) {
        return _sumTransferAmounts(RWAONE_TRANSFER_SENT);
    }

    function rwaTransferReceived() external view returns (uint) {
        return _sumTransferAmounts(RWAONE_TRANSFER_RECV);
    }

    // ========== MODIFIERS ============

    modifier requireInitiationActive() {
        initiatingActive();
        _;
    }

    modifier onlyCounterpart() {
        onlyAllowFromCounterpart();
        _;
    }

    // ========= RESTRICTED FUNCTIONS ==============

    function suspendInitiation() external onlyOwner {
        require(initiationActive, "Initiation suspended");
        initiationActive = false;
        emit InitiationSuspended();
    }

    function resumeInitiation() external onlyOwner {
        require(!initiationActive, "Initiation not suspended");
        initiationActive = true;
        emit InitiationResumed();
    }

    function initiateRwaTransfer(bytes32 currencyKey, address destination, uint amount) external requireInitiationActive {
        require(destination != address(0), "Cannot send to zero address");
        require(getCrossChainRwaTransferEnabled(currencyKey) > 0, "Rwa not enabled for cross chain transfer");
        systemStatus().requireRwaActive(currencyKey);

        _incrementRwasTransferCounter(RWAONE_TRANSFER_SENT, currencyKey, amount);

        bool rateInvalid = issuer().burnRwasWithoutDebt(currencyKey, msg.sender, amount);
        require(!rateInvalid, "Cannot initiate if rwa rate is invalid");

        // create message payload
        bytes memory messageData = abi.encodeWithSelector(
            this.finalizeRwaTransfer.selector,
            currencyKey,
            destination,
            amount
        );

        // relay the message to Bridge on L1 via L2 Messenger
        messenger().sendMessage(
            counterpart(),
            messageData,
            uint32(getCrossDomainMessageGasLimit(CrossDomainMessageGasLimits.Withdrawal))
        );

        emit InitiateRwaTransfer(currencyKey, destination, amount);
    }

    function finalizeRwaTransfer(bytes32 currencyKey, address destination, uint amount) external onlyCounterpart {
        _incrementRwasTransferCounter(RWAONE_TRANSFER_RECV, currencyKey, amount);

        issuer().issueRwasWithoutDebt(currencyKey, destination, amount);

        emit FinalizeRwaTransfer(currencyKey, destination, amount);
    }

    // ==== INTERNAL FUNCTIONS ====

    function _incrementRwasTransferCounter(bytes32 group, bytes32 currencyKey, uint amount) internal {
        bytes32 key = keccak256(abi.encodePacked(RWAONE_TRANSFER_NAMESPACE, group, currencyKey));

        uint currentRwas = flexibleStorage().getUIntValue(CONTRACT_NAME(), key);

        flexibleStorage().setUIntValue(CONTRACT_NAME(), key, currentRwas.add(amount));
    }

    function _sumTransferAmounts(bytes32 group) internal view returns (uint sum) {
        // get list of rwas from issuer
        bytes32[] memory currencyKeys = issuer().availableCurrencyKeys();

        // get all rwa rates
        (uint[] memory rates, bool isInvalid) = exchangeRates().ratesAndInvalidForCurrencies(currencyKeys);

        require(!isInvalid, "Rates are invalid");

        // get all values
        bytes32[] memory transferAmountKeys = new bytes32[](currencyKeys.length);
        for (uint i = 0; i < currencyKeys.length; i++) {
            transferAmountKeys[i] = keccak256(abi.encodePacked(RWAONE_TRANSFER_NAMESPACE, group, currencyKeys[i]));
        }

        uint[] memory transferAmounts = flexibleStorage().getUIntValues(CONTRACT_NAME(), transferAmountKeys);

        for (uint i = 0; i < currencyKeys.length; i++) {
            sum = sum.add(transferAmounts[i].multiplyDecimalRound(rates[i]));
        }
    }

    // ========== EVENTS ==========

    event InitiationSuspended();

    event InitiationResumed();

    event InitiateRwaTransfer(bytes32 indexed currencyKey, address indexed destination, uint256 amount);
    event FinalizeRwaTransfer(bytes32 indexed currencyKey, address indexed destination, uint256 amount);
}
