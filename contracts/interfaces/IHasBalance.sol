pragma solidity >=0.4.24;

// https://docs.rwaone.io/contracts/source/interfaces/ihasbalance
interface IHasBalance {
    // Views
    function balanceOf(address account) external view returns (uint);
}
