'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, mockToken } = require('./setup');

const MockEtherWrapper = artifacts.require('MockEtherWrapper');
const MockAggregator = artifacts.require('MockAggregatorV2V3');

const {
	currentTime,
	multiplyDecimal,
	divideDecimalRound,
	divideDecimal,
	toUnit,
	toPreciseUnit,
	fastForward,
} = require('../utils')();

const {
	setExchangeWaitingPeriod,
	setExchangeFeeRateForRwas,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
	defaults: { ISSUANCE_RATIO, MINIMUM_STAKE_TIME },
} = require('../..');

contract('Issuer (via Rwaone)', async accounts => {
	const WEEK = 604800;

	const [rUSD, sAUD, sEUR, wRWAX, rETH, ETH] = ['rUSD', 'sAUD', 'sEUR', 'wRWAX', 'rETH', 'ETH'].map(
		toBytes32
	);
	const rwaKeys = [rUSD, sAUD, sEUR, rETH, wRWAX];

	const [, owner, account1, account2, account3, account6, rwaoneBridgeToOptimism] = accounts;

	let rwaone,
		rwaoneProxy,
		systemStatus,
		systemSettings,
		delegateApprovals,
		exchangeRates,
		feePool,
		rUSDContract,
		rETHContract,
		sEURContract,
		sAUDContract,
		escrow,
		rewardEscrowV2,
		debtCache,
		issuer,
		rwas,
		addressResolver,
		rwaRedeemer,
		exchanger,
		aggregatorDebtRatio,
		aggregatorIssuedRwas,
		circuitBreaker,
		debtShares;

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		rwas = ['rUSD', 'sAUD', 'sEUR', 'rETH'];
		({
			Rwaone: rwaone,
			ProxyERC20Rwaone: rwaoneProxy,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			RwaoneEscrow: escrow,
			RewardEscrowV2: rewardEscrowV2,
			RwarUSD: rUSDContract,
			RwarETH: rETHContract,
			RwasAUD: sAUDContract,
			RwasEUR: sEURContract,
			Exchanger: exchanger,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			DelegateApprovals: delegateApprovals,
			AddressResolver: addressResolver,
			RwaRedeemer: rwaRedeemer,
			RwaoneDebtShare: debtShares,
			CircuitBreaker: circuitBreaker,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
			'ext:AggregatorIssuedRwas': aggregatorIssuedRwas,
		} = await setupAllContracts({
			accounts,
			rwas,
			contracts: [
				'Rwaone',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrowV2',
				'RwaoneEscrow',
				'SystemSettings',
				'Issuer',
				'LiquidatorRewards',
				'OneNetAggregatorIssuedRwas',
				'OneNetAggregatorDebtRatio',
				'DebtCache',
				'Exchanger', // necessary for burnRwas to check settlement of rUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
				'RwaRedeemer',
				'RwaoneDebtShare',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		rwaone = await artifacts.require('Rwaone').at(rwaoneProxy.address);

		// mocks for bridge
		await addressResolver.importAddresses(
			['RwaoneBridgeToOptimism'].map(toBytes32),
			[rwaoneBridgeToOptimism],
			{ from: owner }
		);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, rETH, ETH]);
	});

	async function updateDebtMonitors() {
		await debtCache.takeDebtSnapshot();
		await circuitBreaker.resetLastValue(
			[aggregatorIssuedRwas.address, aggregatorDebtRatio.address],
			[
				(await aggregatorIssuedRwas.latestRoundData())[1],
				(await aggregatorDebtRatio.latestRoundData())[1],
			],
			{ from: owner }
		);
	}

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[sAUD, sEUR, wRWAX, rETH],
			['0.5', '1.25', '0.1', '200'].map(toUnit)
		);

		// set a 0.3% default exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForRwas({
			owner,
			systemSettings,
			rwaKeys,
			exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
		});
		await updateDebtMonitors();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: issuer.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'addRwa',
				'addRwas',
				'burnForRedemption',
				'burnRwas',
				'burnRwasOnBehalf',
				'burnRwasToTarget',
				'burnRwasToTargetOnBehalf',
				'issueRwasWithoutDebt',
				'burnRwasWithoutDebt',
				'issueMaxRwas',
				'issueMaxRwasOnBehalf',
				'issueRwas',
				'issueRwasOnBehalf',
				'liquidateAccount',
				'modifyDebtSharesForMigration',
				'removeRwa',
				'removeRwas',
				'setCurrentPeriodId',
				'upgradeCollateralShort',
			],
		});
	});

	it('minimum stake time is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.minimumStakeTime(), MINIMUM_STAKE_TIME);
	});

	it('issuance ratio is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.issuanceRatio(), ISSUANCE_RATIO);
	});

	describe('protected methods', () => {
		it('issueRwasWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueRwasWithoutDebt,
				args: [rUSD, owner, toUnit(100)],
				accounts,
				address: rwaoneBridgeToOptimism,
				reason: 'only trusted minters',
			});
		});

		it('burnRwasWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnRwasWithoutDebt,
				args: [rUSD, owner, toUnit(100)],
				// full functionality of this method requires issuing rwas,
				// so just test that its blocked here and don't include the trusted addr
				accounts: [owner, account1],
				reason: 'only trusted minters',
			});
		});

		it('modifyDebtSharesForMigration() cannont be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.modifyDebtSharesForMigration,
				args: [account1, toUnit(100)],
				accounts,
				reason: 'only trusted migrators',
			});
		});

		it('issueRwas() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueRwas,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('issueRwasOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueRwasOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('issueMaxRwas() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxRwas,
				args: [account1],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('issueMaxRwasOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxRwasOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('burnRwas() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnRwas,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('burnRwasOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnRwasOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('burnRwasToTarget() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnRwasToTarget,
				args: [account1],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('liquidateAccount() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.liquidateAccount,
				args: [account1, false],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('burnRwasToTargetOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnRwasToTargetOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only Rwaone',
			});
		});
		it('setCurrentPeriodId() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.setCurrentPeriodId,
				args: [1234],
				accounts,
				reason: 'Must be fee pool',
			});
		});
	});

	describe('when minimum stake time is set to 0', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
		});
		describe('when the issuanceRatio is 0.2', () => {
			beforeEach(async () => {
				// set default issuance ratio of 0.2
				await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			});

			describe('minimumStakeTime - recording last issue and burn timestamp', async () => {
				let now;

				beforeEach(async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('1000'), { from: owner });

					now = await currentTime();
				});

				it('should issue rwas and store issue timestamp after now', async () => {
					// issue rwas
					await rwaone.issueRwas(web3.utils.toBN('5'), { from: account1 });

					// issue timestamp should be greater than now in future
					const issueTimestamp = await issuer.lastIssueEvent(owner);
					assert.ok(issueTimestamp.gte(now));
				});

				describe('require wait time on next burn rwa after minting', async () => {
					it('should revert when burning any rwas within minStakeTime', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(60 * 60 * 8, { from: owner });

						// issue rwas first
						await rwaone.issueRwas(web3.utils.toBN('5'), { from: account1 });

						await assert.revert(
							rwaone.burnRwas(web3.utils.toBN('5'), { from: account1 }),
							'Minimum stake time not reached'
						);
					});
					it('should set minStakeTime to 120 seconds and able to burn after wait time', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(120, { from: owner });

						// issue rwas first
						await rwaone.issueRwas(toUnit('0.001'), { from: account1 });

						// fastForward 30 seconds
						await fastForward(10);

						await assert.revert(
							rwaone.burnRwas(toUnit('0.001'), { from: account1 }),
							'Minimum stake time not reached'
						);

						// fastForward 115 seconds
						await fastForward(125);

						// burn rwas
						await rwaone.burnRwas(toUnit('0.001'), { from: account1 });
					});
				});
			});

			describe('allNetworksDebtInfo()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the rwa rates

						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[sAUD, sEUR, rETH, ETH, wRWAX],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our rwas are mocks, let's issue some amount to users
							await rUSDContract.issue(account1, toUnit('1000'));

							await sAUDContract.issue(account1, toUnit('1000')); // 500 rUSD worth
							await sAUDContract.issue(account2, toUnit('1000')); // 500 rUSD worth

							await sEURContract.issue(account3, toUnit('80')); // 100 rUSD worth

							await rETHContract.issue(account1, toUnit('1')); // 100 rUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares even though there are none', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2200'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2200')); // stays 0 if no debt shares are minted
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when issued through wRWAX staking', () => {
						beforeEach(async () => {
							// as our rwas are mocks, let's issue some amount to users
							const issuedRwaones = web3.utils.toBN('200012');
							await rwaone.transfer(account1, toUnit(issuedRwaones), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await rwaone.issueRwas(amountIssued, { from: account1 });
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2011'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2011'));
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when oracle updatedAt is old', () => {
						beforeEach(async () => {
							// as our rwas are mocks, let's issue some amount to users
							const issuedRwaones = web3.utils.toBN('200012');
							await rwaone.transfer(account1, toUnit(issuedRwaones), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await rwaone.issueRwas(amountIssued, { from: account1 });
							await updateDebtMonitors();

							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});
						it('then isStale = true', async () => {
							assert.isTrue((await issuer.allNetworksDebtInfo()).isStale);
						});
					});
				});
			});

			describe('totalIssuedRwas()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the rwa rates
						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[sAUD, sEUR, rETH, ETH, wRWAX],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
						await updateDebtMonitors();
					});

					describe('when numerous issues in one currency', () => {
						beforeEach(async () => {
							// as our rwas are mocks, let's issue some amount to users
							await rUSDContract.issue(account1, toUnit('1000'));
							await rUSDContract.issue(account2, toUnit('100'));
							await rUSDContract.issue(account3, toUnit('10'));
							await rUSDContract.issue(account1, toUnit('1'));

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedRwas in should correctly calculate the total issued rwas in rUSD', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('1111'));
						});
						it('and in another rwa currency', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(sAUD), toUnit('2222'));
						});
						it('and in wRWAX', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(wRWAX), divideDecimal('1111', '2'));
						});
						it('and in a non-rwa currency', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(ETH), divideDecimal('1111', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								rwaone.totalIssuedRwas(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our rwas are mocks, let's issue some amount to users
							await rUSDContract.issue(account1, toUnit('1000'));

							await sAUDContract.issue(account1, toUnit('1000')); // 500 rUSD worth
							await sAUDContract.issue(account2, toUnit('1000')); // 500 rUSD worth

							await sEURContract.issue(account3, toUnit('80')); // 100 rUSD worth

							await rETHContract.issue(account1, toUnit('1')); // 100 rUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedRwas in should correctly calculate the total issued rwas in rUSD', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('2200'));
						});
						it('and in another rwa currency', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(sAUD), toUnit('4400', '2'));
						});
						it('and in wRWAX', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(wRWAX), divideDecimal('2200', '2'));
						});
						it('and in a non-rwa currency', async () => {
							assert.bnEqual(await rwaone.totalIssuedRwas(ETH), divideDecimal('2200', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								rwaone.totalIssuedRwas(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});
				});
			});

			describe('debtBalance()', () => {
				it('should not change debt balance % if exchange rates change', async () => {
					let newAUDRate = toUnit('0.5');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [sAUD], [newAUDRate]);
					await updateDebtMonitors();

					await rwaone.transfer(account1, toUnit('20000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('20000'), {
						from: owner,
					});

					const amountIssuedAcc1 = toUnit('30');
					const amountIssuedAcc2 = toUnit('50');
					await rwaone.issueRwas(amountIssuedAcc1, { from: account1 });
					await rwaone.issueRwas(amountIssuedAcc2, { from: account2 });

					await rwaone.exchange(rUSD, amountIssuedAcc2, sAUD, { from: account2 });

					const PRECISE_UNIT = web3.utils.toWei(web3.utils.toBN('1'), 'gether');
					let totalIssuedRwarUSD = await rwaone.totalIssuedRwas(rUSD);
					const account1DebtRatio = divideDecimal(
						amountIssuedAcc1,
						totalIssuedRwarUSD,
						PRECISE_UNIT
					);
					const account2DebtRatio = divideDecimal(
						amountIssuedAcc2,
						totalIssuedRwarUSD,
						PRECISE_UNIT
					);

					newAUDRate = toUnit('1.85');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [sAUD], [newAUDRate]);
					await updateDebtMonitors();

					totalIssuedRwarUSD = await rwaone.totalIssuedRwas(rUSD);
					const conversionFactor = web3.utils.toBN(1000000000);
					const expectedDebtAccount1 = multiplyDecimal(
						account1DebtRatio,
						totalIssuedRwarUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);
					const expectedDebtAccount2 = multiplyDecimal(
						account2DebtRatio,
						totalIssuedRwarUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);

					assert.bnClose(await rwaone.debtBalanceOf(account1, rUSD), expectedDebtAccount1);
					assert.bnClose(await rwaone.debtBalanceOf(account2, rUSD), expectedDebtAccount2);
				});

				it("should correctly calculate a user's debt balance without prior issuance", async () => {
					await rwaone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					const debt1 = await rwaone.debtBalanceOf(account1, toBytes32('rUSD'));
					const debt2 = await rwaone.debtBalanceOf(account2, toBytes32('rUSD'));
					assert.bnEqual(debt1, 0);
					assert.bnEqual(debt2, 0);
				});

				it("should correctly calculate a user's debt balance with prior issuance", async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedRwas = toUnit('1001');
					await rwaone.issueRwas(issuedRwas, { from: account1 });

					const debt = await rwaone.debtBalanceOf(account1, toBytes32('rUSD'));
					assert.bnEqual(debt, issuedRwas);
				});
			});

			describe('remainingIssuableRwas()', () => {
				it("should correctly calculate a user's remaining issuable rwas with prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedRwaones = web3.utils.toBN('200012');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					// Issue
					const amountIssued = toUnit('2011');
					await rwaone.issueRwas(amountIssued, { from: account1 });

					const expectedIssuableRwas = multiplyDecimal(
						toUnit(issuedRwaones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					).sub(amountIssued);

					const issuableRwas = await issuer.remainingIssuableRwas(account1);
					assert.bnEqual(issuableRwas.maxIssuable, expectedIssuableRwas);

					// other args should also be correct
					assert.bnEqual(issuableRwas.totalSystemDebt, amountIssued);
					assert.bnEqual(issuableRwas.alreadyIssued, amountIssued);
				});

				it("should correctly calculate a user's remaining issuable rwas without prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedRwaones = web3.utils.toBN('20');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					const expectedIssuableRwas = multiplyDecimal(
						toUnit(issuedRwaones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					);

					const remainingIssuable = await issuer.remainingIssuableRwas(account1);
					assert.bnEqual(remainingIssuable.maxIssuable, expectedIssuableRwas);
				});
			});

			describe('maxIssuableRwas()', () => {
				it("should correctly calculate a user's maximum issuable rwas without prior issuance", async () => {
					const rate = await exchangeRates.rateForCurrency(toBytes32('wRWAX'));
					const issuedRwaones = web3.utils.toBN('200000');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});
					const issuanceRatio = await systemSettings.issuanceRatio();

					const expectedIssuableRwas = multiplyDecimal(
						toUnit(issuedRwaones),
						multiplyDecimal(rate, issuanceRatio)
					);
					const maxIssuableRwas = await rwaone.maxIssuableRwas(account1);

					assert.bnEqual(expectedIssuableRwas, maxIssuableRwas);
				});

				it("should correctly calculate a user's maximum issuable rwas without any wRWAX", async () => {
					const maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
					assert.bnEqual(0, maxIssuableRwas);
				});

				it("should correctly calculate a user's maximum issuable rwas with prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);

					const issuedRwaones = web3.utils.toBN('320001');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					const issuanceRatio = await systemSettings.issuanceRatio();
					const amountIssued = web3.utils.toBN('1234');
					await rwaone.issueRwas(toUnit(amountIssued), { from: account1 });

					const expectedIssuableRwas = multiplyDecimal(
						toUnit(issuedRwaones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					);

					const maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
					assert.bnEqual(expectedIssuableRwas, maxIssuableRwas);
				});
			});

			describe('adding and removing rwas', () => {
				it('should allow adding a Rwa contract', async () => {
					const previousRwaCount = await rwaone.availableRwaCount();

					const { token: rwa } = await mockToken({
						accounts,
						rwa: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const txn = await issuer.addRwa(rwa.address, { from: owner });

					const currencyKey = toBytes32('sXYZ');

					// Assert that we've successfully added a Rwa
					assert.bnEqual(
						await rwaone.availableRwaCount(),
						previousRwaCount.add(web3.utils.toBN(1))
					);
					// Assert that it's at the end of the array
					assert.equal(await rwaone.availableRwas(previousRwaCount), rwa.address);
					// Assert that it's retrievable by its currencyKey
					assert.equal(await rwaone.rwas(currencyKey), rwa.address);

					// Assert event emitted
					assert.eventEqual(txn.logs[0], 'RwaAdded', [currencyKey, rwa.address]);
				});

				it('should disallow adding a Rwa contract when the user is not the owner', async () => {
					const { token: rwa } = await mockToken({
						accounts,
						rwa: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await onlyGivenAddressCanInvoke({
						fnc: issuer.addRwa,
						accounts,
						args: [rwa.address],
						address: owner,
						reason: 'Only the contract owner may perform this action',
					});
				});

				it('should disallow double adding a Rwa contract with the same address', async () => {
					const { token: rwa } = await mockToken({
						accounts,
						rwa: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addRwa(rwa.address, { from: owner });
					await assert.revert(issuer.addRwa(rwa.address, { from: owner }), 'Rwa exists');
				});

				it('should disallow double adding a Rwa contract with the same currencyKey', async () => {
					const { token: rwa1 } = await mockToken({
						accounts,
						rwa: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const { token: rwa2 } = await mockToken({
						accounts,
						rwa: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addRwa(rwa1.address, { from: owner });
					await assert.revert(issuer.addRwa(rwa2.address, { from: owner }), 'Rwa exists');
				});

				describe('when another rwa is added with 0 supply', () => {
					let currencyKey, rwa, rwaProxy;

					beforeEach(async () => {
						const symbol = 'rBTC';
						currencyKey = toBytes32(symbol);

						({ token: rwa, proxy: rwaProxy } = await mockToken({
							rwa: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addRwa(rwa.address, { from: owner });
						await setupPriceAggregators(exchangeRates, owner, [currencyKey]);
					});

					it('should be able to query multiple rwa addresses', async () => {
						const rwaAddresses = await issuer.getRwas([currencyKey, rETH, rUSD]);
						assert.equal(rwaAddresses[0], rwa.address);
						assert.equal(rwaAddresses[1], rETHContract.address);
						assert.equal(rwaAddresses[2], rUSDContract.address);
						assert.equal(rwaAddresses.length, 3);
					});

					it('should allow removing a Rwa contract when it has no issued balance', async () => {
						const rwaCount = await rwaone.availableRwaCount();

						assert.notEqual(await rwaone.rwas(currencyKey), ZERO_ADDRESS);

						const txn = await issuer.removeRwa(currencyKey, { from: owner });

						// Assert that we have one less rwa, and that the specific currency key is gone.
						assert.bnEqual(
							await rwaone.availableRwaCount(),
							rwaCount.sub(web3.utils.toBN(1))
						);
						assert.equal(await rwaone.rwas(currencyKey), ZERO_ADDRESS);

						assert.eventEqual(txn, 'RwaRemoved', [currencyKey, rwa.address]);
					});

					it('should disallow removing a token by a non-owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: issuer.removeRwa,
							args: [currencyKey],
							accounts,
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					describe('when that rwa has issued but has no rate', () => {
						beforeEach(async () => {
							await rwa.issue(account1, toUnit('100'));
						});
						it('should disallow removing a Rwa contract when it has an issued balance and no rate', async () => {
							// Assert that we can't remove the rwa now
							await assert.revert(
								issuer.removeRwa(currencyKey, { from: owner }),
								'Cannot remove without rate'
							);
						});
						describe('when the rwa has a rate', () => {
							beforeEach(async () => {
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[currencyKey],
									[toUnit('2')]
								);
							});

							describe('when another user exchanges into the rwa', () => {
								beforeEach(async () => {
									await rUSDContract.issue(account2, toUnit('1000'));
									await rwaone.exchange(rUSD, toUnit('100'), currencyKey, { from: account2 });
								});
								describe('when the rwa is removed', () => {
									beforeEach(async () => {
										await issuer.removeRwa(currencyKey, { from: owner });
									});
									it('then settling works as expected', async () => {
										await rwaone.settle(currencyKey);

										const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
										assert.equal(numEntries, '0');
									});
								});
								describe('when the same user exchanges out of the rwa', () => {
									beforeEach(async () => {
										await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });
										// pass through the waiting period so we can exchange again
										await fastForward(90);
										await rwaone.exchange(currencyKey, toUnit('1'), rUSD, { from: account2 });
									});
									describe('when the rwa is removed', () => {
										beforeEach(async () => {
											await issuer.removeRwa(currencyKey, { from: owner });
										});
										it('then settling works as expected', async () => {
											await rwaone.settle(rUSD);

											const { numEntries } = await exchanger.settlementOwing(owner, rUSD);
											assert.equal(numEntries, '0');
										});
										it('then settling from the original currency works too', async () => {
											await rwaone.settle(currencyKey);
											const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
											assert.equal(numEntries, '0');
										});
									});
								});
							});

							describe('when a debt snapshot is taken', () => {
								let totalIssuedRwas;
								beforeEach(async () => {
									await updateDebtMonitors();

									totalIssuedRwas = await issuer.totalIssuedRwas(rUSD, true);

									// 100 rETH at 2 per rETH is 200 total debt
									assert.bnEqual(totalIssuedRwas, toUnit('200'));
								});
								describe('when the rwa is removed', () => {
									let txn;
									beforeEach(async () => {
										// base conditions
										assert.equal(await rUSDContract.balanceOf(rwaRedeemer.address), '0');
										assert.equal(await rwaRedeemer.redemptions(rwaProxy.address), '0');

										// now do the removal
										txn = await issuer.removeRwa(currencyKey, { from: owner });
									});
									it('emits an event', async () => {
										assert.eventEqual(txn, 'RwaRemoved', [currencyKey, rwa.address]);
									});
									it('issues the equivalent amount of rUSD', async () => {
										const amountOfrUSDIssued = await rUSDContract.balanceOf(rwaRedeemer.address);

										// 100 units of rBTC at a rate of 2:1
										assert.bnEqual(amountOfrUSDIssued, toUnit('200'));
									});
									it('it invokes deprecate on the redeemer via the proxy', async () => {
										const redeemRate = await rwaRedeemer.redemptions(rwaProxy.address);

										assert.bnEqual(redeemRate, toUnit('2'));
									});
									it('and total debt remains unchanged', async () => {
										assert.bnEqual(await issuer.totalIssuedRwas(rUSD, true), totalIssuedRwas);
									});
								});
							});
						});
					});
				});

				describe('multiple add/remove rwas', () => {
					let currencyKey, rwa;

					beforeEach(async () => {
						const symbol = 'rBTC';
						currencyKey = toBytes32(symbol);

						({ token: rwa } = await mockToken({
							rwa: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addRwa(rwa.address, { from: owner });
					});

					it('should allow adding multiple Rwa contracts at once', async () => {
						const previousRwaCount = await rwaone.availableRwaCount();

						const { token: rwa1 } = await mockToken({
							accounts,
							rwa: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: rwa2 } = await mockToken({
							accounts,
							rwa: 'sABC',
							skipInitialAllocation: true,
							supply: 0,
							name: 'ABC',
							symbol: 'ABC',
						});

						const txn = await issuer.addRwas([rwa1.address, rwa2.address], { from: owner });

						const currencyKey1 = toBytes32('sXYZ');
						const currencyKey2 = toBytes32('sABC');

						// Assert that we've successfully added two Rwas
						assert.bnEqual(
							await rwaone.availableRwaCount(),
							previousRwaCount.add(web3.utils.toBN(2))
						);
						// Assert that they're at the end of the array
						assert.equal(await rwaone.availableRwas(previousRwaCount), rwa1.address);
						assert.equal(
							await rwaone.availableRwas(previousRwaCount.add(web3.utils.toBN(1))),
							rwa2.address
						);
						// Assert that they are retrievable by currencyKey
						assert.equal(await rwaone.rwas(currencyKey1), rwa1.address);
						assert.equal(await rwaone.rwas(currencyKey2), rwa2.address);

						// Assert events emitted
						assert.eventEqual(txn.logs[0], 'RwaAdded', [currencyKey1, rwa1.address]);
						assert.eventEqual(txn.logs[1], 'RwaAdded', [currencyKey2, rwa2.address]);
					});

					it('should disallow multi-adding the same Rwa contract', async () => {
						const { token: rwa } = await mockToken({
							accounts,
							rwa: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addRwas([rwa.address, rwa.address], { from: owner }),
							'Rwa exists'
						);
					});

					it('should disallow multi-adding rwa contracts with the same currency key', async () => {
						const { token: rwa1 } = await mockToken({
							accounts,
							rwa: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						const { token: rwa2 } = await mockToken({
							accounts,
							rwa: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addRwas([rwa1.address, rwa2.address], { from: owner }),
							'Rwa exists'
						);
					});

					it('should disallow removing non-existent rwas', async () => {
						const fakeCurrencyKey = toBytes32('NOPE');

						// Assert that we can't remove the rwa
						await assert.revert(
							issuer.removeRwas([currencyKey, fakeCurrencyKey], { from: owner }),
							'Rwa does not exist'
						);
					});

					it('should disallow removing rUSD', async () => {
						// Assert that we can't remove rUSD
						await assert.revert(
							issuer.removeRwas([currencyKey, rUSD], { from: owner }),
							'Cannot remove rwa'
						);
					});

					it('should allow removing rwas with no balance', async () => {
						const symbol2 = 'sFOO';
						const currencyKey2 = toBytes32(symbol2);

						const { token: rwa2 } = await mockToken({
							rwa: symbol2,
							accounts,
							name: 'foo',
							symbol2,
							supply: 0,
							skipInitialAllocation: true,
						});

						await issuer.addRwa(rwa2.address, { from: owner });

						const previousRwaCount = await rwaone.availableRwaCount();

						const tx = await issuer.removeRwas([currencyKey, currencyKey2], { from: owner });

						assert.bnEqual(
							await rwaone.availableRwaCount(),
							previousRwaCount.sub(web3.utils.toBN(2))
						);

						// Assert events emitted
						assert.eventEqual(tx.logs[0], 'RwaRemoved', [currencyKey, rwa.address]);
						assert.eventEqual(tx.logs[1], 'RwaRemoved', [currencyKey2, rwa2.address]);
					});
				});
			});

			describe('issuance', () => {
				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has rwas to issue from
						await rwaone.transfer(account1, toUnit('1000'), { from: owner });
					});

					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling issue() reverts', async () => {
								await assert.revert(
									rwaone.issueRwas(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling issueMaxRwas() reverts', async () => {
								await assert.revert(
									rwaone.issueMaxRwas({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling issue() succeeds', async () => {
									await rwaone.issueRwas(toUnit('1'), { from: account1 });
								});
								it('and calling issueMaxRwas() succeeds', async () => {
									await rwaone.issueMaxRwas({ from: account1 });
								});
							});
						});
					});
					describe(`when wRWAX is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('reverts on issueRwas()', async () => {
							await assert.revert(
								rwaone.issueRwas(toUnit('1'), { from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
						it('reverts on issueMaxRwas()', async () => {
							await assert.revert(
								rwaone.issueMaxRwas({ from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});

						it('reverts on issueRwas()', async () => {
							await assert.revert(
								rwaone.issueRwas(toUnit('1'), { from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
						it('reverts on issueMaxRwas()', async () => {
							await assert.revert(
								rwaone.issueMaxRwas({ from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
					});
				});
				it('should allow the issuance of a small amount of rwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					// Note: If a too small amount of rwas are issued here, the amount may be
					// rounded to 0 in the debt register. This will revert. As such, there is a minimum
					// number of rwas that need to be issued each time issue is invoked. The exact
					// amount depends on the Rwa exchange rate and the total supply.
					await rwaone.issueRwas(web3.utils.toBN('5'), { from: account1 });
				});

				it('should be possible to issue the maximum amount of rwas via issueRwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('1000'), { from: owner });

					const maxRwas = await rwaone.maxIssuableRwas(account1);

					// account1 should be able to issue
					await rwaone.issueRwas(maxRwas, { from: account1 });
				});

				it('should allow an issuer to issue rwas in one flavour', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					await rwaone.issueRwas(toUnit('10'), { from: account1 });

					// There should be 10 rUSD of value in the system
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('10'));

					// And account1 should own 100% of the debt.
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('10'));
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('10'));
				});

				// TODO: Check that the rounding errors are acceptable
				it('should allow two issuers to issue rwas in one flavour', async () => {
					// Give some wRWAX to account1 and account2
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueRwas(toUnit('10'), { from: account1 });
					await rwaone.issueRwas(toUnit('20'), { from: account2 });

					// There should be 30rUSD of value in the system
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('30'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await rwaone.debtBalanceOf(account1, rUSD), toUnit('10'));
					assert.bnClose(await rwaone.debtBalanceOf(account2, rUSD), toUnit('20'));
				});

				it('should allow multi-issuance in one flavour', async () => {
					// Give some wRWAX to account1 and account2
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueRwas(toUnit('10'), { from: account1 });
					await rwaone.issueRwas(toUnit('20'), { from: account2 });
					await rwaone.issueRwas(toUnit('10'), { from: account1 });

					// There should be 40 rUSD of value in the system
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('40'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await rwaone.debtBalanceOf(account1, rUSD), toUnit('20'));
					assert.bnClose(await rwaone.debtBalanceOf(account2, rUSD), toUnit('20'));
				});

				describe('issueRwasWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();

							await issuer.issueRwasWithoutDebt(rETH, owner, toUnit(100), {
								from: rwaoneBridgeToOptimism,
							});
						});

						it('issues rwas', async () => {
							assert.bnEqual(await rETHContract.balanceOf(owner), toUnit(100));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(20000)));
						});
					});
				});

				describe('burnRwasWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();
							await issuer.issueRwasWithoutDebt(rETH, owner, toUnit(100), {
								from: rwaoneBridgeToOptimism,
							});
							await issuer.burnRwasWithoutDebt(rETH, owner, toUnit(50), {
								from: rwaoneBridgeToOptimism,
							});
						});

						it('burns rwas', async () => {
							assert.bnEqual(await rETHContract.balanceOf(owner), toUnit(50));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(10000)));
						});
					});
				});

				describe('issueMaxRwas', () => {
					it('should allow an issuer to issue max rwas in one flavour', async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('10000'), {
							from: owner,
						});

						// Issue
						await rwaone.issueMaxRwas({ from: account1 });

						// There should be 200 rUSD of value in the system
						assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('200'));

						// And account1 should own all of it.
						assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('200'));
					});
				});

				it('should allow an issuer to issue max rwas via the standard issue call', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Determine maximum amount that can be issued.
					const maxIssuable = await rwaone.maxIssuableRwas(account1);

					// Issue
					await rwaone.issueRwas(maxIssuable, { from: account1 });

					// There should be 200 rUSD of value in the system
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit('200'));

					// And account1 should own all of it.
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('200'));
				});

				it('should disallow an issuer from issuing rwas beyond their remainingIssuableRwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue rUSD
					let issuableRwas = await issuer.remainingIssuableRwas(account1);
					assert.bnEqual(issuableRwas.maxIssuable, toUnit('200'));

					// Issue that amount.
					await rwaone.issueRwas(issuableRwas.maxIssuable, { from: account1 });

					// They should now have 0 issuable rwas.
					issuableRwas = await issuer.remainingIssuableRwas(account1);
					assert.bnEqual(issuableRwas.maxIssuable, '0');

					// And trying to issue the smallest possible unit of one should fail.
					await assert.revert(rwaone.issueRwas('1', { from: account1 }), 'Amount too large');
				});

				it('circuit breaks when debt changes dramatically', async () => {
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// debt must start at 0
					assert.bnEqual(await rwaone.totalIssuedRwas(rUSD), toUnit(0));

					// They should now be able to issue rUSD
					await rwaone.issueRwas(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await rwaone.issueRwas(toUnit('1'), { from: account1 });
					await updateDebtMonitors();

					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit('101'));

					await rUSDContract.issue(account1, toUnit('10000000'));
					await debtCache.takeDebtSnapshot();

					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit('10000101'));

					// trigger circuit breaking
					await rwaone.issueRwas(toUnit('1'), { from: account1 });

					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit('10000101'));

					// undo
					await rUSDContract.burn(account1, toUnit('10000000'));

					// circuit is still broken
					await rwaone.issueRwas(toUnit('1'), { from: account1 });
					await rwaone.issueRwas(toUnit('1'), { from: account1 });

					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit('101'));
				});
			});

			describe('burning', () => {
				it('circuit breaks when debt changes dramatically', async () => {
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue rUSD
					await rwaone.issueRwas(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await rwaone.burnRwas(toUnit('1'), { from: account1 });

					// burn the rest of the rwas without getting rid of debt shares
					await rUSDContract.burn(account1, toUnit('90'));
					await debtCache.takeDebtSnapshot();

					// all debt should be burned here
					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit(9));

					// trigger circuit breaking (not reverting here is part of the test)
					await rwaone.burnRwas('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit(9));

					// mint it back
					await rUSDContract.issue(account1, toUnit('90'));

					await rwaone.burnRwas('1', { from: account1 });
					await rwaone.burnRwas('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await rUSDContract.balanceOf(account1), toUnit(99));
				});

				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has rwas to burb
						await rwaone.transfer(account1, toUnit('1000'), { from: owner });
						await rwaone.issueMaxRwas({ from: account1 });
					});
					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling burn() reverts', async () => {
								await assert.revert(
									rwaone.burnRwas(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling burnRwasToTarget() reverts', async () => {
								await assert.revert(
									rwaone.burnRwasToTarget({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling burnRwas() succeeds', async () => {
									await rwaone.burnRwas(toUnit('1'), { from: account1 });
								});
								it('and calling burnRwasToTarget() succeeds', async () => {
									await rwaone.burnRwasToTarget({ from: account1 });
								});
							});
						});
					});

					describe(`when wRWAX is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								rwaone.burnRwas(toUnit('1'), { from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
						it('and calling burnRwasToTarget() reverts', async () => {
							await assert.revert(
								rwaone.burnRwasToTarget({ from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500);
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								rwaone.burnRwas(toUnit('1'), { from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
						it('and calling burnRwasToTarget() reverts', async () => {
							await assert.revert(
								rwaone.burnRwasToTarget({ from: account1 }),
								'A rwa or wRWAX rate is invalid'
							);
						});
					});
				});

				it('should allow an issuer with outstanding debt to burn rwas and decrease debt', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueMaxRwas({ from: account1 });

					// account1 should now have 200 rUSD of debt.
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('200'));

					// Burn 100 rUSD
					await rwaone.burnRwas(toUnit('100'), { from: account1 });

					// account1 should now have 100 rUSD of debt.
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('100'));
				});

				it('should disallow an issuer without outstanding debt from burning rwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueMaxRwas({ from: account1 });

					// account2 should not have anything and can't burn.
					await assert.revert(
						rwaone.burnRwas(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);

					// And even when we give account2 rwas, it should not be able to burn.
					await rUSDContract.transfer(account2, toUnit('100'), {
						from: account1,
					});

					await assert.revert(
						rwaone.burnRwas(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);
				});

				it('should revert when trying to burn rwas that do not exist', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueMaxRwas({ from: account1 });

					// Transfer all newly issued rwas to account2
					await rUSDContract.transfer(account2, toUnit('200'), {
						from: account1,
					});

					const debtBefore = await rwaone.debtBalanceOf(account1, rUSD);

					assert.ok(!debtBefore.isNeg());

					// Burning any amount of rUSD beyond what is owned will cause a revert
					await assert.revert(
						rwaone.burnRwas('1', { from: account1 }),
						'SafeMath: subtraction overflow'
					);
				});

				it("should only burn up to a user's actual debt level", async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					const fullAmount = toUnit('210');
					const account1Payment = toUnit('10');
					const account2Payment = fullAmount.sub(account1Payment);
					await rwaone.issueRwas(account1Payment, { from: account1 });
					await rwaone.issueRwas(account2Payment, { from: account2 });

					// Transfer all of account2's rwas to account1
					const amountTransferred = toUnit('200');
					await rUSDContract.transfer(account1, amountTransferred, {
						from: account2,
					});
					// return;

					const balanceOfAccount1 = await rUSDContract.balanceOf(account1);

					// Then try to burn them all. Only 10 rwas (and fees) should be gone.
					await rwaone.burnRwas(balanceOfAccount1, { from: account1 });
					const balanceOfAccount1AfterBurn = await rUSDContract.balanceOf(account1);

					// Recording debts in the debt ledger reduces accuracy.
					//   Let's allow for a 1000 margin of error.
					assert.bnClose(balanceOfAccount1AfterBurn, amountTransferred, '1000');
				});

				it("should successfully burn all user's rwas @gasprofile", async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueRwas(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 rwas (and fees) should be gone.
					await rwaone.burnRwas(await rUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await rUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of rwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					await rwaone.issueRwas(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 rwas (and fees) should be gone.
					await rwaone.burnRwas(await rUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await rUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of rwas', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedRwasPt1 = toUnit('2000');
					const issuedRwasPt2 = toUnit('2000');
					await rwaone.issueRwas(issuedRwasPt1, { from: account1 });
					await rwaone.issueRwas(issuedRwasPt2, { from: account1 });
					await rwaone.issueRwas(toUnit('1000'), { from: account2 });

					const debt = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				describe('debt calculation in multi-issuance scenarios', () => {
					it('should correctly calculate debt in a multi-issuance multi-burn scenario @gasprofile', async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await rwaone.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await rwaone.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedRwas1 = toUnit('2000');
						const issuedRwas2 = toUnit('2000');
						const issuedRwas3 = toUnit('2000');

						// Send more than their rwa balance to burn all
						const burnAllRwas = toUnit('2050');

						await rwaone.issueRwas(issuedRwas1, { from: account1 });
						await rwaone.issueRwas(issuedRwas2, { from: account2 });
						await rwaone.issueRwas(issuedRwas3, { from: account3 });

						await rwaone.burnRwas(burnAllRwas, { from: account1 });
						await rwaone.burnRwas(burnAllRwas, { from: account2 });
						await rwaone.burnRwas(burnAllRwas, { from: account3 });

						const debtBalance1After = await rwaone.debtBalanceOf(account1, rUSD);
						const debtBalance2After = await rwaone.debtBalanceOf(account2, rUSD);
						const debtBalance3After = await rwaone.debtBalanceOf(account3, rUSD);

						assert.bnEqual(debtBalance1After, '0');
						assert.bnEqual(debtBalance2After, '0');
						assert.bnEqual(debtBalance3After, '0');
					});

					it('should allow user to burn all rwas issued even after other users have issued', async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await rwaone.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await rwaone.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedRwas1 = toUnit('2000');
						const issuedRwas2 = toUnit('2000');
						const issuedRwas3 = toUnit('2000');

						await rwaone.issueRwas(issuedRwas1, { from: account1 });
						await rwaone.issueRwas(issuedRwas2, { from: account2 });
						await rwaone.issueRwas(issuedRwas3, { from: account3 });

						const debtBalanceBefore = await rwaone.debtBalanceOf(account1, rUSD);
						await rwaone.burnRwas(debtBalanceBefore, { from: account1 });
						const debtBalanceAfter = await rwaone.debtBalanceOf(account1, rUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow a user to burn up to their balance if they try too burn too much', async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('500000'), {
							from: owner,
						});

						// Issue
						const issuedRwas1 = toUnit('10');

						await rwaone.issueRwas(issuedRwas1, { from: account1 });
						await rwaone.burnRwas(issuedRwas1.add(toUnit('9000')), {
							from: account1,
						});
						const debtBalanceAfter = await rwaone.debtBalanceOf(account1, rUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow users to burn their debt and adjust the debtBalanceOf correctly for remaining users', async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('40000000'), {
							from: owner,
						});
						await rwaone.transfer(account2, toUnit('40000000'), {
							from: owner,
						});

						// Issue
						const issuedRwas1 = toUnit('150000');
						const issuedRwas2 = toUnit('50000');

						await rwaone.issueRwas(issuedRwas1, { from: account1 });
						await rwaone.issueRwas(issuedRwas2, { from: account2 });

						let debtBalance1After = await rwaone.debtBalanceOf(account1, rUSD);
						let debtBalance2After = await rwaone.debtBalanceOf(account2, rUSD);

						// debtBalanceOf has rounding error but is within tolerance
						assert.bnClose(debtBalance1After, toUnit('150000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');

						// Account 1 burns 100,000
						await rwaone.burnRwas(toUnit('100000'), { from: account1 });

						debtBalance1After = await rwaone.debtBalanceOf(account1, rUSD);
						debtBalance2After = await rwaone.debtBalanceOf(account2, rUSD);

						assert.bnClose(debtBalance1After, toUnit('50000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');
					});

					it('should revert if sender tries to issue rwas with 0 amount', async () => {
						// Issue 0 amount of rwa
						const issuedRwas1 = toUnit('0');

						await assert.revert(
							rwaone.issueRwas(issuedRwas1, { from: account1 }),
							'cannot issue 0 rwas'
						);
					});
				});

				describe('burnRwasToTarget', () => {
					beforeEach(async () => {
						// Give some wRWAX to account1
						await rwaone.transfer(account1, toUnit('40000'), {
							from: owner,
						});
						// Set wRWAX price to 1
						await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], ['1'].map(toUnit));
						await updateDebtMonitors();

						// Issue
						await rwaone.issueMaxRwas({ from: account1 });
						assert.bnClose(await rwaone.debtBalanceOf(account1, rUSD), toUnit('8000'));

						// Set minimumStakeTime to 1 hour
						await systemSettings.setMinimumStakeTime(60 * 60, { from: owner });
					});

					describe('when the wRWAX price drops 50%', () => {
						let maxIssuableRwas;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], ['.5'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
							assert.equal(await feePool.isFeesClaimable(account1), false);
						});

						it('then the maxIssuableRwas drops 50%', async () => {
							assert.bnClose(maxIssuableRwas, toUnit('4000'));
						});
						it('then calling burnRwasToTarget() reduces rUSD to c-ratio target', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.bnClose(await rwaone.debtBalanceOf(account1, rUSD), toUnit('4000'));
						});
						it('then fees are claimable', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wRWAX price drops 10%', () => {
						let maxIssuableRwas;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], ['.9'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
						});

						it('then the maxIssuableRwas drops 10%', async () => {
							assert.bnEqual(maxIssuableRwas, toUnit('7200'));
						});
						it('then calling burnRwasToTarget() reduces rUSD to c-ratio target', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('7200'));
						});
						it('then fees are claimable', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wRWAX price drops 90%', () => {
						let maxIssuableRwas;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], ['.1'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
						});

						it('then the maxIssuableRwas drops 10%', async () => {
							assert.bnEqual(maxIssuableRwas, toUnit('800'));
						});
						it('then calling burnRwasToTarget() reduces rUSD to c-ratio target', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('800'));
						});
						it('then fees are claimable', async () => {
							await rwaone.burnRwasToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wRWAX price increases 100%', () => {
						let maxIssuableRwas;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], ['2'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableRwas = await rwaone.maxIssuableRwas(account1);
						});

						it('then the maxIssuableRwas increases 100%', async () => {
							assert.bnEqual(maxIssuableRwas, toUnit('16000'));
						});
						it('then calling burnRwasToTarget() reverts', async () => {
							await assert.revert(
								rwaone.burnRwasToTarget({ from: account1 }),
								'SafeMath: subtraction overflow'
							);
						});
					});
				});

				describe('burnRwas() after exchange()', () => {
					describe('given the waiting period is set to 60s', () => {
						let amount;
						const exchangeFeeRate = toUnit('0');
						beforeEach(async () => {
							amount = toUnit('1250');
							await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });

							// set the exchange fee to 0 to effectively ignore it
							await setExchangeFeeRateForRwas({
								owner,
								systemSettings,
								rwaKeys,
								exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
							});
						});
						describe('and a user has 1250 rUSD issued', () => {
							beforeEach(async () => {
								await rwaone.transfer(account1, toUnit('1000000'), { from: owner });
								await rwaone.issueRwas(amount, { from: account1 });
							});
							describe('and is has been exchanged into sEUR at a rate of 1.25:1 and the waiting period has expired', () => {
								beforeEach(async () => {
									await rwaone.exchange(rUSD, amount, sEUR, { from: account1 });
									await fastForward(90); // make sure the waiting period is expired on this
								});
								describe('and they have exchanged all of it back into rUSD', () => {
									beforeEach(async () => {
										await rwaone.exchange(sEUR, toUnit('1000'), rUSD, { from: account1 });
									});
									describe('when they attempt to burn the rUSD', () => {
										it('then it fails as the waiting period is ongoing', async () => {
											await assert.revert(
												rwaone.burnRwas(amount, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});
									});
									describe('and 60s elapses with no change in the sEUR rate', () => {
										beforeEach(async () => {
											fastForward(60);
										});
										describe('when they attempt to burn the rUSD', () => {
											let txn;
											beforeEach(async () => {
												txn = await rwaone.burnRwas(amount, { from: account1 });
											});
											it('then it succeeds and burns the entire rUSD amount', async () => {
												const logs = await getDecodedLogs({
													hash: txn.tx,
													contracts: [rwaone, rUSDContract],
												});

												decodedEventEqual({
													event: 'Burned',
													emittedFrom: rUSDContract.address,
													args: [account1, amount],
													log: logs.find(({ name } = {}) => name === 'Burned'),
												});

												const rUSDBalance = await rUSDContract.balanceOf(account1);
												assert.equal(rUSDBalance, '0');

												const debtBalance = await rwaone.debtBalanceOf(account1, rUSD);
												assert.equal(debtBalance, '0');
											});
										});
									});
									describe('and the sEUR price decreases by 20% to 1', () => {
										beforeEach(async () => {
											await updateAggregatorRates(
												exchangeRates,
												circuitBreaker,
												[sEUR],
												['1'].map(toUnit)
											);
											await updateDebtMonitors();
										});
										describe('and 60s elapses', () => {
											beforeEach(async () => {
												fastForward(60);
											});
											describe('when they attempt to burn the entire amount rUSD', () => {
												let txn;
												beforeEach(async () => {
													txn = await rwaone.burnRwas(amount, { from: account1 });
												});
												it('then it succeeds and burns their rUSD minus the reclaim amount from settlement', async () => {
													const logs = await getDecodedLogs({
														hash: txn.tx,
														contracts: [rwaone, rUSDContract],
													});

													decodedEventEqual({
														event: 'Burned',
														emittedFrom: rUSDContract.address,
														args: [account1, amount.sub(toUnit('250'))],
														log: logs
															.reverse()
															.filter(l => !!l)
															.find(({ name }) => name === 'Burned'),
													});

													const rUSDBalance = await rUSDContract.balanceOf(account1);
													assert.equal(rUSDBalance, '0');
												});
												it('and their debt balance is now 0 because they are the only debt holder in the system', async () => {
													// the debt balance remaining is what was reclaimed from the exchange
													const debtBalance = await rwaone.debtBalanceOf(account1, rUSD);
													// because this user is the only one holding debt, when we burn 250 rUSD in a reclaim,
													// it removes it from the totalIssuedRwas and
													assert.equal(debtBalance, '0');
												});
											});
											describe('when another user also has the same amount of debt', () => {
												beforeEach(async () => {
													await rwaone.transfer(account2, toUnit('1000000'), { from: owner });
													await rwaone.issueRwas(amount, { from: account2 });
												});
												describe('when the first user attempts to burn the entire amount rUSD', () => {
													let txn;
													beforeEach(async () => {
														txn = await rwaone.burnRwas(amount, { from: account1 });
													});
													it('then it succeeds and burns their rUSD minus the reclaim amount from settlement', async () => {
														const logs = await getDecodedLogs({
															hash: txn.tx,
															contracts: [rwaone, rUSDContract],
														});

														decodedEventEqual({
															event: 'Burned',
															emittedFrom: rUSDContract.address,
															args: [account1, amount.sub(toUnit('250'))],
															log: logs
																.reverse()
																.filter(l => !!l)
																.find(({ name }) => name === 'Burned'),
														});

														const rUSDBalance = await rUSDContract.balanceOf(account1);
														assert.equal(rUSDBalance, '0');
													});
													it('and their debt balance is now half of the reclaimed balance because they owe half of the pool', async () => {
														// the debt balance remaining is what was reclaimed from the exchange
														const debtBalance = await rwaone.debtBalanceOf(account1, rUSD);
														// because this user is holding half the debt, when we burn 250 rUSD in a reclaim,
														// it removes it from the totalIssuedRwas and so both users have half of 250
														// in owing rwas
														assert.bnClose(debtBalance, divideDecimal('250', 2), '100000');
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});

			describe('debt calculation in multi-issuance scenarios', () => {
				it('should correctly calculate debt in a multi-issuance scenario', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedRwasPt1 = toUnit('2000');
					const issuedRwasPt2 = toUnit('2000');
					await rwaone.issueRwas(issuedRwasPt1, { from: account1 });
					await rwaone.issueRwas(issuedRwasPt2, { from: account1 });
					await rwaone.issueRwas(toUnit('1000'), { from: account2 });

					const debt = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				it('should correctly calculate debt in a multi-issuance multi-burn scenario', async () => {
					// Give some wRWAX to account1
					await rwaone.transfer(account1, toUnit('500000'), {
						from: owner,
					});
					await rwaone.transfer(account2, toUnit('14000'), {
						from: owner,
					});

					// Issue
					const issuedRwasPt1 = toUnit('2000');
					const burntRwasPt1 = toUnit('1500');
					const issuedRwasPt2 = toUnit('1600');
					const burntRwasPt2 = toUnit('500');

					await rwaone.issueRwas(issuedRwasPt1, { from: account1 });
					await rwaone.burnRwas(burntRwasPt1, { from: account1 });
					await rwaone.issueRwas(issuedRwasPt2, { from: account1 });

					await rwaone.issueRwas(toUnit('100'), { from: account2 });
					await rwaone.issueRwas(toUnit('51'), { from: account2 });
					await rwaone.burnRwas(burntRwasPt2, { from: account1 });

					const debt = await rwaone.debtBalanceOf(account1, toBytes32('rUSD'));
					const expectedDebt = issuedRwasPt1
						.add(issuedRwasPt2)
						.sub(burntRwasPt1)
						.sub(burntRwasPt2);

					assert.bnClose(debt, expectedDebt, '100000');
				});

				it("should allow me to burn all rwas I've issued when there are other issuers", async () => {
					const totalSupply = await rwaone.totalSupply();
					const account2Rwaones = toUnit('120000');
					const account1Rwaones = totalSupply.sub(account2Rwaones);

					await rwaone.transfer(account1, account1Rwaones, {
						from: owner,
					}); // Issue the massive majority to account1
					await rwaone.transfer(account2, account2Rwaones, {
						from: owner,
					}); // Issue a small amount to account2

					// Issue from account1
					const account1AmountToIssue = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueMaxRwas({ from: account1 });
					const debtBalance1 = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					// Issue and burn from account 2 all debt
					await rwaone.issueRwas(toUnit('43'), { from: account2 });
					let debt = await rwaone.debtBalanceOf(account2, rUSD);

					// due to rounding it may be necessary to supply higher than originally issued rwas
					await rUSDContract.transfer(account2, toUnit('1'), {
						from: account1,
					});
					await rwaone.burnRwas(toUnit('44'), { from: account2 });
					debt = await rwaone.debtBalanceOf(account2, rUSD);

					assert.bnEqual(debt, 0);
				});
			});

			// These tests take a long time to run
			// ****************************************
			describe('multiple issue and burn scenarios', () => {
				it('should correctly calculate debt in a high issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await rwaone.totalSupply();
					const account2Rwaones = toUnit('120000');
					const account1Rwaones = totalSupply.sub(account2Rwaones);

					await rwaone.transfer(account1, account1Rwaones, {
						from: owner,
					}); // Issue the massive majority to account1
					await rwaone.transfer(account2, account2Rwaones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueMaxRwas({ from: account1 });
					const debtBalance1 = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit('43');
						await rwaone.issueRwas(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(4, 14)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await rwaone.burnRwas(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await rwaone.debtBalanceOf(account2, rUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await rwaone.debtBalanceOf(account2, rUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000'));
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high (random) issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await rwaone.totalSupply();
					const account2Rwaones = toUnit('120000');
					const account1Rwaones = totalSupply.sub(account2Rwaones);

					await rwaone.transfer(account1, account1Rwaones, {
						from: owner,
					}); // Issue the massive majority to account1
					await rwaone.transfer(account2, account2Rwaones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueMaxRwas({ from: account1 });
					const debtBalance1 = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit(web3.utils.toBN(getRandomInt(40, 49)));
						await rwaone.issueRwas(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(37, 46)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await rwaone.burnRwas(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await rwaone.debtBalanceOf(account2, rUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await rwaone.debtBalanceOf(account2, rUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000')); // max 0.1 gwei of drift per op
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high volume contrast issuance and burn scenario', async () => {
					const totalSupply = await rwaone.totalSupply();

					// Give only 100 Rwaone to account2
					const account2Rwaones = toUnit('100');

					// Give the vast majority to account1 (ie. 99,999,900)
					const account1Rwaones = totalSupply.sub(account2Rwaones);

					await rwaone.transfer(account1, account1Rwaones, {
						from: owner,
					}); // Issue the massive majority to account1
					await rwaone.transfer(account2, account2Rwaones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueMaxRwas({ from: account1 });
					const debtBalance1 = await rwaone.debtBalanceOf(account1, rUSD);
					assert.bnEqual(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						const amount = toUnit('0.000000000000000002');
						await rwaone.issueRwas(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);
					}
					const debtBalance2 = await rwaone.debtBalanceOf(account2, rUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance2, expectedDebtForAccount2, variance);
				}).timeout(60e3);
			});

			// ****************************************

			it("should prevent more issuance if the user's collaterisation changes to be insufficient", async () => {
				// disable dynamic fee here as it will prevent exchange due to fees spiking too much
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				// Set sEUR for purposes of this test
				await updateAggregatorRates(exchangeRates, circuitBreaker, [sEUR], [toUnit('0.75')]);
				await updateDebtMonitors();

				const issuedRwaones = web3.utils.toBN('200000');
				await rwaone.transfer(account1, toUnit(issuedRwaones), {
					from: owner,
				});

				const maxIssuableRwas = await rwaone.maxIssuableRwas(account1);

				// Issue
				const rwasToNotIssueYet = web3.utils.toBN('2000');
				const issuedRwas = maxIssuableRwas.sub(rwasToNotIssueYet);
				await rwaone.issueRwas(issuedRwas, { from: account1 });

				// exchange into sEUR
				await rwaone.exchange(rUSD, issuedRwas, sEUR, { from: account1 });

				// Increase the value of sEUR relative to rwaone
				await updateAggregatorRates(exchangeRates, null, [sEUR], [toUnit('1.1')]);
				await updateDebtMonitors();

				await assert.revert(
					rwaone.issueRwas(rwasToNotIssueYet, { from: account1 }),
					'Amount too large'
				);
			});

			// Check user's collaterisation ratio

			describe('check collaterisation ratio', () => {
				const duration = 52 * WEEK;
				beforeEach(async () => {
					// setup rewardEscrowV2 with mocked feePool address
					await addressResolver.importAddresses([toBytes32('FeePool')], [account6], {
						from: owner,
					});

					// update the cached addresses
					await rewardEscrowV2.rebuildCache({ from: owner });
				});
				it('should return 0 if user has no rwaone when checking the collaterisation ratio', async () => {
					const ratio = await rwaone.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('Any user can check the collaterisation ratio for a user', async () => {
					const issuedRwaones = web3.utils.toBN('320000');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					// Issue
					const issuedRwas = toUnit(web3.utils.toBN('6400'));
					await rwaone.issueRwas(issuedRwas, { from: account1 });

					await rwaone.collateralisationRatio(account1, { from: account2 });
				});

				it('should be able to read collaterisation ratio for a user with rwaone but no debt', async () => {
					const issuedRwaones = web3.utils.toBN('30000');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					const ratio = await rwaone.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('should be able to read collaterisation ratio for a user with rwaone and debt', async () => {
					const issuedRwaones = web3.utils.toBN('320000');
					await rwaone.transfer(account1, toUnit(issuedRwaones), {
						from: owner,
					});

					// Issue
					const issuedRwas = toUnit(web3.utils.toBN('6400'));
					await rwaone.issueRwas(issuedRwas, { from: account1 });

					const ratio = await rwaone.collateralisationRatio(account1, { from: account2 });
					assert.unitEqual(ratio, '0.2');
				});

				it("should not include escrowed rwaone when calculating a user's collaterisation ratio", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);
					const transferredRwaones = toUnit('60000');
					await rwaone.transfer(account1, transferredRwaones, {
						from: owner,
					});

					// Setup escrow
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedRwaones = toUnit('30000');
					await rwaone.transfer(escrow.address, escrowedRwaones, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedRwaones,
						{
							from: owner,
						}
					);

					// Issue
					const maxIssuable = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueRwas(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await rwaone.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(transferredRwaones, snx2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it("should include escrowed reward rwaone when calculating a user's collateralisation ratio", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);
					const transferredRwaones = toUnit('60000');
					await rwaone.transfer(account1, transferredRwaones, {
						from: owner,
					});

					const escrowedRwaones = toUnit('30000');
					await rwaone.transfer(rewardEscrowV2.address, escrowedRwaones, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedRwaones, duration, {
						from: account6,
					});

					// Issue
					const maxIssuable = await rwaone.maxIssuableRwas(account1);
					await rwaone.issueRwas(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await rwaone.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(escrowedRwaones.add(transferredRwaones), snx2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it('should permit user to issue rUSD debt with only escrowed wRWAX as collateral (no wRWAX in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await rwaone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no wRWAX balance
					const snxBalance = await rwaone.balanceOf(account1);
					assert.bnEqual(snxBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await rwaone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral should include escrowed amount
					collateral = await rwaone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max rwas. (300 rUSD)
					await rwaone.issueMaxRwas({ from: account1 });

					// There should be 300 rUSD of value for account1
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('300'));
				});

				it('should permit user to issue rUSD debt with only reward escrow as collateral (no wRWAX in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await rwaone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no wRWAX balance
					const snxBalance = await rwaone.balanceOf(account1);
					assert.bnEqual(snxBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await rwaone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral now should include escrowed amount
					collateral = await rwaone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max rwas. (300 rUSD)
					await rwaone.issueMaxRwas({ from: account1 });

					// There should be 300 rUSD of value for account1
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('300'));
				});

				it("should permit anyone checking another user's collateral", async () => {
					const amount = toUnit('60000');
					await rwaone.transfer(account1, amount, { from: owner });
					const collateral = await rwaone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should not include escrowed rwaone when checking a user's collateral", async () => {
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedAmount = toUnit('15000');
					await rwaone.transfer(escrow.address, escrowedAmount, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedAmount,
						{
							from: owner,
						}
					);

					const amount = toUnit('60000');
					await rwaone.transfer(account1, amount, { from: owner });
					const collateral = await rwaone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should include escrowed reward rwaone when checking a user's collateral", async () => {
					const escrowedAmount = toUnit('15000');
					await rwaone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});
					const amount = toUnit('60000');
					await rwaone.transfer(account1, amount, { from: owner });
					const collateral = await rwaone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount.add(escrowedAmount));
				});

				it("should calculate a user's remaining issuable rwas", async () => {
					const transferredRwaones = toUnit('60000');
					await rwaone.transfer(account1, transferredRwaones, {
						from: owner,
					});

					// Issue
					const maxIssuable = await rwaone.maxIssuableRwas(account1);
					const issued = maxIssuable.div(web3.utils.toBN(3));
					await rwaone.issueRwas(issued, { from: account1 });
					const expectedRemaining = maxIssuable.sub(issued);
					const issuableRwas = await issuer.remainingIssuableRwas(account1);
					assert.bnEqual(expectedRemaining, issuableRwas.maxIssuable);
				});

				it("should correctly calculate a user's max issuable rwas with escrowed rwaone", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wRWAX);
					const transferredRwaones = toUnit('60000');
					await rwaone.transfer(account1, transferredRwaones, {
						from: owner,
					});

					// Setup escrow
					const escrowedRwaones = toUnit('30000');
					await rwaone.transfer(rewardEscrowV2.address, escrowedRwaones, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedRwaones, duration, {
						from: account6,
					});

					const maxIssuable = await rwaone.maxIssuableRwas(account1);
					// await rwaone.issueRwas(maxIssuable, { from: account1 });

					// Compare
					const issuanceRatio = await systemSettings.issuanceRatio();
					const expectedMaxIssuable = multiplyDecimal(
						multiplyDecimal(escrowedRwaones.add(transferredRwaones), snx2usdRate),
						issuanceRatio
					);
					assert.bnEqual(maxIssuable, expectedMaxIssuable);
				});
			});

			describe('issue and burn on behalf', async () => {
				const authoriser = account1;
				const delegate = account2;

				beforeEach(async () => {
					// Assign the authoriser wRWAX
					await rwaone.transfer(authoriser, toUnit('20000'), {
						from: owner,
					});
					await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], [toUnit('1')]);
					await updateDebtMonitors();
				});
				describe('when not approved it should revert on', async () => {
					it('issueMaxRwasOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: rwaone.issueMaxRwasOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('issueRwasOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: rwaone.issueRwasOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnRwasOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: rwaone.burnRwasOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnRwasToTargetOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: rwaone.burnRwasToTargetOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
				});

				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							// ensure user has rwas to burn
							await rwaone.issueRwas(toUnit('1000'), { from: authoriser });
							await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
							await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling issueRwasOnBehalf() reverts', async () => {
							await assert.revert(
								rwaone.issueRwasOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling issueMaxRwasOnBehalf() reverts', async () => {
							await assert.revert(
								rwaone.issueMaxRwasOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnRwasOnBehalf() reverts', async () => {
							await assert.revert(
								rwaone.burnRwasOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnRwasToTargetOnBehalf() reverts', async () => {
							await assert.revert(
								rwaone.burnRwasToTargetOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});

						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling issueRwasOnBehalf() succeeds', async () => {
								await rwaone.issueRwasOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling issueMaxRwasOnBehalf() succeeds', async () => {
								await rwaone.issueMaxRwasOnBehalf(authoriser, { from: delegate });
							});
							it('and calling burnRwasOnBehalf() succeeds', async () => {
								await rwaone.burnRwasOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling burnRwasToTargetOnBehalf() succeeds', async () => {
								// need the user to be undercollaterized for this to succeed
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[wRWAX],
									[toUnit('0.001')]
								);
								await updateDebtMonitors();

								await rwaone.burnRwasToTargetOnBehalf(authoriser, { from: delegate });
							});
						});
					});
				});

				it('should approveIssueOnBehalf for account1', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canIssueFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveBurnOnBehalf for account1', async () => {
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canBurnFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveIssueOnBehalf and IssueMaxRwas', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					const rUSDBalanceBefore = await rUSDContract.balanceOf(account1);
					const issuableRwas = await rwaone.maxIssuableRwas(account1);

					await rwaone.issueMaxRwasOnBehalf(authoriser, { from: delegate });
					const rUSDBalanceAfter = await rUSDContract.balanceOf(account1);
					assert.bnEqual(rUSDBalanceAfter, rUSDBalanceBefore.add(issuableRwas));
				});
				it('should approveIssueOnBehalf and IssueRwas', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					await rwaone.issueRwasOnBehalf(authoriser, toUnit('100'), { from: delegate });

					const rUSDBalance = await rUSDContract.balanceOf(account1);
					assert.bnEqual(rUSDBalance, toUnit('100'));
				});
				it('should approveBurnOnBehalf and BurnRwas', async () => {
					await rwaone.issueMaxRwas({ from: authoriser });
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					const rUSDBalanceBefore = await rUSDContract.balanceOf(account1);
					await rwaone.burnRwasOnBehalf(authoriser, rUSDBalanceBefore, { from: delegate });

					const rUSDBalance = await rUSDContract.balanceOf(account1);
					assert.bnEqual(rUSDBalance, toUnit('0'));
				});
				it('should approveBurnOnBehalf and burnRwasToTarget', async () => {
					await rwaone.issueMaxRwas({ from: authoriser });
					await updateAggregatorRates(exchangeRates, circuitBreaker, [wRWAX], [toUnit('0.01')]);
					await updateDebtMonitors();

					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					await rwaone.burnRwasToTargetOnBehalf(authoriser, { from: delegate });

					const rUSDBalanceAfter = await rUSDContract.balanceOf(account1);
					assert.bnEqual(rUSDBalanceAfter, toUnit('40'));
				});
			});

			describe('when Wrapper is set', async () => {
				it('should have zero totalIssuedRwas', async () => {
					assert.bnEqual(
						await rwaone.totalIssuedRwas(rUSD),
						await rwaone.totalIssuedRwasExcludeOtherCollateral(rUSD)
					);
				});
				describe('depositing WETH on the Wrapper to issue rETH', async () => {
					let etherWrapper;
					beforeEach(async () => {
						// mock etherWrapper
						etherWrapper = await MockEtherWrapper.new({ from: owner });
						await addressResolver.importAddresses(
							[toBytes32('EtherWrapper')],
							[etherWrapper.address],
							{ from: owner }
						);

						// ensure DebtCache has the latest EtherWrapper
						await debtCache.rebuildCache();
					});

					it('should be able to exclude rETH issued by EtherWrapper from totalIssuedRwas', async () => {
						const totalSupplyBefore = await rwaone.totalIssuedRwas(rETH);

						const amount = toUnit('10');

						await etherWrapper.setTotalIssuedRwas(amount, { from: account1 });

						// totalSupply of rwas should exclude Wrapper issued rETH
						assert.bnEqual(
							totalSupplyBefore,
							await rwaone.totalIssuedRwasExcludeOtherCollateral(rETH)
						);

						// totalIssuedRwas after includes amount issued
						const { rate } = await exchangeRates.rateAndInvalid(rETH);
						assert.bnEqual(
							await rwaone.totalIssuedRwas(rETH),
							totalSupplyBefore.add(divideDecimalRound(amount, rate))
						);
					});
				});
			});

			describe('burnForRedemption', () => {
				it('only allowed by the rwa redeemer', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: issuer.burnForRedemption,
						args: [ZERO_ADDRESS, ZERO_ADDRESS, toUnit('1')],
						accounts,
						reason: 'Only RwaRedeemer',
					});
				});
				describe('when a user has 100 rETH', () => {
					beforeEach(async () => {
						await rETHContract.issue(account1, toUnit('100'));
						await updateDebtMonitors();
					});
					describe('when burnForRedemption is invoked on the user for 75 rETH', () => {
						beforeEach(async () => {
							// spoof the rwa redeemer
							await addressResolver.importAddresses([toBytes32('RwaRedeemer')], [account6], {
								from: owner,
							});
							// rebuild the resolver cache in the issuer
							await issuer.rebuildCache();
							// now invoke the burn
							await issuer.burnForRedemption(await rETHContract.proxy(), account1, toUnit('75'), {
								from: account6,
							});
						});
						it('then the user has 25 rETH remaining', async () => {
							assert.bnEqual(await rETHContract.balanceOf(account1), toUnit('25'));
						});
					});
				});
			});

			describe('debt shares integration', async () => {
				let aggTDR;

				beforeEach(async () => {
					// create aggregator mocks
					aggTDR = await MockAggregator.new({ from: owner });

					// Set debt ratio oracle value
					await aggTDR.setLatestAnswer(toPreciseUnit('0.4'), await currentTime());

					await addressResolver.importAddresses(
						[toBytes32('ext:AggregatorDebtRatio')],
						[aggTDR.address],
						{
							from: owner,
						}
					);

					// rebuild the resolver cache in the issuer
					await issuer.rebuildCache();

					// issue some initial debt to work with
					await rwaone.issueRwas(toUnit('100'), { from: owner });

					// send test user some snx so he can mint too
					await rwaone.transfer(account1, toUnit('1000000'), { from: owner });
				});

				it('mints the correct number of debt shares', async () => {
					// Issue rwas
					await rwaone.issueRwas(toUnit('100'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('250')); // = 100 / 0.4
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('100'));
				});

				it('burns the correct number of debt shares', async () => {
					await rwaone.issueRwas(toUnit('300'), { from: account1 });
					await rwaone.burnRwas(toUnit('30'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // = 270 / 0.4
					assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('270'));
				});

				describe('when debt ratio changes', () => {
					beforeEach(async () => {
						// user mints and gets 300 rusd / 0.4 = 750 debt shares
						await rwaone.issueRwas(toUnit('300'), { from: account1 });

						// Debt ratio oracle value is updated
						await aggTDR.setLatestAnswer(toPreciseUnit('0.6'), await currentTime());
					});

					it('has adjusted debt', async () => {
						assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('450')); // = 750 sds * 0.6
					});

					it('mints at adjusted rate', async () => {
						await rwaone.issueRwas(toUnit('300'), { from: account1 });

						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('1250')); // = 750 (shares from before) + 300 / 0.6
						assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('750')); // = 450 (rUSD from before ) + 300
					});
				});

				describe('issued rwas aggregator', async () => {
					let aggTIS;
					beforeEach(async () => {
						// create aggregator mocks
						aggTIS = await MockAggregator.new({ from: owner });

						// Set issued rwas oracle value
						await aggTIS.setLatestAnswer(toPreciseUnit('1234123412341234'), await currentTime());

						await addressResolver.importAddresses(
							[toBytes32('ext:AggregatorIssuedRwas')],
							[aggTIS.address],
							{
								from: owner,
							}
						);
					});

					it('has no effect on mint or burn', async () => {
						// user mints and gets 300 rusd  / 0.4 = 750 debt shares
						await rwaone.issueRwas(toUnit('300'), { from: account1 });
						// user burns 30 rusd / 0.4 = 75 debt shares
						await rwaone.burnRwas(toUnit('30'), { from: account1 });
						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // 750 - 75 sds
						assert.bnEqual(await rwaone.debtBalanceOf(account1, rUSD), toUnit('270')); // 300 - 30 rusd
					});
				});
			});

			describe('upgradeCollateralShort', () => {
				const collateralShortMock = account1;
				const wrongCollateralShort = account2;

				beforeEach(async () => {
					// Import CollateralShortLegacy address (mocked)
					await addressResolver.importAddresses(
						[toBytes32('CollateralShortLegacy')],
						[collateralShortMock],
						{
							from: owner,
						}
					);

					await exchanger.rebuildCache();
				});

				describe('basic protection', () => {
					it('should not allow an invalid address for the CollateralShortLegacy', async () => {
						await assert.revert(
							issuer.upgradeCollateralShort(wrongCollateralShort, toUnit(0.1), { from: owner }),
							'wrong address'
						);
					});

					it('should not allow 0 as amount', async () => {
						await assert.revert(
							issuer.upgradeCollateralShort(collateralShortMock, toUnit(0), {
								from: owner,
							}),
							'cannot burn 0 rwas'
						);
					});
				});

				describe('migrates balance', () => {
					let beforeCurrentDebt, beforeRUSDBalance;
					const amountToBurn = toUnit(10);

					beforeEach(async () => {
						// Give some wRWAX to collateralShortMock
						await rwaone.transfer(collateralShortMock, toUnit('1000'), { from: owner });

						// issue max rUSD
						const maxRwas = await rwaone.maxIssuableRwas(collateralShortMock);
						await rwaone.issueRwas(maxRwas, { from: collateralShortMock });

						// get before* values
						beforeRUSDBalance = await rUSDContract.balanceOf(collateralShortMock);
						const currentDebt = await debtCache.currentDebt();
						beforeCurrentDebt = currentDebt['0'];

						// call upgradeCollateralShort
						await issuer.upgradeCollateralShort(collateralShortMock, amountToBurn, {
							from: owner,
						});
					});

					it('burns rwas', async () => {
						assert.bnEqual(
							await rUSDContract.balanceOf(collateralShortMock),
							beforeRUSDBalance.sub(amountToBurn)
						);
					});

					it('reduces currentDebt', async () => {
						const currentDebt = await debtCache.currentDebt();
						assert.bnEqual(currentDebt['0'], beforeCurrentDebt.sub(amountToBurn));
					});
				});
			});

			describe('modifyDebtSharesForMigration', () => {
				const debtMigratorOnEthereumMock = account1;
				const debtMigratorOnOptimismMock = account2;
				const fakeMigrator = account3;

				beforeEach(async () => {
					// Import mocked debt migrator addresses to the resolver
					await addressResolver.importAddresses(
						[toBytes32('DebtMigratorOnEthereum'), toBytes32('DebtMigratorOnOptimism')],
						[debtMigratorOnEthereumMock, debtMigratorOnOptimismMock],
						{
							from: owner,
						}
					);

					await issuer.rebuildCache();
				});

				describe('basic protection', () => {
					it('should not allow an invalid migrator address', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(owner, toUnit(1), { from: fakeMigrator }),
							'only trusted migrators'
						);
					});

					it('should not allow both debt migrators to be set on the same layer', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(account1, toUnit(100), {
								from: debtMigratorOnEthereumMock,
							}),
							'one migrator must be 0x0'
						);
					});
				});

				describe('modifying debt share balance for migration', () => {
					describe('on L1', () => {
						let beforeDebtShareBalance;
						const amountToBurn = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Optimism migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnOptimism')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// Give some wRWAX to the mock migrator
							await rwaone.transfer(debtMigratorOnEthereumMock, toUnit('1000'), { from: owner });

							// issue max rUSD
							const maxRwas = await rwaone.maxIssuableRwas(debtMigratorOnEthereumMock);
							await rwaone.issueRwas(maxRwas, { from: debtMigratorOnEthereumMock });

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnEthereumMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnEthereumMock, amountToBurn, {
								from: debtMigratorOnEthereumMock,
							});
						});

						it('burns the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnEthereumMock),
								beforeDebtShareBalance.sub(amountToBurn)
							);
						});
					});
					describe('on L2', () => {
						let beforeDebtShareBalance;
						const amountToMint = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Ethereum migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnEthereum')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnOptimismMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnOptimismMock, amountToMint, {
								from: debtMigratorOnOptimismMock,
							});
						});

						it('mints the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnOptimismMock),
								beforeDebtShareBalance.add(amountToMint)
							);
						});
					});
				});
			});
		});
	});
});
