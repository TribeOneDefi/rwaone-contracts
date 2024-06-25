pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRwaone.sol";

// Internal references
import "./interfaces/IRewardEscrow.sol";
import "./interfaces/IRewardEscrowV2.sol";
import "./interfaces/ISupplySchedule.sol";

// https://docs.rwaone.io/contracts/source/contracts/rwaone
contract Rwaone is BaseRwaone {
    bytes32 public constant CONTRACT_NAME = "Rwaone";

    // ========== ADDRESS RESOLVER CONFIGURATION ==========
    bytes32 private constant CONTRACT_REWARD_ESCROW = "RewardEscrow";
    bytes32 private constant CONTRACT_SUPPLYSCHEDULE = "SupplySchedule";
    address private rwaxToken;

    // ========== CONSTRUCTOR ==========

    constructor(
        address payable _proxy,
        TokenState _tokenState,
        address _owner,
        uint _totalSupply,
        address _resolver
    ) public BaseRwaone(_proxy, _tokenState, _owner, _totalSupply, _resolver) {}

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRwaone.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](2);
        newAddresses[0] = CONTRACT_REWARD_ESCROW;
        newAddresses[1] = CONTRACT_SUPPLYSCHEDULE;
        return combineArrays(existingAddresses, newAddresses);
    }

    // ========== VIEWS ==========

    function rewardEscrow() internal view returns (IRewardEscrow) {
        return IRewardEscrow(requireAndGetAddress(CONTRACT_REWARD_ESCROW));
    }

    function supplySchedule() internal view returns (ISupplySchedule) {
        return ISupplySchedule(requireAndGetAddress(CONTRACT_SUPPLYSCHEDULE));
    }

    // ========== OVERRIDDEN FUNCTIONS ==========

    function exchangeWithVirtual(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        bytes32 trackingCode
    )
        external
        exchangeActive(sourceCurrencyKey, destinationCurrencyKey)
        optionalProxy
        returns (uint amountReceived, IVirtualRwa vRwa)
    {
        return
            exchanger().exchange(
                messageSender,
                messageSender,
                sourceCurrencyKey,
                sourceAmount,
                destinationCurrencyKey,
                messageSender,
                true,
                messageSender,
                trackingCode
            );
    }

    // SIP-140 The initiating user of this exchange will receive the proceeds of the exchange
    // Note: this function may have unintended consequences if not understood correctly. Please
    // read SIP-140 for more information on the use-case
    function exchangeWithTrackingForInitiator(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address rewardAddress,
        bytes32 trackingCode
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        (amountReceived, ) = exchanger().exchange(
            messageSender,
            messageSender,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            // solhint-disable avoid-tx-origin
            tx.origin,
            false,
            rewardAddress,
            trackingCode
        );
    }

    function exchangeAtomically(
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        bytes32 trackingCode,
        uint minAmount
    ) external exchangeActive(sourceCurrencyKey, destinationCurrencyKey) optionalProxy returns (uint amountReceived) {
        return
            exchanger().exchangeAtomically(
                messageSender,
                sourceCurrencyKey,
                sourceAmount,
                destinationCurrencyKey,
                messageSender,
                trackingCode,
                minAmount
            );
    }

    function settle(
        bytes32 currencyKey
    ) external optionalProxy returns (uint reclaimed, uint refunded, uint numEntriesSettled) {
        return exchanger().settle(messageSender, currencyKey);
    }

    function mint() external issuanceActive returns (bool) {
        // require(address(rewardsDistribution()) != address(0), "RewardsDistribution not set");

        // ISupplySchedule _supplySchedule = supplySchedule();
        // IRewardsDistribution _rewardsDistribution = rewardsDistribution();

        // uint supplyToMint = _supplySchedule.mintableSupply();
        // require(supplyToMint > 0, "No supply is mintable");

        // emitTransfer(address(0), address(this), supplyToMint);

        // // record minting event before mutation to token supply
        // uint minterReward = _supplySchedule.recordMintEvent(supplyToMint);

        // // Set minted wRWAX balance to RewardEscrow's balance
        // // Minus the minterReward and set balance of minter to add reward
        // uint amountToDistribute = supplyToMint.sub(minterReward);

        // // Set the token balance to the RewardsDistribution contract
        // tokenState.setBalanceOf(
        //     address(_rewardsDistribution),
        //     tokenState.balanceOf(address(_rewardsDistribution)).add(amountToDistribute)
        // );
        // emitTransfer(address(this), address(_rewardsDistribution), amountToDistribute);

        // // Kick off the distribution of rewards
        // _rewardsDistribution.distributeRewards(amountToDistribute);

        // // Assign the minters reward.
        // tokenState.setBalanceOf(msg.sender, tokenState.balanceOf(msg.sender).add(minterReward));
        // emitTransfer(address(this), msg.sender, minterReward);

        // // Increase total supply by minted amount
        // totalSupply = totalSupply.add(supplyToMint);

        return true;
    }

    /* Once off function for SIP-60 to migrate wRWAX balances in the RewardEscrow contract
     * To the new RewardEscrowV2 contract
     */
    function migrateEscrowBalanceToRewardEscrowV2() external onlyOwner {
        // Record balanceOf(RewardEscrow) contract
        uint rewardEscrowBalance = tokenState.balanceOf(address(rewardEscrow()));

        // transfer all of RewardEscrow's balance to RewardEscrowV2
        // _internalTransfer emits the transfer event
        _internalTransfer(address(rewardEscrow()), address(rewardEscrowV2()), rewardEscrowBalance);
    }

    // ========== EVENTS ==========

    event AtomicRwaExchange(
        address indexed account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    );
    bytes32 internal constant ATOMIC_RWAONE_EXCHANGE_SIG =
        keccak256("AtomicRwaExchange(address,bytes32,uint256,bytes32,uint256,address)");

    function emitAtomicRwaExchange(
        address account,
        bytes32 fromCurrencyKey,
        uint256 fromAmount,
        bytes32 toCurrencyKey,
        uint256 toAmount,
        address toAddress
    ) external onlyExchanger {
        proxy._emit(
            abi.encode(fromCurrencyKey, fromAmount, toCurrencyKey, toAmount, toAddress),
            2,
            ATOMIC_RWAONE_EXCHANGE_SIG,
            addressToBytes32(account),
            0,
            0
        );
    }

    function setRwaxAddress(address _rwaxToken) public onlyOwner {
        rwaxToken = _rwaxToken;
    }

    function wrap(uint256 amount) public {
        require(amount > 0, "Amount must be greater than 0");
        require(IERC20(rwaxToken).transferFrom(msg.sender, address(this), amount), "Transfer failed");
        _mint(msg.sender, amount);
    }

    function unwrap(uint256 amount) public {
        require(amount > 0, "Amount must be greater than 0");
        _burn(msg.sender, amount);
        require(IERC20(rwaxToken).transfer(msg.sender, amount), "Transfer failed");
    }

    function _mint(address to, uint256 amount) private {
        // This line of code calls the `setBalanceOf` function on the `tokenState` object to update the balance of
        // the specified address (`to`) with the added `amount` of tokens
        tokenState.setBalanceOf(to, tokenState.balanceOf(to).add(amount));
        emitTransfer(address(0), to, amount);

        // Increase total supply by minted amount
        totalSupply = totalSupply.add(amount);
    }

    function _burn(address from, uint256 amount) private {
        tokenState.setBalanceOf(from, tokenState.balanceOf(from).sub(amount));
        emitTransfer(from, address(0), amount);

        // Increase total supply by minted amount
        totalSupply = totalSupply.sub(amount);
    }
}
