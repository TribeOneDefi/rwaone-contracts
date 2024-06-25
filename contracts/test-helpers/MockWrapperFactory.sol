pragma solidity ^0.5.16;

import "../SafeDecimalMath.sol";

contract MockWrapperFactory {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    uint public totalIssuedRwas;

    constructor() public {}

    function setTotalIssuedRwas(uint value) external {
        totalIssuedRwas = value;
    }
}
