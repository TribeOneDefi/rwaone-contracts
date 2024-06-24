pragma solidity >=0.4.24;

import "../interfaces/ITribe.sol";

// https://docs.rwaone.io/contracts/source/interfaces/iissuer
interface IIssuer {
    // Views

    function allNetworksDebtInfo() external view returns (uint256 debt, uint256 sharesSupply, bool isStale);

    function anyTribeOrRWAXRateIsInvalid() external view returns (bool anyRateInvalid);

    function availableCurrencyKeys() external view returns (bytes32[] memory);

    function availableTribeCount() external view returns (uint);

    function availableTribes(uint index) external view returns (ITribe);

    function canBurnTribes(address account) external view returns (bool);

    function collateral(address account) external view returns (uint);

    function collateralisationRatio(address issuer) external view returns (uint);

    function collateralisationRatioAndAnyRatesInvalid(
        address _issuer
    ) external view returns (uint cratio, bool anyRateIsInvalid);

    function debtBalanceOf(address issuer, bytes32 currencyKey) external view returns (uint debtBalance);

    function issuanceRatio() external view returns (uint);

    function lastIssueEvent(address account) external view returns (uint);

    function maxIssuableTribes(address issuer) external view returns (uint maxIssuable);

    function minimumStakeTime() external view returns (uint);

    function remainingIssuableTribes(
        address issuer
    ) external view returns (uint maxIssuable, uint alreadyIssued, uint totalSystemDebt);

    function tribes(bytes32 currencyKey) external view returns (ITribe);

    function getTribes(bytes32[] calldata currencyKeys) external view returns (ITribe[] memory);

    function tribesByAddress(address tribeAddress) external view returns (bytes32);

    function totalIssuedTribes(bytes32 currencyKey, bool excludeOtherCollateral) external view returns (uint);

    function transferableRwaoneAndAnyRateIsInvalid(
        address account,
        uint balance
    ) external view returns (uint transferable, bool anyRateIsInvalid);

    function liquidationAmounts(
        address account,
        bool isSelfLiquidation
    ) external view returns (uint totalRedeemed, uint debtToRemove, uint escrowToLiquidate, uint initialDebtBalance);

    // Restricted: used internally to Rwaone
    function addTribes(ITribe[] calldata tribesToAdd) external;

    function issueTribes(address from, uint amount) external;

    function issueTribesOnBehalf(address issueFor, address from, uint amount) external;

    function issueMaxTribes(address from) external;

    function issueMaxTribesOnBehalf(address issueFor, address from) external;

    function burnTribes(address from, uint amount) external;

    function burnTribesOnBehalf(address burnForAddress, address from, uint amount) external;

    function burnTribesToTarget(address from) external;

    function burnTribesToTargetOnBehalf(address burnForAddress, address from) external;

    function burnForRedemption(address deprecatedTribeProxy, address account, uint balance) external;

    function setCurrentPeriodId(uint128 periodId) external;

    function liquidateAccount(
        address account,
        bool isSelfLiquidation
    ) external returns (uint totalRedeemed, uint debtRemoved, uint escrowToLiquidate);

    function issueTribesWithoutDebt(bytes32 currencyKey, address to, uint amount) external returns (bool rateInvalid);

    function burnTribesWithoutDebt(bytes32 currencyKey, address to, uint amount) external returns (bool rateInvalid);

    function modifyDebtSharesForMigration(address account, uint amount) external;
}
