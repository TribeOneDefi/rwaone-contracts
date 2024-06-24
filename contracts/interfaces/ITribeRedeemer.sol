pragma solidity >=0.4.24;

import "./IERC20.sol";

interface ITribeRedeemer {
    // Rate of redemption - 0 for none
    function redemptions(address tribeProxy) external view returns (uint redeemRate);

    // rUSD balance of deprecated token holder
    function balanceOf(IERC20 tribeProxy, address account) external view returns (uint balanceOfInrUSD);

    // Full rUSD supply of token
    function totalSupply(IERC20 tribeProxy) external view returns (uint totalSupplyInrUSD);

    function redeem(IERC20 tribeProxy) external;

    function redeemAll(IERC20[] calldata tribeProxies) external;

    function redeemPartial(IERC20 tribeProxy, uint amountOfTribe) external;

    // Restricted to Issuer
    function deprecate(IERC20 tribeProxy, uint rateToRedeem) external;
}
