pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IEtherWrapper.sol";
import "./interfaces/IRwa.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IWETH.sol";

// Internal references
import "./Pausable.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IFeePool.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";

// Libraries
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "./SafeDecimalMath.sol";

// https://docs.rwaone.io/contracts/source/contracts/etherwrapper
contract EtherWrapper is Owned, Pausable, MixinResolver, MixinSystemSettings, IEtherWrapper {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    /* ========== CONSTANTS ============== */

    /* ========== ENCODED NAMES ========== */

    bytes32 internal constant rUSD = "rUSD";
    bytes32 internal constant rETH = "rETH";
    bytes32 internal constant ETH = "ETH";
    bytes32 internal constant wRWAX = "wRWAX";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_RWAONEHETH = "RwarETH";
    bytes32 private constant CONTRACT_RWAONERUSD = "RwarUSD";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";

    // ========== STATE VARIABLES ==========
    IWETH internal _weth;

    uint public rETHIssued = 0;
    uint public rUSDIssued = 0;
    uint public feesEscrowed = 0;

    constructor(
        address _owner,
        address _resolver,
        address payable _WETH
    ) public Owned(_owner) Pausable() MixinSystemSettings(_resolver) {
        _weth = IWETH(_WETH);
    }

    /* ========== VIEWS ========== */
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](5);
        newAddresses[0] = CONTRACT_RWAONEHETH;
        newAddresses[1] = CONTRACT_RWAONERUSD;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_ISSUER;
        newAddresses[4] = CONTRACT_FEEPOOL;
        addresses = combineArrays(existingAddresses, newAddresses);
        return addresses;
    }

    /* ========== INTERNAL VIEWS ========== */
    function rwarUSD() internal view returns (IRwa) {
        return IRwa(requireAndGetAddress(CONTRACT_RWAONERUSD));
    }

    function rwarETH() internal view returns (IRwa) {
        return IRwa(requireAndGetAddress(CONTRACT_RWAONEHETH));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(requireAndGetAddress(CONTRACT_FEEPOOL));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    // ========== VIEWS ==========

    function capacity() public view returns (uint _capacity) {
        // capacity = max(maxETH - balance, 0)
        uint balance = getReserves();
        if (balance >= maxETH()) {
            return 0;
        }
        return maxETH().sub(balance);
    }

    function getReserves() public view returns (uint) {
        return _weth.balanceOf(address(this));
    }

    function totalIssuedRwas() public view returns (uint) {
        // This contract issues two different rwas:
        // 1. rETH
        // 2. rUSD
        //
        // The rETH is always backed 1:1 with WETH.
        // The rUSD fees are backed by rETH that is withheld during minting and burning.
        return exchangeRates().effectiveValue(rETH, rETHIssued, rUSD).add(rUSDIssued);
    }

    function calculateMintFee(uint amount) public view returns (uint) {
        return amount.multiplyDecimalRound(mintFeeRate());
    }

    function calculateBurnFee(uint amount) public view returns (uint) {
        return amount.multiplyDecimalRound(burnFeeRate());
    }

    function maxETH() public view returns (uint256) {
        return getEtherWrapperMaxETH();
    }

    function mintFeeRate() public view returns (uint256) {
        return getEtherWrapperMintFeeRate();
    }

    function burnFeeRate() public view returns (uint256) {
        return getEtherWrapperBurnFeeRate();
    }

    function weth() public view returns (IWETH) {
        return _weth;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    // Transfers `amountIn` WETH to mint `amountIn - fees` rETH.
    // `amountIn` is inclusive of fees, calculable via `calculateMintFee`.
    function mint(uint amountIn) external notPaused {
        require(amountIn <= _weth.allowance(msg.sender, address(this)), "Allowance not high enough");
        require(amountIn <= _weth.balanceOf(msg.sender), "Balance is too low");

        uint currentCapacity = capacity();
        require(currentCapacity > 0, "Contract has no spare capacity to mint");

        if (amountIn < currentCapacity) {
            _mint(amountIn);
        } else {
            _mint(currentCapacity);
        }
    }

    // Burns `amountIn` rETH for `amountIn - fees` WETH.
    // `amountIn` is inclusive of fees, calculable via `calculateBurnFee`.
    function burn(uint amountIn) external notPaused {
        uint reserves = getReserves();
        require(reserves > 0, "Contract cannot burn rETH for WETH, WETH balance is zero");

        // principal = [amountIn / (1 + burnFeeRate)]
        uint principal = amountIn.divideDecimalRound(SafeDecimalMath.unit().add(burnFeeRate()));

        if (principal < reserves) {
            _burn(principal, amountIn);
        } else {
            _burn(reserves, reserves.add(calculateBurnFee(reserves)));
        }
    }

    function distributeFees() external {
        // Normalize fee to rUSD
        require(!exchangeRates().rateIsInvalid(rETH), "Currency rate is invalid");
        uint amountRUSD = exchangeRates().effectiveValue(rETH, feesEscrowed, rUSD);

        // Burn rETH.
        rwarETH().burn(address(this), feesEscrowed);
        // Pay down as much rETH debt as we burn. Any other debt is taken on by the stakers.
        rETHIssued = rETHIssued < feesEscrowed ? 0 : rETHIssued.sub(feesEscrowed);

        // Issue rUSD to the fee pool
        issuer().rwas(rUSD).issue(feePool().FEE_ADDRESS(), amountRUSD);
        rUSDIssued = rUSDIssued.add(amountRUSD);

        // Tell the fee pool about this
        feePool().recordFeePaid(amountRUSD);

        feesEscrowed = 0;
    }

    // ========== RESTRICTED ==========

    /**
     * @notice Fallback function
     */
    function() external payable {
        revert("Fallback disabled, use mint()");
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _mint(uint amountIn) internal {
        // Calculate minting fee.
        uint feeAmountEth = calculateMintFee(amountIn);
        uint principal = amountIn.sub(feeAmountEth);

        // Transfer WETH from user.
        _weth.transferFrom(msg.sender, address(this), amountIn);

        // Mint `amountIn - fees` rETH to user.
        rwarETH().issue(msg.sender, principal);

        // Escrow fee.
        rwarETH().issue(address(this), feeAmountEth);
        feesEscrowed = feesEscrowed.add(feeAmountEth);

        // Add rETH debt.
        rETHIssued = rETHIssued.add(amountIn);

        emit Minted(msg.sender, principal, feeAmountEth, amountIn);
    }

    function _burn(uint principal, uint amountIn) internal {
        // for burn, amount is inclusive of the fee.
        uint feeAmountEth = amountIn.sub(principal);

        require(amountIn <= IERC20(address(rwarETH())).allowance(msg.sender, address(this)), "Allowance not high enough");
        require(amountIn <= IERC20(address(rwarETH())).balanceOf(msg.sender), "Balance is too low");

        // Burn `amountIn` rETH from user.
        rwarETH().burn(msg.sender, amountIn);
        // rETH debt is repaid by burning.
        rETHIssued = rETHIssued < principal ? 0 : rETHIssued.sub(principal);

        // We use burn/issue instead of burning the principal and transferring the fee.
        // This saves an approval and is cheaper.
        // Escrow fee.
        rwarETH().issue(address(this), feeAmountEth);
        // We don't update rETHIssued, as only the principal was subtracted earlier.
        feesEscrowed = feesEscrowed.add(feeAmountEth);

        // Transfer `amount - fees` WETH to user.
        _weth.transfer(msg.sender, principal);

        emit Burned(msg.sender, principal, feeAmountEth, amountIn);
    }

    /* ========== EVENTS ========== */
    event Minted(address indexed account, uint principal, uint fee, uint amountIn);
    event Burned(address indexed account, uint principal, uint fee, uint amountIn);
}
