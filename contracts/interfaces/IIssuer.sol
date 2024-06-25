pragma solidity >=0.4.24;

import "../interfaces/IRwa.sol";

// https://docs.rwaone.io/contracts/source/interfaces/iissuer
interface IIssuer {
    // Views

    function allNetworksDebtInfo() external view returns (uint256 debt, uint256 sharesSupply, bool isStale);

    function anyRwaOrRWAXRateIsInvalid() external view returns (bool anyRateInvalid);

    function availableCurrencyKeys() external view returns (bytes32[] memory);

    function availableRwaCount() external view returns (uint);

    function availableRwas(uint index) external view returns (IRwa);

    function canBurnRwas(address account) external view returns (bool);

    function collateral(address account) external view returns (uint);

    function collateralisationRatio(address issuer) external view returns (uint);

    function collateralisationRatioAndAnyRatesInvalid(
        address _issuer
    ) external view returns (uint cratio, bool anyRateIsInvalid);

    function debtBalanceOf(address issuer, bytes32 currencyKey) external view returns (uint debtBalance);

    function issuanceRatio() external view returns (uint);

    function lastIssueEvent(address account) external view returns (uint);

    function maxIssuableRwas(address issuer) external view returns (uint maxIssuable);

    function minimumStakeTime() external view returns (uint);

    function remainingIssuableRwas(
        address issuer
    ) external view returns (uint maxIssuable, uint alreadyIssued, uint totalSystemDebt);

    function rwas(bytes32 currencyKey) external view returns (IRwa);

    function getRwas(bytes32[] calldata currencyKeys) external view returns (IRwa[] memory);

    function rwasByAddress(address rwaAddress) external view returns (bytes32);

    function totalIssuedRwas(bytes32 currencyKey, bool excludeOtherCollateral) external view returns (uint);

    function transferableRwaoneAndAnyRateIsInvalid(
        address account,
        uint balance
    ) external view returns (uint transferable, bool anyRateIsInvalid);

    function liquidationAmounts(
        address account,
        bool isSelfLiquidation
    ) external view returns (uint totalRedeemed, uint debtToRemove, uint escrowToLiquidate, uint initialDebtBalance);

    // Restricted: used internally to Rwaone
    function addRwas(IRwa[] calldata rwasToAdd) external;

    function issueRwas(address from, uint amount) external;

    function issueRwasOnBehalf(address issueFor, address from, uint amount) external;

    function issueMaxRwas(address from) external;

    function issueMaxRwasOnBehalf(address issueFor, address from) external;

    function burnRwas(address from, uint amount) external;

    function burnRwasOnBehalf(address burnForAddress, address from, uint amount) external;

    function burnRwasToTarget(address from) external;

    function burnRwasToTargetOnBehalf(address burnForAddress, address from) external;

    function burnForRedemption(address deprecatedRwaProxy, address account, uint balance) external;

    function setCurrentPeriodId(uint128 periodId) external;

    function liquidateAccount(
        address account,
        bool isSelfLiquidation
    ) external returns (uint totalRedeemed, uint debtRemoved, uint escrowToLiquidate);

    function issueRwasWithoutDebt(bytes32 currencyKey, address to, uint amount) external returns (bool rateInvalid);

    function burnRwasWithoutDebt(bytes32 currencyKey, address to, uint amount) external returns (bool rateInvalid);

    function modifyDebtSharesForMigration(address account, uint amount) external;
}
