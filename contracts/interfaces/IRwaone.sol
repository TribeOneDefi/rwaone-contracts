pragma solidity >=0.4.24;

import "./IRwa.sol";
import "./IVirtualRwa.sol";

// https://docs.rwaone.io/contracts/source/interfaces/irwaone
interface IRwaone {
    // Views
    function anyRwaOrRWAXRateIsInvalid() external view returns (bool anyRateInvalid);

    function availableCurrencyKeys() external view returns (bytes32[] memory);

    function availableRwaCount() external view returns (uint);

    function availableRwas(uint index) external view returns (IRwa);

    function collateral(address account) external view returns (uint);

    function collateralisationRatio(address issuer) external view returns (uint);

    function debtBalanceOf(address issuer, bytes32 currencyKey) external view returns (uint);

    function isWaitingPeriod(bytes32 currencyKey) external view returns (bool);

    function maxIssuableRwas(address issuer) external view returns (uint maxIssuable);

    function remainingIssuableRwas(
        address issuer
    ) external view returns (uint maxIssuable, uint alreadyIssued, uint totalSystemDebt);

    function rwas(bytes32 currencyKey) external view returns (IRwa);

    function rwasByAddress(address rwaAddress) external view returns (bytes32);

    function totalIssuedRwas(bytes32 currencyKey) external view returns (uint);

    function totalIssuedRwasExcludeOtherCollateral(bytes32 currencyKey) external view returns (uint);

    function transferableRwaone(address account) external view returns (uint transferable);

    function getFirstNonZeroEscrowIndex(address account) external view returns (uint);

    // Mutative Functions
    function burnRwas(uint amount) external;

    function burnRwasOnBehalf(address burnForAddress, uint amount) external;

    function burnRwasToTarget() external;

    function burnRwasToTargetOnBehalf(address burnForAddress) external;

    function exchange(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external returns (uint amountReceived);

    function exchangeOnBehalf(
        address exchangeForAddress,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external returns (uint amountReceived);

    function exchangeWithTracking(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external returns (uint amountReceived);

    function exchangeWithTrackingForInitiator(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external returns (uint amountReceived);

    function exchangeOnBehalfWithTracking(
        address exchangeForAddress,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external returns (uint amountReceived);

    function exchangeWithVirtual(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        bytes32 trackingCode
    ) external returns (uint amountReceived, IVirtualRwa vRwa);

    function exchangeAtomically(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        bytes32 trackingCode,
        uint minAmount
    ) external returns (uint amountReceived);

    function issueMaxRwas() external;

    function issueMaxRwasOnBehalf(address issueForAddress) external;

    function issueRwas(uint amount) external;

    function issueRwasOnBehalf(address issueForAddress, uint amount) external;

    function mint() external returns (bool);

    function settle(bytes32 currencyKey) external returns (uint reclaimed, uint refunded, uint numEntries);

    // Liquidations
    function liquidateDelinquentAccount(address account) external returns (bool);

    function liquidateDelinquentAccountEscrowIndex(address account, uint escrowStartIndex) external returns (bool);

    function liquidateSelf() external returns (bool);

    // Restricted Functions

    function mintSecondary(address account, uint amount) external;

    function mintSecondaryRewards(uint amount) external;

    function burnSecondary(address account, uint amount) external;

    function revokeAllEscrow(address account) external;

    function migrateAccountBalances(address account) external returns (uint totalEscrowRevoked, uint totalLiquidBalance);
}
