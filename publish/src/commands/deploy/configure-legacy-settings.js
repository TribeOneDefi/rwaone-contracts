'use strict';

const { gray } = require('chalk');
const { toBytes32 } = require('../../../..');

module.exports = async ({
	account,
	addressOf,
	config,
	deployer,
	getDeployParameter,
	network,
	runStep,
	useOvm,
}) => {
	console.log(gray(`\n------ CONFIGURE LEGACY CONTRACTS VIA SETTERS ------\n`));

	const {
		DelegateApprovals,
		DelegateApprovalsEternalStorage,
		Exchanger,
		ExchangeState,
		ExchangeCircuitBreaker,
		FeePool,
		FeePoolEternalStorage,
		Issuer,
		ProxyFeePool,
		ProxyRwaone,
		RewardEscrow,
		RewardsDistribution,
		SupplySchedule,
		Rwaone,
		RwaoneEscrow,
		SystemStatus,
		TokenStateRwaone,
	} = deployer.deployedContracts;

	// now configure everything
	if (network !== 'mainnet' && SystemStatus) {
		// On testnet, give the owner of SystemStatus the rights to update status
		const statusOwner = await SystemStatus.owner();
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('System'), statusOwner],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControls',
			writeArg: [
				['System', 'Issuance', 'Exchange', 'RwaExchange', 'Rwa', 'Futures'].map(toBytes32),
				[statusOwner, statusOwner, statusOwner, statusOwner, statusOwner, statusOwner],
				[true, true, true, true, true, true],
				[true, true, true, true, true, true],
			],
			comment: 'Ensure the owner can suspend and resume the protocol',
		});
	}
	if (DelegateApprovals && DelegateApprovalsEternalStorage) {
		await runStep({
			contract: 'DelegateApprovalsEternalStorage',
			target: DelegateApprovalsEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(DelegateApprovals),
			write: 'setAssociatedContract',
			writeArg: addressOf(DelegateApprovals),
			comment: 'Ensure that DelegateApprovals contract is allowed to write to its EternalStorage',
		});
	}

	if (ProxyFeePool && FeePool) {
		await runStep({
			contract: 'ProxyFeePool',
			target: ProxyFeePool,
			read: 'target',
			expected: input => input === addressOf(FeePool),
			write: 'setTarget',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the ProxyFeePool contract has the correct FeePool target set',
		});
	}

	if (FeePoolEternalStorage && FeePool) {
		await runStep({
			contract: 'FeePoolEternalStorage',
			target: FeePoolEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(FeePool),
			write: 'setAssociatedContract',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the FeePool contract can write to its EternalStorage',
		});
	}

	if (ProxyRwaone && Rwaone) {
		await runStep({
			contract: 'ProxyRwaone',
			target: ProxyRwaone,
			read: 'target',
			expected: input => input === addressOf(Rwaone),
			write: 'setTarget',
			writeArg: addressOf(Rwaone),
			comment: 'Ensure the wRWAX proxy has the correct Rwaone target set',
		});
		await runStep({
			contract: 'Rwaone',
			target: Rwaone,
			read: 'proxy',
			expected: input => input === addressOf(ProxyRwaone),
			write: 'setProxy',
			writeArg: addressOf(ProxyRwaone),
			comment: 'Ensure the Rwaone contract has the correct ERC20 proxy set',
		});
	}

	if (Exchanger && ExchangeState) {
		// The ExchangeState contract has Exchanger as it's associated contract
		await runStep({
			contract: 'ExchangeState',
			target: ExchangeState,
			read: 'associatedContract',
			expected: input => input === Exchanger.address,
			write: 'setAssociatedContract',
			writeArg: Exchanger.address,
			comment: 'Ensure the Exchanger contract can write to its State',
		});
	}

	if (ExchangeCircuitBreaker && SystemStatus) {
		// SIP-65: ensure Exchanger can suspend rwas if price spikes occur
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('Rwa'), addressOf(ExchangeCircuitBreaker)],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControl',
			writeArg: [toBytes32('Rwa'), addressOf(ExchangeCircuitBreaker), true, false],
			comment: 'Ensure the ExchangeCircuitBreaker contract can suspend rwas - see SIP-65',
		});
	}

	if (Issuer && SystemStatus) {
		// SIP-165: ensure Issuer can suspend issuance if unusual volitility occurs
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('Issuance'), addressOf(Issuer)],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControl',
			writeArg: [toBytes32('Issuance'), addressOf(Issuer), true, false],
			comment: 'Ensure Issuer contract can suspend issuance - see SIP-165',
		});
	}

	// only reset token state if redeploying
	if (TokenStateRwaone && config['TokenStateRwaone'].deploy) {
		const initialIssuance = await getDeployParameter('INITIAL_ISSUANCE');
		await runStep({
			contract: 'TokenStateRwaone',
			target: TokenStateRwaone,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
			comment:
				'Ensure the TokenStateRwaone contract has the correct initial issuance (WARNING: only for new deploys)',
		});
	}

	if (TokenStateRwaone && Rwaone) {
		await runStep({
			contract: 'TokenStateRwaone',
			target: TokenStateRwaone,
			read: 'associatedContract',
			expected: input => input === addressOf(Rwaone),
			write: 'setAssociatedContract',
			writeArg: addressOf(Rwaone),
			comment: 'Ensure the Rwaone contract can write to its TokenState contract',
		});
	}

	if (RewardEscrow && Rwaone) {
		await runStep({
			contract: 'RewardEscrow',
			target: RewardEscrow,
			read: 'rwaone',
			expected: input => input === addressOf(Rwaone),
			write: 'setRwaone',
			writeArg: addressOf(Rwaone),
			comment: 'Ensure the legacy RewardEscrow contract is connected to the Rwaone contract',
		});
	}

	if (RewardEscrow && FeePool) {
		await runStep({
			contract: 'RewardEscrow',
			target: RewardEscrow,
			read: 'feePool',
			expected: input => input === addressOf(FeePool),
			write: 'setFeePool',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the legacy RewardEscrow contract is connected to the FeePool contract',
		});
	}

	if (SupplySchedule && Rwaone) {
		await runStep({
			contract: 'SupplySchedule',
			target: SupplySchedule,
			read: 'rwaoneProxy',
			expected: input => input === addressOf(ProxyRwaone),
			write: 'setRwaoneProxy',
			writeArg: addressOf(ProxyRwaone),
			comment: 'Ensure the SupplySchedule is connected to the wRWAX proxy for reading',
		});
	}

	if (Rwaone && RewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'authority',
			expected: input => input === addressOf(Rwaone),
			write: 'setAuthority',
			writeArg: addressOf(Rwaone),
			comment: 'Ensure the RewardsDistribution has Rwaone set as its authority for distribution',
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'rwaoneProxy',
			expected: input => input === addressOf(ProxyRwaone),
			write: 'setRwaoneProxy',
			writeArg: addressOf(ProxyRwaone),
			comment: 'Ensure the RewardsDistribution can find the Rwaone proxy to read and transfer',
		});
	}

	// ----------------
	// Setting ProxyRwaone Rwaone for RwaoneEscrow
	// ----------------

	// Skip setting unless redeploying either of these,
	if (config['Rwaone'].deploy || config['RwaoneEscrow'].deploy) {
		// Note: currently on mainnet RwaoneEscrow.Rwaone() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		if (network === 'mainnet' && !useOvm) {
			await runStep({
				contract: 'RwaoneEscrow',
				target: RwaoneEscrow,
				read: 'havven',
				expected: input => input === addressOf(ProxyRwaone),
				write: 'setHavven',
				writeArg: addressOf(ProxyRwaone),
				comment:
					'Ensure the legacy token sale escrow can find the Rwaone proxy to read and transfer',
			});
		} else {
			await runStep({
				contract: 'RwaoneEscrow',
				target: RwaoneEscrow,
				read: 'rwaone',
				expected: input => input === addressOf(ProxyRwaone),
				write: 'setRwaone',
				writeArg: addressOf(ProxyRwaone),
				comment: 'Ensure the token sale escrow can find the Rwaone proxy to read and transfer',
			});
		}
	}
};
