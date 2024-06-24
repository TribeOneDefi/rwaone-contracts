pragma solidity >=0.4.24;

import "./IERC20.sol";

// https://docs.rwaone.io/contracts/source/interfaces/iwrapperfactory
interface IWrapperFactory {
    function isWrapper(address possibleWrapper) external view returns (bool);

    function createWrapper(IERC20 token, bytes32 currencyKey, bytes32 tribeContractName) external returns (address);

    function distributeFees() external;
}
