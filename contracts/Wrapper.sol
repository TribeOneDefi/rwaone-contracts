pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IWrapper.sol";
import "./interfaces/IRwa.sol";
import "./interfaces/IERC20.sol";

// Internal references
import "./Pausable.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IDebtCache.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IWrapperFactory.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";

// Libraries
import "./SafeDecimalMath.sol";

// https://docs.rwaone.io/contracts/source/contracts/wrapper
contract Wrapper is Owned, Pausable, MixinResolver, MixinSystemSettings, IWrapper {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    /* ========== ENCODED NAMES ========== */

    bytes32 internal constant rUSD = "rUSD";

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_RWAONE_RUSD = "RwarUSD";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_DEBTCACHE = "DebtCache";
    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_WRAPPERFACTORY = "WrapperFactory";

    // ========== STATE VARIABLES ==========

    // NOTE: these values should ideally be `immutable` instead of public
    IERC20 public token;
    bytes32 public currencyKey;
    bytes32 public rwaContractName;

    uint public targetRwaIssued;

    constructor(
        address _owner,
        address _resolver,
        IERC20 _token,
        bytes32 _currencyKey,
        bytes32 _rwaContractName
    ) public Owned(_owner) MixinSystemSettings(_resolver) {
        token = _token;
        currencyKey = _currencyKey;
        rwaContractName = _rwaContractName;
        targetRwaIssued = 0;
        token.approve(address(this), uint256(-1));
    }

    /* ========== VIEWS ========== */
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](6);
        newAddresses[0] = CONTRACT_RWAONE_RUSD;
        newAddresses[1] = rwaContractName;
        newAddresses[2] = CONTRACT_EXRATES;
        newAddresses[3] = CONTRACT_DEBTCACHE;
        newAddresses[4] = CONTRACT_SYSTEMSTATUS;
        newAddresses[5] = CONTRACT_WRAPPERFACTORY;
        addresses = combineArrays(existingAddresses, newAddresses);
        return addresses;
    }

    /* ========== INTERNAL VIEWS ========== */
    function rwarUSD() internal view returns (IRwa) {
        return IRwa(requireAndGetAddress(CONTRACT_RWAONE_RUSD));
    }

    function rwa() internal view returns (IRwa) {
        return IRwa(requireAndGetAddress(rwaContractName));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(requireAndGetAddress(CONTRACT_EXRATES));
    }

    function debtCache() internal view returns (IDebtCache) {
        return IDebtCache(requireAndGetAddress(CONTRACT_DEBTCACHE));
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    function wrapperFactory() internal view returns (IWrapperFactory) {
        return IWrapperFactory(requireAndGetAddress(CONTRACT_WRAPPERFACTORY));
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    // ========== VIEWS ==========

    function capacity() public view returns (uint _capacity) {
        // capacity = max(maxETH - balance, 0)
        uint balance = getReserves();
        uint maxToken = maxTokenAmount();
        if (balance >= maxToken) {
            return 0;
        }
        return maxToken.sub(balance);
    }

    function totalIssuedRwas() public view returns (uint) {
        // rwas issued by this contract is always exactly equal to the balance of reserves
        return exchangeRates().effectiveValue(currencyKey, targetRwaIssued, rUSD);
    }

    function getReserves() public view returns (uint) {
        return token.balanceOf(address(this));
    }

    function calculateMintFee(uint amount) public view returns (uint, bool) {
        int r = mintFeeRate();

        if (r < 0) {
            return (amount.multiplyDecimalRound(uint(-r)), true);
        } else {
            return (amount.multiplyDecimalRound(uint(r)), false);
        }
    }

    function calculateBurnFee(uint amount) public view returns (uint, bool) {
        int r = burnFeeRate();

        if (r < 0) {
            return (amount.multiplyDecimalRound(uint(-r)), true);
        } else {
            return (amount.multiplyDecimalRound(uint(r)), false);
        }
    }

    function maxTokenAmount() public view returns (uint256) {
        return getWrapperMaxTokenAmount(address(this));
    }

    function mintFeeRate() public view returns (int256) {
        return getWrapperMintFeeRate(address(this));
    }

    function burnFeeRate() public view returns (int256) {
        return getWrapperBurnFeeRate(address(this));
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    // Transfers `amountIn` token to mint `amountIn - fees` of currencyKey.
    // `amountIn` is inclusive of fees, calculable via `calculateMintFee`.
    function mint(uint amountIn) external notPaused issuanceActive {
        require(amountIn <= token.allowance(msg.sender, address(this)), "Allowance not high enough");
        require(amountIn <= token.balanceOf(msg.sender), "Balance is too low");
        require(!exchangeRates().rateIsInvalid(currencyKey), "Currency rate is invalid");

        uint currentCapacity = capacity();
        require(currentCapacity > 0, "Contract has no spare capacity to mint");

        uint actualAmountIn = currentCapacity < amountIn ? currentCapacity : amountIn;

        (uint feeAmountTarget, bool negative) = calculateMintFee(actualAmountIn);
        uint mintAmount = negative ? actualAmountIn.add(feeAmountTarget) : actualAmountIn.sub(feeAmountTarget);

        // Transfer token from user.
        bool success = _safeTransferFrom(address(token), msg.sender, address(this), actualAmountIn);
        require(success, "Transfer did not succeed");

        // Mint tokens to user
        _mint(mintAmount);

        emit Minted(msg.sender, mintAmount, negative ? 0 : feeAmountTarget, actualAmountIn);
    }

    // Burns `amountIn` rwa for `amountIn - fees` amount of token.
    // `amountIn` is inclusive of fees, calculable via `calculateBurnFee`.
    function burn(uint amountIn) external notPaused issuanceActive {
        require(amountIn <= IERC20(address(rwa())).balanceOf(msg.sender), "Balance is too low");
        require(!exchangeRates().rateIsInvalid(currencyKey), "Currency rate is invalid");
        require(totalIssuedRwas() > 0, "Contract cannot burn for token, token balance is zero");

        (uint burnFee, bool negative) = calculateBurnFee(targetRwaIssued);

        uint burnAmount;
        uint amountOut;
        if (negative) {
            burnAmount = targetRwaIssued < amountIn ? targetRwaIssued.sub(burnFee) : amountIn;

            amountOut = burnAmount.multiplyDecimal(
                // -1e18 <= burnFeeRate <= 1e18 so this operation is safe
                uint(int(SafeDecimalMath.unit()) - burnFeeRate())
            );
        } else {
            burnAmount = targetRwaIssued.add(burnFee) < amountIn ? targetRwaIssued.add(burnFee) : amountIn;
            amountOut = burnAmount.divideDecimal(
                // -1e18 <= burnFeeRate <= 1e18 so this operation is safe
                uint(int(SafeDecimalMath.unit()) + burnFeeRate())
            );
        }

        uint feeAmountTarget = negative ? 0 : burnAmount.sub(amountOut);

        // Transfer token to user.
        bool success = _safeTransferFrom(address(token), address(this), msg.sender, amountOut);
        require(success, "Transfer did not succeed");

        // Burn
        _burn(burnAmount);

        emit Burned(msg.sender, amountOut, feeAmountTarget, burnAmount);
    }

    // ========== RESTRICTED ==========

    /**
     * @notice Fallback function
     */
    function() external payable {
        revert("Fallback disabled, use mint()");
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _mint(uint amount) internal {
        uint reserves = getReserves();

        uint excessAmount = reserves > targetRwaIssued.add(amount) ? reserves.sub(targetRwaIssued.add(amount)) : 0;
        uint excessAmountUsd = exchangeRates().effectiveValue(currencyKey, excessAmount, rUSD);

        // Mint `amount` to user.
        rwa().issue(msg.sender, amount);

        // Escrow fee.
        if (excessAmountUsd > 0) {
            rwarUSD().issue(address(wrapperFactory()), excessAmountUsd);
        }

        // in the case of a negative fee extra rwas will be issued, billed to the snx stakers
        _setTargetRwaIssued(reserves);
    }

    function _burn(uint amount) internal {
        uint reserves = getReserves();

        // this is logically equivalent to getReserves() - (targetRwaIssued - amount), without going negative
        uint excessAmount = reserves.add(amount) > targetRwaIssued ? reserves.add(amount).sub(targetRwaIssued) : 0;

        uint excessAmountUsd = exchangeRates().effectiveValue(currencyKey, excessAmount, rUSD);

        // Burn `amount` of currencyKey from user.
        rwa().burn(msg.sender, amount);

        // We use burn/issue instead of burning the principal and transferring the fee.
        // This saves an approval and is cheaper.
        // Escrow fee.
        if (excessAmountUsd > 0) {
            rwarUSD().issue(address(wrapperFactory()), excessAmountUsd);
        }

        // in the case of a negative fee fewer rwas will be burned, billed to the snx stakers
        _setTargetRwaIssued(reserves);
    }

    function _setTargetRwaIssued(uint _targetRwaIssued) internal {
        debtCache().recordExcludedDebtChange(currencyKey, int256(_targetRwaIssued) - int256(targetRwaIssued));

        targetRwaIssued = _targetRwaIssued;
    }

    function _safeTransferFrom(
        address _tokenAddress,
        address _from,
        address _to,
        uint256 _value
    ) internal returns (bool success) {
        // note: both of these could be replaced with manual mstore's to reduce cost if desired
        bytes memory msgData = abi.encodeWithSignature("transferFrom(address,address,uint256)", _from, _to, _value);
        uint msgSize = msgData.length;

        assembly {
            // pre-set scratch space to all bits set
            mstore(0x00, 0xff)

            // note: this requires tangerine whistle compatible EVM
            if iszero(call(gas(), _tokenAddress, 0, add(msgData, 0x20), msgSize, 0x00, 0x20)) {
                revert(0, 0)
            }

            switch mload(0x00)
            case 0xff {
                // token is not fully ERC20 compatible, didn't return anything, assume it was successful
                success := 1
            }
            case 0x01 {
                success := 1
            }
            case 0x00 {
                success := 0
            }
            default {
                // unexpected value, what could this be?
                revert(0, 0)
            }
        }
    }

    modifier issuanceActive() {
        systemStatus().requireIssuanceActive();
        _;
    }

    /* ========== EVENTS ========== */
    event Minted(address indexed account, uint principal, uint fee, uint amountIn);
    event Burned(address indexed account, uint principal, uint fee, uint amountIn);
}
