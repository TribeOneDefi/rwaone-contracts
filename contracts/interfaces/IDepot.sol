pragma solidity >=0.4.24;

// https://docs.rwaone.io/contracts/source/interfaces/idepot
interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function rwasReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositRwas(uint amount) external;

    function exchangeEtherForRwas() external payable returns (uint);

    function exchangeEtherForRwasAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedRwas() external;

    // Note: On mainnet no wRWAX has been deposited. The following functions are kept alive for testnet wRWAX faucets.
    function exchangeEtherForRWAX() external payable returns (uint);

    function exchangeEtherForRWAXAtRate(uint guaranteedRate, uint guaranteedRwaoneRate) external payable returns (uint);

    function exchangeRwasForRWAX(uint rwaAmount) external returns (uint);

    function rwaoneReceivedForEther(uint amount) external view returns (uint);

    function rwaoneReceivedForRwas(uint amount) external view returns (uint);

    function withdrawRwaone(uint amount) external;
}
