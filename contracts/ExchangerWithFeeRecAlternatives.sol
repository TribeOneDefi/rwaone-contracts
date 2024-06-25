pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;
// Inheritance
import "./Exchanger.sol";

// Internal references
import "./MinimalProxyFactory.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IDirectIntegrationManager.sol";
import "./interfaces/IERC20.sol";

interface IVirtualRwaInternal {
    function initialize(
        IERC20 _rwa,
        IAddressResolver _resolver,
        address _recipient,
        uint _amount,
        bytes32 _currencyKey
    ) external;
}

// https://docs.rwaone.io/contracts/source/contracts/exchangerwithfeereclamationalternatives
contract ExchangerWithFeeRecAlternatives is MinimalProxyFactory, Exchanger {
    bytes32 public constant CONTRACT_NAME = "ExchangerWithFeeRecAlternatives";

    using SafeMath for uint;

    struct ExchangeVolumeAtPeriod {
        uint64 time;
        uint192 volume;
    }

    ExchangeVolumeAtPeriod public lastAtomicVolume;

    constructor(address _owner, address _resolver) public MinimalProxyFactory() Exchanger(_owner, _resolver) {}

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_VIRTUALRWAONE_MASTERCOPY = "VirtualRwaMastercopy";

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = Exchanger.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_VIRTUALRWAONE_MASTERCOPY;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    /* ========== VIEWS ========== */

    function atomicMaxVolumePerBlock() external view returns (uint) {
        return getAtomicMaxVolumePerBlock();
    }

    function feeRateForAtomicExchange(
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey
    ) external view returns (uint exchangeFeeRate) {
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings = _exchangeSettings(
            msg.sender,
            sourceCurrencyKey
        );
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings = _exchangeSettings(
            msg.sender,
            destinationCurrencyKey
        );
        exchangeFeeRate = _feeRateForAtomicExchange(sourceSettings, destinationSettings);
    }

    function getAmountsForAtomicExchange(
        uint sourceAmount,
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey
    ) external view returns (uint amountReceived, uint fee, uint exchangeFeeRate) {
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings = _exchangeSettings(
            msg.sender,
            sourceCurrencyKey
        );
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings = _exchangeSettings(
            msg.sender,
            destinationCurrencyKey
        );
        IDirectIntegrationManager.ParameterIntegrationSettings memory usdSettings = _exchangeSettings(msg.sender, rUSD);

        (amountReceived, fee, exchangeFeeRate, , , ) = _getAmountsForAtomicExchangeMinusFees(
            sourceAmount,
            sourceSettings,
            destinationSettings,
            usdSettings
        );
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function exchangeAtomically(
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address destinationAddress,
        bytes32 trackingCode,
        uint minAmount
    ) external onlyRwaoneorRwa returns (uint amountReceived) {
        uint fee;
        (amountReceived, fee) = _exchangeAtomically(
            from,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            destinationAddress
        );

        require(amountReceived >= minAmount, "The amount received is below the minimum amount specified.");

        _processTradingRewards(fee, destinationAddress);

        if (trackingCode != bytes32(0)) {
            _emitTrackingEvent(trackingCode, destinationCurrencyKey, amountReceived, fee);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _virtualRwaMastercopy() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_VIRTUALRWAONE_MASTERCOPY);
    }

    function _createVirtualRwa(
        IERC20 rwa,
        address recipient,
        uint amount,
        bytes32 currencyKey
    ) internal returns (IVirtualRwa) {
        // prevent inverse rwas from being allowed due to purgeability
        require(currencyKey[0] != 0x69, "Cannot virtualize this rwa");

        IVirtualRwaInternal vRwa = IVirtualRwaInternal(
            _cloneAsMinimalProxy(_virtualRwaMastercopy(), "Could not create new vRwa")
        );
        vRwa.initialize(rwa, resolver, recipient, amount, currencyKey);
        emit VirtualRwaCreated(address(rwa), recipient, address(vRwa), currencyKey, amount);

        return IVirtualRwa(address(vRwa));
    }

    function _exchangeAtomically(
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address destinationAddress
    ) internal returns (uint amountReceived, uint fee) {
        uint sourceAmountAfterSettlement;
        uint exchangeFeeRate;
        uint systemSourceRate;
        uint systemDestinationRate;

        {
            IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings = _exchangeSettings(
                from,
                sourceCurrencyKey
            );
            IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings = _exchangeSettings(
                from,
                destinationCurrencyKey
            );

            if (!_ensureCanExchange(sourceCurrencyKey, destinationCurrencyKey, sourceAmount)) {
                return (0, 0);
            }
            require(!exchangeRates().rwaTooVolatileForAtomicExchange(sourceSettings), "Src rwa too volatile");
            require(!exchangeRates().rwaTooVolatileForAtomicExchange(destinationSettings), "Dest rwa too volatile");

            sourceAmountAfterSettlement = _settleAndCalcSourceAmountRemaining(sourceAmount, from, sourceCurrencyKey);

            // If, after settlement the user has no balance left (highly unlikely), then return to prevent
            // emitting events of 0 and don't revert so as to ensure the settlement queue is emptied
            if (sourceAmountAfterSettlement == 0) {
                return (0, 0);
            }

            // sometimes we need parameters for USD and USD has parameters which could be overridden
            IDirectIntegrationManager.ParameterIntegrationSettings memory usdSettings = _exchangeSettings(from, rUSD);

            uint systemConvertedAmount;

            // Note: also ensures the given rwas are allowed to be atomically exchanged
            (
                amountReceived, // output amount with fee taken out (denominated in dest currency)
                fee, // fee amount (denominated in dest currency)
                exchangeFeeRate, // applied fee rate
                systemConvertedAmount, // current system value without fees (denominated in dest currency)
                systemSourceRate, // current system rate for src currency
                systemDestinationRate // current system rate for dest currency
            ) = _getAmountsForAtomicExchangeMinusFees(
                sourceAmountAfterSettlement,
                sourceSettings,
                destinationSettings,
                usdSettings
            );

            // Sanity check atomic output's value against current system value (checking atomic rates)
            require(
                !circuitBreaker().isDeviationAboveThreshold(systemConvertedAmount, amountReceived.add(fee)),
                "Atomic rate deviates too much"
            );

            // Determine rUSD value of exchange
            uint sourceSusdValue;
            if (sourceCurrencyKey == rUSD) {
                // Use after-settled amount as this is amount converted (not sourceAmount)
                sourceSusdValue = sourceAmountAfterSettlement;
            } else if (destinationCurrencyKey == rUSD) {
                // In this case the systemConvertedAmount would be the fee-free rUSD value of the source rwa
                sourceSusdValue = systemConvertedAmount;
            } else {
                // Otherwise, convert source to rUSD value
                (uint amountReceivedInUSD, uint sUsdFee, , , , ) = _getAmountsForAtomicExchangeMinusFees(
                    sourceAmountAfterSettlement,
                    sourceSettings,
                    usdSettings,
                    usdSettings
                );
                sourceSusdValue = amountReceivedInUSD.add(sUsdFee);
            }

            // Check and update atomic volume limit
            _checkAndUpdateAtomicVolume(sourceSettings, sourceSusdValue);
        }

        // Note: We don't need to check their balance as the _convert() below will do a safe subtraction which requires
        // the subtraction to not overflow, which would happen if their balance is not sufficient.

        _convert(
            sourceCurrencyKey,
            from,
            sourceAmountAfterSettlement,
            destinationCurrencyKey,
            amountReceived,
            destinationAddress,
            false // no vrwas
        );

        // Remit the fee if required
        if (fee > 0) {
            // Normalize fee to rUSD
            // Note: `fee` is being reused to avoid stack too deep errors.
            fee = exchangeRates().effectiveValue(destinationCurrencyKey, fee, rUSD);

            // Remit the fee in rUSDs
            issuer().rwas(rUSD).issue(feePool().FEE_ADDRESS(), fee);

            // Tell the fee pool about this
            feePool().recordFeePaid(fee);
        }

        // Note: As of this point, `fee` is denominated in rUSD.

        // Note: this update of the debt snapshot will not be accurate because the atomic exchange
        // was executed with a different rate than the system rate. To be perfect, issuance data,
        // priced in system rates, should have been adjusted on the src and dest rwa.
        // The debt pool is expected to be deprecated soon, and so we don't bother with being
        // perfect here. For now, an inaccuracy will slowly accrue over time with increasing atomic
        // exchange volume.
        _updateRWAXIssuedDebtOnExchange(
            [sourceCurrencyKey, destinationCurrencyKey],
            [systemSourceRate, systemDestinationRate]
        );

        // Let the DApps know there was a Rwa exchange
        IRwaoneInternal(address(rwaone())).emitRwaExchange(
            from,
            sourceCurrencyKey,
            sourceAmountAfterSettlement,
            destinationCurrencyKey,
            amountReceived,
            destinationAddress
        );

        // Emit separate event to track atomic exchanges
        IRwaoneInternal(address(rwaone())).emitAtomicRwaExchange(
            from,
            sourceCurrencyKey,
            sourceAmountAfterSettlement,
            destinationCurrencyKey,
            amountReceived,
            destinationAddress
        );

        // No need to persist any exchange information, as no settlement is required for atomic exchanges
    }

    function _checkAndUpdateAtomicVolume(
        IDirectIntegrationManager.ParameterIntegrationSettings memory settings,
        uint sourceSusdValue
    ) internal {
        uint currentVolume = uint(lastAtomicVolume.time) == block.timestamp
            ? uint(lastAtomicVolume.volume).add(sourceSusdValue)
            : sourceSusdValue;
        require(currentVolume <= settings.atomicMaxVolumePerBlock, "Surpassed volume limit");
        lastAtomicVolume.time = uint64(block.timestamp);
        lastAtomicVolume.volume = uint192(currentVolume); // Protected by volume limit check above
    }

    function _feeRateForAtomicExchange(
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings
    ) internal view returns (uint) {
        // Get the exchange fee rate as per source and destination currencyKey
        uint baseRate = sourceSettings.atomicExchangeFeeRate.add(destinationSettings.atomicExchangeFeeRate);
        if (baseRate == 0) {
            // If no atomic rate was set, fallback to the regular exchange rate
            baseRate = sourceSettings.exchangeFeeRate.add(destinationSettings.exchangeFeeRate);
        }

        return baseRate;
    }

    function _getAmountsForAtomicExchangeMinusFees(
        uint sourceAmount,
        IDirectIntegrationManager.ParameterIntegrationSettings memory sourceSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory destinationSettings,
        IDirectIntegrationManager.ParameterIntegrationSettings memory usdSettings
    )
        internal
        view
        returns (
            uint amountReceived,
            uint fee,
            uint exchangeFeeRate,
            uint systemConvertedAmount,
            uint systemSourceRate,
            uint systemDestinationRate
        )
    {
        uint destinationAmount;
        (destinationAmount, systemConvertedAmount, systemSourceRate, systemDestinationRate) = exchangeRates()
            .effectiveAtomicValueAndRates(sourceSettings, sourceAmount, destinationSettings, usdSettings);

        exchangeFeeRate = _feeRateForAtomicExchange(sourceSettings, destinationSettings);
        amountReceived = ExchangeSettlementLib._deductFeesFromAmount(destinationAmount, exchangeFeeRate);
        fee = destinationAmount.sub(amountReceived);
    }

    event VirtualRwaCreated(address indexed rwa, address indexed recipient, address vRwa, bytes32 currencyKey, uint amount);
}
