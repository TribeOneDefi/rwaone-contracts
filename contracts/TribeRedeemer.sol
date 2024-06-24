pragma solidity ^0.5.16;

// Inheritence
import "./MixinResolver.sol";
import "./interfaces/ITribeRedeemer.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IERC20.sol";
import "./interfaces/IIssuer.sol";

contract TribeRedeemer is ITribeRedeemer, MixinResolver {
    using SafeDecimalMath for uint;

    bytes32 public constant CONTRACT_NAME = "TribeRedeemer";

    mapping(address => uint) public redemptions;

    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_RWAONERUSD = "TriberUSD";

    constructor(address _resolver) public MixinResolver(_resolver) {}

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        addresses = new bytes32[](2);
        addresses[0] = CONTRACT_ISSUER;
        addresses[1] = CONTRACT_RWAONERUSD;
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function rUSD() internal view returns (IERC20) {
        return IERC20(requireAndGetAddress(CONTRACT_RWAONERUSD));
    }

    function totalSupply(IERC20 tribeProxy) public view returns (uint supplyInrUSD) {
        supplyInrUSD = tribeProxy.totalSupply().multiplyDecimal(redemptions[address(tribeProxy)]);
    }

    function balanceOf(IERC20 tribeProxy, address account) external view returns (uint balanceInrUSD) {
        balanceInrUSD = tribeProxy.balanceOf(account).multiplyDecimal(redemptions[address(tribeProxy)]);
    }

    function redeemAll(IERC20[] calldata tribeProxies) external {
        for (uint i = 0; i < tribeProxies.length; i++) {
            _redeem(tribeProxies[i], tribeProxies[i].balanceOf(msg.sender));
        }
    }

    function redeem(IERC20 tribeProxy) external {
        _redeem(tribeProxy, tribeProxy.balanceOf(msg.sender));
    }

    function redeemPartial(IERC20 tribeProxy, uint amountOfTribe) external {
        // technically this check isn't necessary - Tribe.burn would fail due to safe sub,
        // but this is a useful error message to the user
        require(tribeProxy.balanceOf(msg.sender) >= amountOfTribe, "Insufficient balance");
        _redeem(tribeProxy, amountOfTribe);
    }

    function _redeem(IERC20 tribeProxy, uint amountOfTribe) internal {
        uint rateToRedeem = redemptions[address(tribeProxy)];
        require(rateToRedeem > 0, "Tribe not redeemable");
        require(amountOfTribe > 0, "No balance of tribe to redeem");
        issuer().burnForRedemption(address(tribeProxy), msg.sender, amountOfTribe);
        uint amountInrUSD = amountOfTribe.multiplyDecimal(rateToRedeem);
        rUSD().transfer(msg.sender, amountInrUSD);
        emit TribeRedeemed(address(tribeProxy), msg.sender, amountOfTribe, amountInrUSD);
    }

    function deprecate(IERC20 tribeProxy, uint rateToRedeem) external onlyIssuer {
        address tribeProxyAddress = address(tribeProxy);
        require(redemptions[tribeProxyAddress] == 0, "Tribe is already deprecated");
        require(rateToRedeem > 0, "No rate for tribe to redeem");
        uint totalTribeSupply = tribeProxy.totalSupply();
        uint supplyInrUSD = totalTribeSupply.multiplyDecimal(rateToRedeem);
        require(rUSD().balanceOf(address(this)) >= supplyInrUSD, "rUSD must first be supplied");
        redemptions[tribeProxyAddress] = rateToRedeem;
        emit TribeDeprecated(address(tribeProxy), rateToRedeem, totalTribeSupply, supplyInrUSD);
    }

    function requireOnlyIssuer() internal view {
        require(msg.sender == address(issuer()), "Restricted to Issuer contract");
    }

    modifier onlyIssuer() {
        requireOnlyIssuer();
        _;
    }

    event TribeRedeemed(address tribe, address account, uint amountOfTribe, uint amountInrUSD);
    event TribeDeprecated(address tribe, uint rateToRedeem, uint totalTribeSupply, uint supplyInrUSD);
}
