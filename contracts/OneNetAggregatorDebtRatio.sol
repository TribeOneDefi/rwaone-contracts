pragma solidity ^0.5.16;

import "./BaseOneNetAggregator.sol";

contract OneNetAggregatorDebtRatio is BaseOneNetAggregator {
    bytes32 public constant CONTRACT_NAME = "OneNetAggregatorDebtRatio";

    constructor(AddressResolver _resolver) public BaseOneNetAggregator(_resolver) {}

    function getRoundData(uint80) public view returns (uint80, int256, uint256, uint256, uint80) {
        uint totalIssuedRwas = IIssuer(resolver.requireAndGetAddress("Issuer", "aggregate debt info")).totalIssuedRwas(
            "rUSD",
            true
        );
        uint totalDebtShares = IRwaoneDebtShare(resolver.requireAndGetAddress("RwaoneDebtShare", "aggregate debt info"))
            .totalSupply();

        uint result = totalDebtShares == 0
            ? 10 ** 27
            : totalIssuedRwas.decimalToPreciseDecimal().divideDecimalRound(totalDebtShares);

        uint dataTimestamp = now;

        if (overrideTimestamp != 0) {
            dataTimestamp = overrideTimestamp;
        }

        return (1, int256(result), dataTimestamp, dataTimestamp, 1);
    }
}
