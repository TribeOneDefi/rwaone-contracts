pragma solidity >=0.4.24;

interface IRwaoneBridgeEscrow {
    function approveBridge(address _token, address _bridge, uint256 _amount) external;
}
