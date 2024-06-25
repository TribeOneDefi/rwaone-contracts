pragma solidity >=0.4.24;

// https://docs.rwaone.io/contracts/source/interfaces/irwa
interface IRwa {
    // Views
    function currencyKey() external view returns (bytes32);

    function transferableRwas(address account) external view returns (uint);

    // Mutative functions
    function transferAndSettle(address to, uint value) external returns (bool);

    function transferFromAndSettle(address from, address to, uint value) external returns (bool);

    // Restricted: used internally to Rwaone
    function burn(address account, uint amount) external;

    function issue(address account, uint amount) external;
}
