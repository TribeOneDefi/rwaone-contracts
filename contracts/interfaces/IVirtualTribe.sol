pragma solidity >=0.4.24;

import "./IRwa.sol";

interface IVirtualRwa {
    // Views
    function balanceOfUnderlying(address account) external view returns (uint);

    function rate() external view returns (uint);

    function readyToSettle() external view returns (bool);

    function secsLeftInWaitingPeriod() external view returns (uint);

    function settled() external view returns (bool);

    function rwa() external view returns (IRwa);

    // Mutative functions
    function settle(address account) external;
}
