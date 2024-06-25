pragma solidity ^0.5.16;

// Inheritance
import "./interfaces/IRwa.sol";
import "./interfaces/IRwaone.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IERC20.sol";

// https://docs.rwaone.io/contracts/source/contracts/rwautil
contract RwaUtil {
    IAddressResolver public addressResolverProxy;

    bytes32 internal constant CONTRACT_RWAONE = "Rwaone";
    bytes32 internal constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 internal constant RUSD = "rUSD";

    constructor(address resolver) public {
        addressResolverProxy = IAddressResolver(resolver);
    }

    function _rwaone() internal view returns (IRwaone) {
        return IRwaone(addressResolverProxy.requireAndGetAddress(CONTRACT_RWAONE, "Missing Rwaone address"));
    }

    function _exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(addressResolverProxy.requireAndGetAddress(CONTRACT_EXRATES, "Missing ExchangeRates address"));
    }

    function totalRwasInKey(address account, bytes32 currencyKey) external view returns (uint total) {
        IRwaone rwaone = _rwaone();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numRwas = rwaone.availableRwaCount();
        for (uint i = 0; i < numRwas; i++) {
            IRwa rwa = rwaone.availableRwas(i);
            total += exchangeRates.effectiveValue(rwa.currencyKey(), IERC20(address(rwa)).balanceOf(account), currencyKey);
        }
        return total;
    }

    function rwasBalances(address account) external view returns (bytes32[] memory, uint[] memory, uint[] memory) {
        IRwaone rwaone = _rwaone();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numRwas = rwaone.availableRwaCount();
        bytes32[] memory currencyKeys = new bytes32[](numRwas);
        uint[] memory balances = new uint[](numRwas);
        uint[] memory rUSDBalances = new uint[](numRwas);
        for (uint i = 0; i < numRwas; i++) {
            IRwa rwa = rwaone.availableRwas(i);
            currencyKeys[i] = rwa.currencyKey();
            balances[i] = IERC20(address(rwa)).balanceOf(account);
            rUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], RUSD);
        }
        return (currencyKeys, balances, rUSDBalances);
    }

    function rwasRates() external view returns (bytes32[] memory, uint[] memory) {
        bytes32[] memory currencyKeys = _rwaone().availableCurrencyKeys();
        return (currencyKeys, _exchangeRates().ratesForCurrencies(currencyKeys));
    }

    function rwasTotalSupplies() external view returns (bytes32[] memory, uint256[] memory, uint256[] memory) {
        IRwaone rwaone = _rwaone();
        IExchangeRates exchangeRates = _exchangeRates();

        uint256 numRwas = rwaone.availableRwaCount();
        bytes32[] memory currencyKeys = new bytes32[](numRwas);
        uint256[] memory balances = new uint256[](numRwas);
        uint256[] memory rUSDBalances = new uint256[](numRwas);
        for (uint256 i = 0; i < numRwas; i++) {
            IRwa rwa = rwaone.availableRwas(i);
            currencyKeys[i] = rwa.currencyKey();
            balances[i] = IERC20(address(rwa)).totalSupply();
            rUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], RUSD);
        }
        return (currencyKeys, balances, rUSDBalances);
    }
}
