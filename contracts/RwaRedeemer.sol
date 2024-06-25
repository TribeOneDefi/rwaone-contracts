pragma solidity ^0.5.16;

// Inheritence
import "./MixinResolver.sol";
import "./interfaces/IRwaRedeemer.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IERC20.sol";
import "./interfaces/IIssuer.sol";

contract RwaRedeemer is IRwaRedeemer, MixinResolver {
    using SafeDecimalMath for uint;

    bytes32 public constant CONTRACT_NAME = "RwaRedeemer";

    mapping(address => uint) public redemptions;

    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_RWAONERUSD = "RwarUSD";

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

    function totalSupply(IERC20 rwaProxy) public view returns (uint supplyInrUSD) {
        supplyInrUSD = rwaProxy.totalSupply().multiplyDecimal(redemptions[address(rwaProxy)]);
    }

    function balanceOf(IERC20 rwaProxy, address account) external view returns (uint balanceInrUSD) {
        balanceInrUSD = rwaProxy.balanceOf(account).multiplyDecimal(redemptions[address(rwaProxy)]);
    }

    function redeemAll(IERC20[] calldata rwaProxies) external {
        for (uint i = 0; i < rwaProxies.length; i++) {
            _redeem(rwaProxies[i], rwaProxies[i].balanceOf(msg.sender));
        }
    }

    function redeem(IERC20 rwaProxy) external {
        _redeem(rwaProxy, rwaProxy.balanceOf(msg.sender));
    }

    function redeemPartial(IERC20 rwaProxy, uint amountOfRwa) external {
        // technically this check isn't necessary - Rwa.burn would fail due to safe sub,
        // but this is a useful error message to the user
        require(rwaProxy.balanceOf(msg.sender) >= amountOfRwa, "Insufficient balance");
        _redeem(rwaProxy, amountOfRwa);
    }

    function _redeem(IERC20 rwaProxy, uint amountOfRwa) internal {
        uint rateToRedeem = redemptions[address(rwaProxy)];
        require(rateToRedeem > 0, "Rwa not redeemable");
        require(amountOfRwa > 0, "No balance of rwa to redeem");
        issuer().burnForRedemption(address(rwaProxy), msg.sender, amountOfRwa);
        uint amountInrUSD = amountOfRwa.multiplyDecimal(rateToRedeem);
        rUSD().transfer(msg.sender, amountInrUSD);
        emit RwaRedeemed(address(rwaProxy), msg.sender, amountOfRwa, amountInrUSD);
    }

    function deprecate(IERC20 rwaProxy, uint rateToRedeem) external onlyIssuer {
        address rwaProxyAddress = address(rwaProxy);
        require(redemptions[rwaProxyAddress] == 0, "Rwa is already deprecated");
        require(rateToRedeem > 0, "No rate for rwa to redeem");
        uint totalRwaSupply = rwaProxy.totalSupply();
        uint supplyInrUSD = totalRwaSupply.multiplyDecimal(rateToRedeem);
        require(rUSD().balanceOf(address(this)) >= supplyInrUSD, "rUSD must first be supplied");
        redemptions[rwaProxyAddress] = rateToRedeem;
        emit RwaDeprecated(address(rwaProxy), rateToRedeem, totalRwaSupply, supplyInrUSD);
    }

    function requireOnlyIssuer() internal view {
        require(msg.sender == address(issuer()), "Restricted to Issuer contract");
    }

    modifier onlyIssuer() {
        requireOnlyIssuer();
        _;
    }

    event RwaRedeemed(address rwa, address account, uint amountOfRwa, uint amountInrUSD);
    event RwaDeprecated(address rwa, uint rateToRedeem, uint totalRwaSupply, uint supplyInrUSD);
}
