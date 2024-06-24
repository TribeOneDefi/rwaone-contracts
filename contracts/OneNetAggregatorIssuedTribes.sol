pragma solidity ^0.5.16;

import "./BaseOneNetAggregator.sol";

contract OneNetAggregatorIssuedTribes is BaseOneNetAggregator {
    bytes32 public constant CONTRACT_NAME = "OneNetAggregatorIssuedTribes";

    constructor(AddressResolver _resolver) public BaseOneNetAggregator(_resolver) {}

    function getRoundData(uint80) public view returns (uint80, int256, uint256, uint256, uint80) {
        uint totalIssuedTribes = IIssuer(resolver.requireAndGetAddress("Issuer", "aggregate debt info")).totalIssuedTribes(
            "rUSD",
            true
        );

        uint dataTimestamp = now;

        if (overrideTimestamp != 0) {
            dataTimestamp = overrideTimestamp;
        }

        return (1, int256(totalIssuedTribes), dataTimestamp, dataTimestamp, 1);
    }
}
