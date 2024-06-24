pragma solidity ^0.5.16;

import "../TradingRewards.sol";

import "../interfaces/IExchanger.sol";

contract FakeTradingRewards is TradingRewards {
    IERC20 public _mockRwaoneToken;

    constructor(
        address owner,
        address periodController,
        address resolver,
        address mockRwaoneToken
    ) public TradingRewards(owner, periodController, resolver) {
        _mockRwaoneToken = IERC20(mockRwaoneToken);
    }

    // Rwaone is mocked with an ERC20 token passed via the constructor.
    function rwaone() internal view returns (IERC20) {
        return IERC20(_mockRwaoneToken);
    }

    // Return msg.sender so that onlyExchanger modifier can be bypassed.
    function exchanger() internal view returns (IExchanger) {
        return IExchanger(msg.sender);
    }
}
