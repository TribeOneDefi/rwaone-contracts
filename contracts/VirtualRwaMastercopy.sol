pragma solidity ^0.5.16;

import "./VirtualRwa.sol";

// https://docs.rwaone.io/contracts/source/contracts/virtualrwamastercopy
// Note: this is the "frozen" mastercopy of the VirtualRwa contract that should be linked to from
//       proxies.
contract VirtualRwaMastercopy is VirtualRwa {
    constructor() public ERC20() {
        // Freeze mastercopy on deployment so it can never be initialized with real arguments
        initialized = true;
    }
}
