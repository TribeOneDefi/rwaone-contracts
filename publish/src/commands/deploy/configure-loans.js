'use strict';

const { gray } = require('chalk');
const { toBytes32 } = require('../../../..');
const { allowZeroOrUpdateIfNonZero } = require('../../util.js');

module.exports = async ({
	addressOf,
	collateralManagerDefaults,
	deployer,
	getDeployParameter,
	runStep,
}) => {
	console.log(gray(`\n------ CONFIGURING MULTI COLLATERAL ------\n`));

	const {
		CollateralErc20,
		CollateralEth,
		CollateralShort,
		CollateralManager,
		CollateralManagerState,
	} = deployer.deployedContracts;

	if (CollateralManagerState && CollateralManager) {
		await runStep({
			contract: 'CollateralManagerState',
			target: CollateralManagerState,
			read: 'associatedContract',
			expected: input => input === addressOf(CollateralManager),
			write: 'setAssociatedContract',
			writeArg: addressOf(CollateralManager),
			comment: 'Ensure the CollateralManager contract can write to its state',
		});
	}

	if (CollateralManager) {
		const CollateralsArg = [CollateralShort, CollateralEth, CollateralErc20]
			.filter(contract => !!contract)
			.map(addressOf);

		await runStep({
			contract: 'CollateralManager',
			target: CollateralManager,
			read: 'hasAllCollaterals',
			readArg: [CollateralsArg],
			expected: input => input,
			write: 'addCollaterals',
			writeArg: [CollateralsArg],
			comment: 'Ensure the CollateralManager has all Collateral contracts added',
		});
	}
	if (CollateralEth && CollateralManager) {
		await runStep({
			contract: 'CollateralEth',
			target: CollateralEth,
			read: 'manager',
			expected: input => input === addressOf(CollateralManager),
			write: 'setManager',
			writeArg: addressOf(CollateralManager),
			comment: 'Ensure the CollateralEth is connected to the CollateralManager',
		});

		const CollateralEthTribes = (await getDeployParameter('COLLATERAL_ETH'))['TRIBES']; // COLLATERAL_ETH tribes - ['rUSD', 'rETH']
		await runStep({
			contract: 'CollateralEth',
			gasLimit: 1e6,
			target: CollateralEth,
			read: 'areTribesAndCurrenciesSet',
			readArg: [
				CollateralEthTribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralEthTribes.map(toBytes32),
			],
			expected: input => input,
			write: 'addTribes',
			writeArg: [
				CollateralEthTribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralEthTribes.map(toBytes32),
			],
			comment: 'Ensure the CollateralEth contract has all associated tribes added',
		});

		const issueFeeRate = (await getDeployParameter('COLLATERAL_ETH'))['ISSUE_FEE_RATE'];
		await runStep({
			contract: 'CollateralEth',
			target: CollateralEth,
			read: 'issueFeeRate',
			expected: allowZeroOrUpdateIfNonZero(issueFeeRate),
			write: 'setIssueFeeRate',
			writeArg: [issueFeeRate],
			comment: 'Ensure the CollateralEth contract has its issue fee rate set',
		});
	}

	if (CollateralErc20 && CollateralManager) {
		await runStep({
			contract: 'CollateralErc20',
			target: CollateralErc20,
			read: 'manager',
			expected: input => input === addressOf(CollateralManager),
			write: 'setManager',
			writeArg: addressOf(CollateralManager),
			comment: 'Ensure the CollateralErc20 contract is connected to the CollateralManager',
		});

		const CollateralErc20Tribes = (await getDeployParameter('COLLATERAL_RENBTC'))['TRIBES']; // COLLATERAL_RENBTC tribes - ['rUSD', 'hBTC']
		await runStep({
			contract: 'CollateralErc20',
			gasLimit: 1e6,
			target: CollateralErc20,
			read: 'areTribesAndCurrenciesSet',
			readArg: [
				CollateralErc20Tribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralErc20Tribes.map(toBytes32),
			],
			expected: input => input,
			write: 'addTribes',
			writeArg: [
				CollateralErc20Tribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralErc20Tribes.map(toBytes32),
			],
			comment: 'Ensure the CollateralErc20 contract has all associated tribes added',
		});

		const issueFeeRate = (await getDeployParameter('COLLATERAL_RENBTC'))['ISSUE_FEE_RATE'];
		await runStep({
			contract: 'CollateralErc20',
			target: CollateralErc20,
			read: 'issueFeeRate',
			expected: allowZeroOrUpdateIfNonZero(issueFeeRate),
			write: 'setIssueFeeRate',
			writeArg: [issueFeeRate],
			comment: 'Ensure the CollateralErc20 contract has its issue fee rate set',
		});
	}

	if (CollateralShort && CollateralManager) {
		await runStep({
			contract: 'CollateralShort',
			target: CollateralShort,
			read: 'manager',
			expected: input => input === addressOf(CollateralManager),
			write: 'setManager',
			writeArg: addressOf(CollateralManager),
			comment: 'Ensure the CollateralShort contract is connected to the CollateralManager',
		});

		const CollateralShortTribes = (await getDeployParameter('COLLATERAL_SHORT'))['TRIBES']; // COLLATERAL_SHORT tribes - ['hBTC', 'rETH']
		await runStep({
			contract: 'CollateralShort',
			gasLimit: 1e6,
			target: CollateralShort,
			read: 'areTribesAndCurrenciesSet',
			readArg: [
				CollateralShortTribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralShortTribes.map(toBytes32),
			],
			expected: input => input,
			write: 'addTribes',
			writeArg: [
				CollateralShortTribes.map(key => toBytes32(`Tribe${key}`)),
				CollateralShortTribes.map(toBytes32),
			],
			comment: 'Ensure the CollateralShort contract has all associated tribes added',
		});

		const issueFeeRate = (await getDeployParameter('COLLATERAL_SHORT'))['ISSUE_FEE_RATE'];
		await runStep({
			contract: 'CollateralShort',
			target: CollateralShort,
			read: 'issueFeeRate',
			expected: allowZeroOrUpdateIfNonZero(issueFeeRate),
			write: 'setIssueFeeRate',
			writeArg: [issueFeeRate],
			comment: 'Ensure the CollateralShort contract has its issue fee rate set',
		});

		if (CollateralShort.interactionDelay) {
			const interactionDelay = (await getDeployParameter('COLLATERAL_SHORT'))['INTERACTION_DELAY'];
			await runStep({
				contract: 'CollateralShort',
				target: CollateralShort,
				read: 'interactionDelay',
				expected: allowZeroOrUpdateIfNonZero(interactionDelay),
				write: 'setInteractionDelay',
				writeArg: [interactionDelay],
				comment:
					'Ensure the CollateralShort contract has an interaction delay to prevent frontrunning',
			});
		}
	}

	const maxDebt = collateralManagerDefaults['MAX_DEBT'];
	await runStep({
		contract: 'CollateralManager',
		target: CollateralManager,
		read: 'maxDebt',
		expected: allowZeroOrUpdateIfNonZero(maxDebt),
		write: 'setMaxDebt',
		writeArg: [maxDebt],
		comment: 'Set the max amount of debt in the CollateralManager',
	});

	if (CollateralManager.maxSkewRate) {
		const maxSkewRate = collateralManagerDefaults['MAX_SKEW_RATE'];
		await runStep({
			contract: 'CollateralManager',
			target: CollateralManager,
			read: 'maxSkewRate',
			expected: allowZeroOrUpdateIfNonZero(maxSkewRate),
			write: 'setMaxSkewRate',
			writeArg: [maxSkewRate],
			comment: 'Set the max skew rate in the CollateralManager',
		});
	}

	const baseBorrowRate = collateralManagerDefaults['BASE_BORROW_RATE'];
	await runStep({
		contract: 'CollateralManager',
		target: CollateralManager,
		read: 'baseBorrowRate',
		expected: allowZeroOrUpdateIfNonZero(baseBorrowRate),
		write: 'setBaseBorrowRate',
		writeArg: [baseBorrowRate],
		comment: 'Set the base borrow rate in the CollateralManager',
	});

	const baseShortRate = collateralManagerDefaults['BASE_SHORT_RATE'];
	await runStep({
		contract: 'CollateralManager',
		target: CollateralManager,
		read: 'baseShortRate',
		expected: allowZeroOrUpdateIfNonZero(baseShortRate),
		write: 'setBaseShortRate',
		writeArg: [baseShortRate],
		comment: 'Set the base short rate in the CollateralManager',
	});

	// add to the manager if the tribes aren't already added.
	const CollateralManagerTribes = collateralManagerDefaults['TRIBES'];
	for (const tribe of CollateralManagerTribes) {
		await runStep({
			contract: 'CollateralManager',
			gasLimit: 1e6,
			target: CollateralManager,
			read: 'tribesByKey',
			readArg: toBytes32(tribe),
			expected: input => input,
			write: 'addTribes',
			writeArg: [toBytes32(`Tribe${tribe}`), toBytes32(tribe)],
			comment: `Ensure the CollateralManager contract has associated ${tribe} added`,
		});
	}

	const CollateralManagerShorts = collateralManagerDefaults['SHORTS'];
	if (CollateralManager.shortableTribesByKey) {
		for (const tribe of CollateralManagerShorts) {
			await runStep({
				contract: 'CollateralManager',
				gasLimit: 1e6,
				target: CollateralManager,
				read: 'shortableTribesByKey',
				readArg: toBytes32(tribe),
				expected: input => input,
				write: 'addShortableTribes',
				writeArg: [toBytes32(`Tribe${tribe}`), toBytes32(tribe)],
				comment: `Ensure the CollateralManager contract has associated short ${tribe} added`,
			});
		}
	}
};
