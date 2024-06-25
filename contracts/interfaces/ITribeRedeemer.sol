pragma solidity >=0.4.24;

import "./IERC20.sol";

interface IRwaRedeemer {
    // Rate of redemption - 0 for none
    function redemptions(address rwaProxy) external view returns (uint redeemRate);

    // rUSD balance of deprecated token holder
    function balanceOf(IERC20 rwaProxy, address account) external view returns (uint balanceOfInrUSD);

    // Full rUSD supply of token
    function totalSupply(IERC20 rwaProxy) external view returns (uint totalSupplyInrUSD);

    function redeem(IERC20 rwaProxy) external;

    function redeemAll(IERC20[] calldata rwaProxies) external;

    function redeemPartial(IERC20 rwaProxy, uint amountOfRwa) external;

    // Restricted to Issuer
    function deprecate(IERC20 rwaProxy, uint rateToRedeem) external;
}
