pragma solidity ^0.5.16;

// Inheritance
import "../DebtCache.sol";

contract TestableDebtCache is DebtCache {
    constructor(address _owner, address _resolver) public DebtCache(_owner, _resolver) {}

    function setCachedRwaDebt(bytes32 currencyKey, uint debt) public {
        _cachedRwaDebt[currencyKey] = debt;
    }
}
