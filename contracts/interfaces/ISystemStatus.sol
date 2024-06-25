pragma solidity >=0.4.24;

// https://docs.rwaone.io/contracts/source/interfaces/isystemstatus
interface ISystemStatus {
    struct Status {
        bool canSuspend;
        bool canResume;
    }

    struct Suspension {
        bool suspended;
        // reason is an integer code,
        // 0 => no reason, 1 => upgrading, 2+ => defined by system usage
        uint248 reason;
    }

    // Views
    function accessControl(bytes32 section, address account) external view returns (bool canSuspend, bool canResume);

    function requireSystemActive() external view;

    function systemSuspended() external view returns (bool);

    function requireIssuanceActive() external view;

    function requireExchangeActive() external view;

    function requireFuturesActive() external view;

    function requireFuturesMarketActive(bytes32 marketKey) external view;

    function requireExchangeBetweenRwasAllowed(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey) external view;

    function requireRwaActive(bytes32 currencyKey) external view;

    function rwaSuspended(bytes32 currencyKey) external view returns (bool);

    function requireRwasActive(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey) external view;

    function systemSuspension() external view returns (bool suspended, uint248 reason);

    function issuanceSuspension() external view returns (bool suspended, uint248 reason);

    function exchangeSuspension() external view returns (bool suspended, uint248 reason);

    function futuresSuspension() external view returns (bool suspended, uint248 reason);

    function rwaExchangeSuspension(bytes32 currencyKey) external view returns (bool suspended, uint248 reason);

    function rwaSuspension(bytes32 currencyKey) external view returns (bool suspended, uint248 reason);

    function futuresMarketSuspension(bytes32 marketKey) external view returns (bool suspended, uint248 reason);

    function getRwaExchangeSuspensions(
        bytes32[] calldata rwas
    ) external view returns (bool[] memory exchangeSuspensions, uint256[] memory reasons);

    function getRwaSuspensions(
        bytes32[] calldata rwas
    ) external view returns (bool[] memory suspensions, uint256[] memory reasons);

    function getFuturesMarketSuspensions(
        bytes32[] calldata marketKeys
    ) external view returns (bool[] memory suspensions, uint256[] memory reasons);

    // Restricted functions
    function suspendIssuance(uint256 reason) external;

    function suspendRwa(bytes32 currencyKey, uint256 reason) external;

    function suspendFuturesMarket(bytes32 marketKey, uint256 reason) external;

    function updateAccessControl(bytes32 section, address account, bool canSuspend, bool canResume) external;
}
