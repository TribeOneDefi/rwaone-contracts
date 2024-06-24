pragma solidity ^0.5.16;

// Inheritance
import "./interfaces/ITribe.sol";
import "./interfaces/IRwaone.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IERC20.sol";

// https://docs.rwaone.io/contracts/source/contracts/tribeutil
contract TribeUtil {
    IAddressResolver public addressResolverProxy;

    bytes32 internal constant CONTRACT_RWAONEETIX = "Rwaone";
    bytes32 internal constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 internal constant HUSD = "hUSD";

    constructor(address resolver) public {
        addressResolverProxy = IAddressResolver(resolver);
    }

    function _tribeetix() internal view returns (IRwaone) {
        return IRwaone(addressResolverProxy.requireAndGetAddress(CONTRACT_RWAONEETIX, "Missing Rwaone address"));
    }

    function _exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(addressResolverProxy.requireAndGetAddress(CONTRACT_EXRATES, "Missing ExchangeRates address"));
    }

    function totalTribesInKey(address account, bytes32 currencyKey) external view returns (uint total) {
        IRwaone rwaone = _tribeetix();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numTribes = rwaone.availableTribeCount();
        for (uint i = 0; i < numTribes; i++) {
            ITribe tribe = rwaone.availableTribes(i);
            total += exchangeRates.effectiveValue(
                tribe.currencyKey(),
                IERC20(address(tribe)).balanceOf(account),
                currencyKey
            );
        }
        return total;
    }

    function tribesBalances(address account) external view returns (bytes32[] memory, uint[] memory, uint[] memory) {
        IRwaone rwaone = _tribeetix();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numTribes = rwaone.availableTribeCount();
        bytes32[] memory currencyKeys = new bytes32[](numTribes);
        uint[] memory balances = new uint[](numTribes);
        uint[] memory hUSDBalances = new uint[](numTribes);
        for (uint i = 0; i < numTribes; i++) {
            ITribe tribe = rwaone.availableTribes(i);
            currencyKeys[i] = tribe.currencyKey();
            balances[i] = IERC20(address(tribe)).balanceOf(account);
            hUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], HUSD);
        }
        return (currencyKeys, balances, hUSDBalances);
    }

    function tribesRates() external view returns (bytes32[] memory, uint[] memory) {
        bytes32[] memory currencyKeys = _tribeetix().availableCurrencyKeys();
        return (currencyKeys, _exchangeRates().ratesForCurrencies(currencyKeys));
    }

    function tribesTotalSupplies() external view returns (bytes32[] memory, uint256[] memory, uint256[] memory) {
        IRwaone rwaone = _tribeetix();
        IExchangeRates exchangeRates = _exchangeRates();

        uint256 numTribes = rwaone.availableTribeCount();
        bytes32[] memory currencyKeys = new bytes32[](numTribes);
        uint256[] memory balances = new uint256[](numTribes);
        uint256[] memory hUSDBalances = new uint256[](numTribes);
        for (uint256 i = 0; i < numTribes; i++) {
            ITribe tribe = rwaone.availableTribes(i);
            currencyKeys[i] = tribe.currencyKey();
            balances[i] = IERC20(address(tribe)).totalSupply();
            hUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], HUSD);
        }
        return (currencyKeys, balances, hUSDBalances);
    }
}
