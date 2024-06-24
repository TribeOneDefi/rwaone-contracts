pragma solidity >=0.4.24;

// https://docs.rwaone.io/contracts/source/interfaces/idepot
interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function tribesReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositTribes(uint amount) external;

    function exchangeEtherForTribes() external payable returns (uint);

    function exchangeEtherForTribesAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedTribes() external;

    // Note: On mainnet no wRWAX has been deposited. The following functions are kept alive for testnet wRWAX faucets.
    function exchangeEtherForRWAX() external payable returns (uint);

    function exchangeEtherForRWAXAtRate(uint guaranteedRate, uint guaranteedRwaoneRate) external payable returns (uint);

    function exchangeTribesForRWAX(uint tribeAmount) external returns (uint);

    function tribeetixReceivedForEther(uint amount) external view returns (uint);

    function tribeetixReceivedForTribes(uint amount) external view returns (uint);

    function withdrawRwaone(uint amount) external;
}
