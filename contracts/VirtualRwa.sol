pragma solidity ^0.5.16;

// Inheritance
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IRwa.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IVirtualRwa.sol";
import "./interfaces/IExchanger.sol";

// https://docs.rwaone.io/contracts/source/contracts/virtualrwa
// Note: this contract should be treated as an abstract contract and should not be directly deployed.
//       On higher versions of solidity, it would be marked with the `abstract` keyword.
//       This contracts implements logic that is only intended to be accessed behind a proxy.
//       For the deployed "mastercopy" version, see VirtualRwaMastercopy.
contract VirtualRwa is ERC20, IVirtualRwa {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    IERC20 public rwa;
    IAddressResolver public resolver;

    bool public settled = false;

    uint8 public constant decimals = 18;

    // track initial supply so we can calculate the rate even after all supply is burned
    uint public initialSupply;

    // track final settled amount of the rwa so we can calculate the rate after settlement
    uint public settledAmount;

    bytes32 public currencyKey;

    bool public initialized = false;

    function initialize(
        IERC20 _rwa,
        IAddressResolver _resolver,
        address _recipient,
        uint _amount,
        bytes32 _currencyKey
    ) external {
        require(!initialized, "vRwa already initialized");
        initialized = true;

        rwa = _rwa;
        resolver = _resolver;
        currencyKey = _currencyKey;

        // Assumption: the rwa will be issued to us within the same transaction,
        // and this supply matches that
        _mint(_recipient, _amount);

        initialSupply = _amount;

        // Note: the ERC20 base contract does not have a constructor, so we do not have to worry
        // about initializing its state separately
    }

    // INTERNALS

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress("Exchanger", "Exchanger contract not found"));
    }

    function secsLeft() internal view returns (uint) {
        return exchanger().maxSecsLeftInWaitingPeriod(address(this), currencyKey);
    }

    function calcRate() internal view returns (uint) {
        if (initialSupply == 0) {
            return 0;
        }

        uint rwaBalance;

        if (!settled) {
            rwaBalance = IERC20(address(rwa)).balanceOf(address(this));
            (uint reclaim, uint rebate, ) = exchanger().settlementOwing(address(this), currencyKey);

            if (reclaim > 0) {
                rwaBalance = rwaBalance.sub(reclaim);
            } else if (rebate > 0) {
                rwaBalance = rwaBalance.add(rebate);
            }
        } else {
            rwaBalance = settledAmount;
        }

        return rwaBalance.divideDecimalRound(initialSupply);
    }

    function balanceUnderlying(address account) internal view returns (uint) {
        uint vBalanceOfAccount = balanceOf(account);

        return vBalanceOfAccount.multiplyDecimalRound(calcRate());
    }

    function settleRwa() internal {
        if (settled) {
            return;
        }
        settled = true;

        exchanger().settle(address(this), currencyKey);

        settledAmount = IERC20(address(rwa)).balanceOf(address(this));

        emit Settled(totalSupply(), settledAmount);
    }

    // VIEWS

    function name() external view returns (string memory) {
        return string(abi.encodePacked("Virtual Rwa ", currencyKey));
    }

    function symbol() external view returns (string memory) {
        return string(abi.encodePacked("v", currencyKey));
    }

    // get the rate of the vRwa to the rwa.
    function rate() external view returns (uint) {
        return calcRate();
    }

    // show the balance of the underlying rwa that the given address has, given
    // their proportion of totalSupply
    function balanceOfUnderlying(address account) external view returns (uint) {
        return balanceUnderlying(account);
    }

    function secsLeftInWaitingPeriod() external view returns (uint) {
        return secsLeft();
    }

    function readyToSettle() external view returns (bool) {
        return secsLeft() == 0;
    }

    // PUBLIC FUNCTIONS

    // Perform settlement of the underlying exchange if required,
    // then burn the accounts vRwas and transfer them their owed balanceOfUnderlying
    function settle(address account) external {
        settleRwa();

        IERC20(address(rwa)).transfer(account, balanceUnderlying(account));

        _burn(account, balanceOf(account));
    }

    event Settled(uint totalSupply, uint amountAfterSettled);
}
