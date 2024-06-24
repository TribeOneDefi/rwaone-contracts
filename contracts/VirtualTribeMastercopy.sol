pragma solidity ^0.5.16;

import "./VirtualTribe.sol";

// https://docs.rwaone.io/contracts/source/contracts/virtualtribemastercopy
// Note: this is the "frozen" mastercopy of the VirtualTribe contract that should be linked to from
//       proxies.
contract VirtualTribeMastercopy is VirtualTribe {
    constructor() public ERC20() {
        // Freeze mastercopy on deployment so it can never be initialized with real arguments
        initialized = true;
    }
}
