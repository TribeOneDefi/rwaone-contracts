'use strict';

const { artifacts, contract, web3 } = require('hardhat');
const { smock } = require('@defi-wonderland/smock');
const BN = require('bn.js');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('../contracts/common');
const { expect } = require('chai');

const ethers = require('ethers');

const {
	currentTime,
	fastForward,
	multiplyDecimal,
	divideDecimal,
	toUnit,
	toBN,
} = require('../utils')();

const {
	setupAllContracts,
	constantsOverrides: {
		EXCHANGE_DYNAMIC_FEE_ROUNDS,
		EXCHANGE_DYNAMIC_FEE_WEIGHT_DECAY,
		EXCHANGE_DYNAMIC_FEE_THRESHOLD,
		EXCHANGE_MAX_DYNAMIC_FEE,
	},
} = require('../contracts/setup');

const {
	getDecodedLogs,
	decodedEventEqual,
	timeIsClose,
	onlyGivenAddressCanInvoke,
	setStatus,
	convertToAggregatorPrice,
	updateRatesWithDefaults,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');

const {
	toBytes32,
	defaults: { WAITING_PERIOD_SECS, PRICE_DEVIATION_THRESHOLD_FACTOR, ATOMIC_MAX_VOLUME_PER_BLOCK },
} = require('../..');

const bnCloseVariance = '30';

const MockAggregator = artifacts.require('MockAggregatorV2V3');
const MockDexPriceAggregator = artifacts.require('MockDexPriceAggregator');
const MockToken = artifacts.require('MockToken');

contract('Exchanger (spec tests)', async accounts => {
	const [rUSD, sAUD, sEUR, wRWAX, rBTC, iBTC, rETH, iETH] = [
		'rUSD',
		'sAUD',
		'sEUR',
		'wRWAX',
		'rBTC',
		'iBTC',
		'rETH',
		'iETH',
	].map(toBytes32);

	const trackingCode = toBytes32('1INCH');

	const rwaKeys = [rUSD, sAUD, sEUR, rBTC, iBTC, rETH, iETH];

	const [, owner, account1, account2, account3] = accounts;

	let rwaone,
		exchangeRates,
		feePool,
		delegateApprovals,
		directIntegration,
		rUSDContract,
		sAUDContract,
		sEURContract,
		rBTCContract,
		rETHContract,
		exchanger,
		exchangeState,
		exchangeFeeRate,
		amountIssued,
		systemSettings,
		systemStatus,
		resolver,
		debtCache,
		issuer,
		circuitBreaker,
		flexibleStorage;

	async function changeOneDISetting(
		index,
		value,
		rwas = [rUSD, sAUD, sEUR, wRWAX, rBTC, iBTC, rETH, iETH]
	) {
		for (const rwa of rwas) {
			for (const account of [owner, account1, account2]) {
				const existingParameters = Array.from(
					await directIntegration.getExchangeParameters(account, rwa)
				);
				// the parameter for `exchangeFeeRates` is currently in the 8th position (and probably will be until the end of v2x)
				existingParameters[index] = value;
				await directIntegration.setExchangeParameters(account, [rwa], existingParameters, {
					from: owner,
				});
			}
		}
	}

	async function setDexPriceAggregator(aggregator) {
		if (directIntegration) {
			await changeOneDISetting(1, aggregator);
		} else {
			await exchangeRates.setDexPriceAggregator(aggregator, { from: owner });
		}
	}

	async function setAtomicEquivalentForDexPricing(token, address) {
		if (directIntegration) {
			await changeOneDISetting(2, address, [token]);
		} else {
			await systemSettings.setAtomicEquivalentForDexPricing(token, address, { from: owner });
		}
	}

	async function setAtomicExchangeFeeRate(token, rate) {
		if (directIntegration) {
			await changeOneDISetting(3, rate, [token]);
		} else {
			await systemSettings.setAtomicExchangeFeeRate(token, rate, { from: owner });
		}
	}

	// async function setAtomicTwapWindow(window) {
	// 	if (directIntegration) {
	// 		await changeOneDISetting(4, window);
	// 	} else {
	// 		await systemSettings.setAtomicTwapWindow(window, { from: owner });
	// 	}
	// }

	// async function setAtomicMaxVolumePerBlock(vol) {
	// 	if (directIntegration) {
	// 		await changeOneDISetting(5, vol);
	// 	} else {
	// 		await systemSettings.setAtomicMaxVolumePerBlock(vol, { from: owner });
	// 	}
	// }

	async function setAtomicVolatilityConsiderationWindow(token, window) {
		if (directIntegration) {
			await changeOneDISetting(6, window, [token]);
		} else {
			await systemSettings.setAtomicVolatilityConsiderationWindow(token, window, {
				from: owner,
			});
		}
	}

	async function setAtomicVolatilityUpdateThreshold(token, threshold) {
		if (directIntegration) {
			await changeOneDISetting(7, threshold, [token]);
		} else {
			await systemSettings.setAtomicVolatilityUpdateThreshold(token, threshold, { from: owner });
		}
	}

	async function setExchangeFeeRateForRwas({
		owner,
		systemSettings,
		rwaKeys,
		exchangeFeeRates,
	}) {
		if (directIntegration) {
			for (const i in rwaKeys) {
				await changeOneDISetting(8, exchangeFeeRates[i], [rwaKeys[i]]);
			}
		} else {
			await systemSettings.setExchangeFeeRateForRwas(rwaKeys, exchangeFeeRates, {
				from: owner,
			});
		}
	}

	// async function setExchangeMaxDynamicFee(fee) {
	// 	if (directIntegration) {
	// 		await changeOneDISetting(9, fee);
	// 	} else {
	// 		await systemSettings.setExchangeMaxDynamicFee(fee, { from: owner });
	// 	}
	// }

	async function setExchangeDynamicFeeRounds(rounds) {
		if (directIntegration) {
			await changeOneDISetting(10, rounds);
		} else {
			await systemSettings.setExchangeDynamicFeeRounds(rounds, { from: owner });
		}
	}

	// async function setExchangeDynamicFeeThreshold(threshold) {
	// 	if (directIntegration) {
	// 		await changeOneDISetting(11, threshold);
	// 	} else {
	// 		await systemSettings.setExchangeDynamicFeeThreshold(threshold, { from: owner });
	// 	}
	// }

	// async function setExchangeDynamicFeeWeightDecay(decay) {
	// 	if (directIntegration) {
	// 		await changeOneDISetting(12, decay);
	// 	} else {
	// 		await systemSettings.setExchangeDynamicFeeWeightDecay(decay, { from: owner });
	// 	}
	// }

	const itReadsTheWaitingPeriod = () => {
		describe('waitingPeriodSecs', () => {
			it('the default is configured correctly', async () => {
				// Note: this only tests the effectiveness of the setup script, not the deploy script,
				assert.equal(await exchanger.waitingPeriodSecs(), WAITING_PERIOD_SECS);
			});
			describe('given it is configured to 90', () => {
				beforeEach(async () => {
					await systemSettings.setWaitingPeriodSecs('90', { from: owner });
				});
				describe('and there is an exchange', () => {
					beforeEach(async () => {
						await rwaone.exchange(rUSD, toUnit('100'), sEUR, { from: account1 });
					});
					it('then the maxSecsLeftInWaitingPeriod is close to 90', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
						timeIsClose({ actual: maxSecs, expected: 90, variance: 2 });
					});
					describe('and 87 seconds elapses', () => {
						// Note: timestamp accurancy can't be guaranteed, so provide a few seconds of buffer either way
						beforeEach(async () => {
							await fastForward(87);
						});
						describe('when settle() is called', () => {
							it('then it reverts', async () => {
								await assert.revert(
									rwaone.settle(sEUR, { from: account1 }),
									'Cannot settle during waiting period'
								);
							});
							it('and the maxSecsLeftInWaitingPeriod is close to 1', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
								timeIsClose({ actual: maxSecs, expected: 1, variance: 2 });
							});
						});
						describe('when a further 5 seconds elapse', () => {
							beforeEach(async () => {
								await fastForward(5);
							});
							describe('when settle() is called', () => {
								it('it successed', async () => {
									await rwaone.settle(sEUR, { from: account1 });
								});
							});
						});
					});
				});
			});
		});
	};

	const itWhenTheWaitingPeriodIsZero = () => {
		describe('When the waiting period is set to 0', () => {
			let initialWaitingPeriod;

			beforeEach(async () => {
				// disable dynamic fee here as it's testing settlement
				await setExchangeDynamicFeeRounds('1');

				initialWaitingPeriod = await systemSettings.waitingPeriodSecs();
				await systemSettings.setWaitingPeriodSecs('0', { from: owner });
			});

			it('is set correctly', async () => {
				assert.bnEqual(await systemSettings.waitingPeriodSecs(), '0');
			});

			describe('When exchanging', () => {
				const amountOfSrcExchanged = toUnit('10');

				beforeEach(async () => {
					await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
					await rUSDContract.issue(owner, toUnit('100'));
					await rwaone.exchange(rUSD, toUnit('10'), rETH, { from: owner });
				});

				it('creates no new entries', async () => {
					let { numEntries } = await exchanger.settlementOwing(owner, rETH);
					assert.bnEqual(numEntries, '0');
					numEntries = await exchangeState.getLengthOfEntries(owner, rETH);
					assert.bnEqual(numEntries, '0');
				});

				it('can exchange back without waiting', async () => {
					const { amountReceived } = await exchanger.getAmountsForExchange(
						amountOfSrcExchanged,
						rUSD,
						rETH,
						{ from: owner }
					);
					await rwaone.exchange(rETH, amountReceived, rUSD, { from: owner });
					assert.bnEqual(await rETHContract.balanceOf(owner), '0');
				});

				describe('When the waiting period is switched on again', () => {
					beforeEach(async () => {
						await systemSettings.setWaitingPeriodSecs(initialWaitingPeriod, { from: owner });
					});

					it('is set correctly', async () => {
						assert.bnEqual(await systemSettings.waitingPeriodSecs(), initialWaitingPeriod);
					});

					describe('a new exchange takes place', () => {
						let exchangeTransaction;

						beforeEach(async () => {
							await fastForward(await systemSettings.waitingPeriodSecs());
							exchangeTransaction = await rwaone.exchange(rUSD, amountOfSrcExchanged, rETH, {
								from: owner,
							});
						});

						it('creates a new entry', async () => {
							const { numEntries } = await exchanger.settlementOwing(owner, rETH);
							assert.bnEqual(numEntries, '1');
						});

						it('then it emits an ExchangeEntryAppended', async () => {
							const { amountReceived, exchangeFeeRate } = await exchanger.getAmountsForExchange(
								amountOfSrcExchanged,
								rUSD,
								rETH,
								{
									from: owner,
								}
							);
							const logs = await getDecodedLogs({
								hash: exchangeTransaction.tx,
								contracts: [rwaone, exchanger, rUSDContract, issuer, flexibleStorage, debtCache],
							});
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
								event: 'ExchangeEntryAppended',
								emittedFrom: exchanger.address,
								args: [
									owner,
									rUSD,
									amountOfSrcExchanged,
									rETH,
									amountReceived,
									exchangeFeeRate,
									new web3.utils.BN(1),
									new web3.utils.BN(2),
								],
								bnCloseVariance,
							});
						});

						it('reverts if the user tries to settle before the waiting period has expired', async () => {
							await assert.revert(
								rwaone.settle(rETH, {
									from: owner,
								}),
								'Cannot settle during waiting period'
							);
						});

						describe('When the waiting period is set back to 0', () => {
							beforeEach(async () => {
								await systemSettings.setWaitingPeriodSecs('0', { from: owner });
							});

							it('there should be only one rETH entry', async () => {
								let numEntries = await exchangeState.getLengthOfEntries(owner, rETH);
								assert.bnEqual(numEntries, '1');
								numEntries = await exchangeState.getLengthOfEntries(owner, sEUR);
								assert.bnEqual(numEntries, '0');
							});

							describe('new trades take place', () => {
								beforeEach(async () => {
									// await fastForward(await systemSettings.waitingPeriodSecs());
									const sEthBalance = await rETHContract.balanceOf(owner);
									await rwaone.exchange(rETH, sEthBalance, rUSD, { from: owner });
									await rwaone.exchange(rUSD, toUnit('10'), sEUR, { from: owner });
								});

								it('should settle the pending exchanges and remove all entries', async () => {
									assert.bnEqual(await rETHContract.balanceOf(owner), '0');
									const { numEntries } = await exchanger.settlementOwing(owner, rETH);
									assert.bnEqual(numEntries, '0');
								});

								it('should not create any new entries', async () => {
									const { numEntries } = await exchanger.settlementOwing(owner, sEUR);
									assert.bnEqual(numEntries, '0');
								});
							});
						});
					});
				});
			});
		});
	};

	const itDeviatesCorrectly = () => {
		describe('priceDeviationThresholdFactor()', () => {
			it('the default is configured correctly', async () => {
				// Note: this only tests the effectiveness of the setup script, not the deploy script,
				assert.equal(
					await exchanger.priceDeviationThresholdFactor(),
					PRICE_DEVIATION_THRESHOLD_FACTOR
				);
			});
			describe('when a user exchanges into rETH over the default threshold factor', () => {
				let logs;
				beforeEach(async () => {
					await fastForward(10);
					// base rate of rETH is 100 from shared setup above
					await updateRates([rETH], [toUnit('300')]);
					const { tx: hash } = await rwaone.exchange(rUSD, toUnit('1'), rETH, {
						from: account1,
					});

					logs = await getDecodedLogs({
						hash,
						contracts: [rwaone, exchanger, systemStatus],
					});
				});
				it('no exchange took place', async () => {
					assert.ok(!logs.some(({ name } = {}) => name === 'RwaExchange'));
				});
			});
			describe('when a user exchanges into rETH under the default threshold factor', () => {
				let logs;
				beforeEach(async () => {
					await fastForward(10);
					// base rate of rETH is 100 from shared setup above
					await updateRates([rETH], [toUnit('33')]);
					const { tx: hash } = await rwaone.exchange(rUSD, toUnit('1'), rETH, {
						from: account1,
					});

					logs = await getDecodedLogs({
						hash,
						contracts: [rwaone, exchanger, systemStatus],
					});
				});
				it('no exchange took place', async () => {
					assert.ok(!logs.some(({ name } = {}) => name === 'RwaExchange'));
				});
			});
			describe('changing the factor works', () => {
				describe('when the factor is set to 3.1', () => {
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit('3.1'), { from: owner });
					});
					describe('when a user exchanges into rETH over the default threshold factor, but under the new one', () => {
						beforeEach(async () => {
							await fastForward(10);
							// base rate of rETH is 100 from shared setup above
							await updateRates([rETH], [toUnit('300')]);
							await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 });
						});
						it('then the rwa is not suspended', async () => {
							const { suspended, reason } = await systemStatus.rwaSuspension(rETH);
							assert.ok(!suspended);
							assert.equal(reason, '0');
						});
					});
					describe('when a user exchanges into rETH under the default threshold factor, but under the new one', () => {
						beforeEach(async () => {
							await fastForward(10);
							// base rate of rETH is 100 from shared setup above
							await updateRates([rETH], [toUnit('33')]);
							await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 });
						});
						it('then the rwa is not suspended', async () => {
							const { suspended, reason } = await systemStatus.rwaSuspension(rETH);
							assert.ok(!suspended);
							assert.equal(reason, '0');
						});
					});
				});
			});
		});
	};

	const itCalculatesMaxSecsLeft = () => {
		describe('maxSecsLeftInWaitingPeriod()', () => {
			describe('when the waiting period is configured to 60', () => {
				let waitingPeriodSecs;
				beforeEach(async () => {
					waitingPeriodSecs = '60';
					await systemSettings.setWaitingPeriodSecs(waitingPeriodSecs, { from: owner });
				});
				describe('when there are no exchanges', () => {
					it('then it returns 0', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
						assert.equal(maxSecs, '0', 'No seconds remaining for exchange');
					});
				});
				describe('when a user with rUSD has performed an exchange into sEUR', () => {
					beforeEach(async () => {
						await rwaone.exchange(rUSD, toUnit('100'), sEUR, { from: account1 });
					});
					it('reports hasWaitingPeriodOrSettlementOwing', async () => {
						assert.isTrue(await exchanger.hasWaitingPeriodOrSettlementOwing(account1, sEUR));
					});
					it('then fetching maxSecs for that user into sEUR returns 60', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
						timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
					});
					it('and fetching maxSecs for that user into the source rwa returns 0', async () => {
						const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, rUSD);
						assert.equal(maxSecs, '0', 'No waiting period for src rwa');
					});
					it('and fetching maxSecs for that user into other rwas returns 0', async () => {
						let maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, rBTC);
						assert.equal(maxSecs, '0', 'No waiting period for other rwa rBTC');
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, iBTC);
						assert.equal(maxSecs, '0', 'No waiting period for other rwa iBTC');
					});
					it('and fetching maxSec for other users into that rwa are unaffected', async () => {
						let maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, sEUR);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account2 has no waiting period on dest rwa of account 1'
						);
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, rUSD);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account2 has no waiting period on src rwa of account 1'
						);
						maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account3, sEUR);
						assert.equal(
							maxSecs,
							'0',
							'Other user: account3 has no waiting period on dest rwa of acccount 1'
						);
					});

					describe('when 55 seconds has elapsed', () => {
						beforeEach(async () => {
							await fastForward(55);
						});
						it('then it returns 5', async () => {
							const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
							timeIsClose({ actual: maxSecs, expected: 5, variance: 2 });
						});
						describe('when another user does the same exchange', () => {
							beforeEach(async () => {
								await rwaone.exchange(rUSD, toUnit('100'), sEUR, { from: account2 });
							});
							it('then it still returns 5 for the original user', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
								timeIsClose({ actual: maxSecs, expected: 5, variance: 3 });
							});
							it('and yet the new user has 60 secs', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account2, sEUR);
								timeIsClose({ actual: maxSecs, expected: 60, variance: 3 });
							});
						});
						describe('when another 5 seconds elapses', () => {
							beforeEach(async () => {
								await fastForward(5);
							});
							it('then it returns 0', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
								assert.equal(maxSecs, '0', 'No time left in waiting period');
							});
							describe('when another 10 seconds elapses', () => {
								beforeEach(async () => {
									await fastForward(10);
								});
								it('then it still returns 0', async () => {
									const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
									assert.equal(maxSecs, '0', 'No time left in waiting period');
								});
							});
						});
						describe('when the same user exchanges into the new rwa', () => {
							beforeEach(async () => {
								await rwaone.exchange(rUSD, toUnit('100'), sEUR, { from: account1 });
							});
							it('then the secs remaining returns 60 again', async () => {
								const maxSecs = await exchanger.maxSecsLeftInWaitingPeriod(account1, sEUR);
								timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
							});
						});
					});
				});
			});
		});
	};

	const itCalculatesFeeRateForExchange = () => {
		describe('Given exchangeFeeRates are configured and when calling feeRateForExchange()', () => {
			it('for two long rwas, returns double the regular exchange fee', async () => {
				const actualFeeRate = await exchanger.feeRateForExchange(sEUR, rBTC, { from: owner });
				assert.bnEqual(
					actualFeeRate,
					exchangeFeeRate.mul(toBN('2')),
					'Rate must be the exchange fee rate'
				);
			});
		});
	};

	const itCalculatesFeeRateForExchange2 = () => {
		describe('given exchange fee rates are configured into categories', () => {
			const biprUSD = toUnit('0');
			const bipsFX = toUnit('0.01');
			const bipsCrypto = toUnit('0.02');
			const bipsInverse = toUnit('0.03');
			beforeEach(async () => {
				await setExchangeFeeRateForRwas({
					owner,
					systemSettings,
					rwaKeys: [rUSD, sAUD, sEUR, rETH, rBTC, iBTC],
					exchangeFeeRates: [biprUSD, bipsFX, bipsFX, bipsCrypto, bipsCrypto, bipsInverse],
				});
			});
			describe('when calling getAmountsForExchange', () => {
				describe('and the destination is a crypto rwa', () => {
					let received;
					let destinationFee;
					let feeRate;
					beforeEach(async () => {
						await rwaone.exchange(rUSD, amountIssued, rBTC, { from: account1 });
						const {
							amountReceived,
							fee,
							exchangeFeeRate,
						} = await exchanger.getAmountsForExchange(amountIssued, rUSD, rBTC, { from: account1 });
						received = amountReceived;
						destinationFee = fee;
						feeRate = exchangeFeeRate;
					});
					it('then return the amountReceived', async () => {
						const rBTCBalance = await rBTCContract.balanceOf(account1);
						assert.bnEqual(received, rBTCBalance);
					});
					it('then return the fee', async () => {
						const effectiveValue = await exchangeRates.effectiveValue(rUSD, amountIssued, rBTC);
						assert.bnEqual(destinationFee, exchangeFeeIncurred(effectiveValue, bipsCrypto));
					});
					it('then return the feeRate', async () => {
						const exchangeFeeRate = await exchanger.feeRateForExchange(rUSD, rBTC, {
							from: account1,
						});
						assert.bnEqual(feeRate, exchangeFeeRate);
					});
				});

				describe('and the destination is a fiat rwa', () => {
					let received;
					let destinationFee;
					let feeRate;
					beforeEach(async () => {
						await rwaone.exchange(rUSD, amountIssued, sEUR, { from: account1 });
						const {
							amountReceived,
							fee,
							exchangeFeeRate,
						} = await exchanger.getAmountsForExchange(amountIssued, rUSD, sEUR, { from: account1 });
						received = amountReceived;
						destinationFee = fee;
						feeRate = exchangeFeeRate;
					});
					it('then return the amountReceived', async () => {
						const sEURBalance = await sEURContract.balanceOf(account1);
						assert.bnEqual(received, sEURBalance);
					});
					it('then return the fee', async () => {
						const effectiveValue = await exchangeRates.effectiveValue(rUSD, amountIssued, sEUR);
						assert.bnEqual(destinationFee, exchangeFeeIncurred(effectiveValue, bipsFX));
					});
					it('then return the feeRate', async () => {
						const exchangeFeeRate = await exchanger.feeRateForExchange(rUSD, sEUR, {
							from: owner,
						});
						assert.bnEqual(feeRate, exchangeFeeRate);
					});
				});

				describe('when the fees are changed', () => {
					const amount = toUnit('1000');

					it('updates exchange fee amounts appropriately', async () => {
						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [rUSD],
							exchangeFeeRates: [toUnit(0)],
						});

						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [sAUD],
							exchangeFeeRates: [toUnit(0)],
						});

						// need to also set it here because rates are 0
						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [rUSD, sAUD],
							exchangeFeeRates: [toUnit(0), toUnit(0)],
						});

						const {
							exchangeFeeRate: exchangeFeeRate1,
						} = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, { from: account1 });
						assert.bnEqual(exchangeFeeRate1, 0);

						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [rUSD],
							exchangeFeeRates: [toUnit(0.1)],
						});
						const {
							exchangeFeeRate: exchangeFeeRate2,
						} = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, { from: account1 });
						assert.bnEqual(exchangeFeeRate2, toUnit(0.1));

						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [sAUD],
							exchangeFeeRates: [toUnit(0.01)],
						});
						const {
							exchangeFeeRate: exchangeFeeRate3,
						} = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, { from: account1 });
						assert.bnEqual(exchangeFeeRate3, toUnit(0.11));
					});
				});

				describe('when tripling an exchange rate', () => {
					const amount = toUnit('1000');
					const factor = toUnit('3');

					let orgininalFee;
					let orginalFeeRate;
					beforeEach(async () => {
						const { fee, exchangeFeeRate } = await exchanger.getAmountsForExchange(
							amount,
							rUSD,
							sAUD,
							{ from: owner }
						);
						orgininalFee = fee;
						orginalFeeRate = exchangeFeeRate;

						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys: [sAUD],
							exchangeFeeRates: [multiplyDecimal(bipsFX, factor)],
						});
					});
					it('then return the fee tripled', async () => {
						const { fee } = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, {
							from: owner,
						});
						assert.bnEqual(fee, multiplyDecimal(orgininalFee, factor));
					});
					it('then return the feeRate tripled', async () => {
						const { exchangeFeeRate } = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, {
							from: owner,
						});
						assert.bnEqual(exchangeFeeRate, multiplyDecimal(orginalFeeRate, factor));
					});
					it('then return the amountReceived less triple the fee', async () => {
						const { amountReceived } = await exchanger.getAmountsForExchange(amount, rUSD, sAUD, {
							from: owner,
						});
						const tripleFee = multiplyDecimal(orgininalFee, factor);
						const effectiveValue = await exchangeRates.effectiveValue(rUSD, amount, sAUD);
						assert.bnEqual(amountReceived, effectiveValue.sub(tripleFee));
					});
				});

				describe('dynamic fee when rates change', () => {
					const threshold = toBN(EXCHANGE_DYNAMIC_FEE_THRESHOLD);
					const maxDynamicFeeRate = toBN(EXCHANGE_MAX_DYNAMIC_FEE);

					it('initial fee is correct', async () => {
						assert.bnEqual(
							await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
							bipsCrypto
						);
						assert.deepEqual(
							await exchanger.dynamicFeeRateForExchange(rUSD, rBTC, { from: owner }),
							[0, false]
						);
					});

					describe('fee is calculated correctly when rates spike or drop', () => {
						it('.3% spike is below threshold', async () => {
							await updateRates([rETH], [toUnit(100.3)]);
							// spike
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[0, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rBTC, rBTC, { from: owner }),
								[0, false]
							);
						});

						it('.3% drop is below threshold', async () => {
							await updateRates([rETH], [toUnit(99.7)]);
							// spike
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[0, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rBTC, rBTC, { from: owner }),
								[0, false]
							);
						});

						it('1% spike result in correct dynamic fee', async () => {
							await updateRates([rETH], [toUnit(101)]);
							// price diff ratio (1%)- threshold
							const expectedDynamicFee = toUnit(0.01).sub(threshold);
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto.add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[expectedDynamicFee, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('1% drop result in correct dynamic fee', async () => {
							await updateRates([rETH], [toUnit(99)]);
							// price diff ratio (1%)- threshold
							const expectedDynamicFee = toUnit(0.01).sub(threshold);
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto.add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[expectedDynamicFee, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('5% spike result in correct dynamic fee', async () => {
							await updateRates([rETH], [toUnit(105)]);
							// price diff ratio (5%)- threshold
							const expectedDynamicFee = toUnit(0.05).sub(threshold);
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto.add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[expectedDynamicFee, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('5% drop result in correct dynamic fee', async () => {
							await updateRates([rETH], [toUnit(95)]);
							// price diff ratio (5%)- threshold
							const expectedDynamicFee = toUnit(0.05).sub(threshold);
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								bipsCrypto.add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[expectedDynamicFee, false]
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('10% spike is over the max and is too volatile', async () => {
							await updateRates([rETH], [toUnit(110)]);
							await assert.revert(
								exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								'too volatile'
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[maxDynamicFeeRate, true]
							);

							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('10% drop result in correct dynamic fee', async () => {
							await updateRates([rETH], [toUnit(90)]);
							await assert.revert(
								exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
								'too volatile'
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
								[maxDynamicFeeRate, true]
							);
							// view reverts
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rUSD, rETH, { from: owner }),
								'too volatile'
							);
							// control
							assert.bnEqual(
								await exchanger.feeRateForExchange(rUSD, rBTC, { from: owner }),
								bipsCrypto
							);
						});

						it('trading between two spiked rates is correctly calculated ', async () => {
							await updateRates([rETH, rBTC], [toUnit(102), toUnit(5100)]);
							// base fee + (price diff ratio (2%)- threshold) * 2
							const expectedDynamicFee = toUnit(0.02)
								.sub(threshold)
								.mul(toBN(2));

							assert.bnEqual(
								await exchanger.feeRateForExchange(rBTC, rETH, { from: owner }),
								bipsCrypto.add(bipsCrypto).add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rBTC, rETH, { from: owner }),
								[expectedDynamicFee, false]
							);
							// reverse direction is the same
							assert.bnEqual(
								await exchanger.feeRateForExchange(rETH, rBTC, { from: owner }),
								bipsCrypto.add(bipsCrypto).add(expectedDynamicFee)
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rETH, rBTC, { from: owner }),
								[expectedDynamicFee, false]
							);
						});

						it('trading between two spiked respects max fee and volatility flag', async () => {
							// spike each 3% so that total dynamic fee is 6% which is more than the max
							await updateRates([rETH, rBTC], [toUnit(103), toUnit(5150)]);
							await assert.revert(
								exchanger.feeRateForExchange(rBTC, rETH, { from: owner }),
								'too volatile'
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rBTC, rETH, { from: owner }),
								[maxDynamicFeeRate, true]
							);
							// reverse direction is the same
							await assert.revert(
								exchanger.feeRateForExchange(rETH, rBTC, { from: owner }),
								'too volatile'
							);
							assert.deepEqual(
								await exchanger.dynamicFeeRateForExchange(rETH, rBTC, { from: owner }),
								[maxDynamicFeeRate, true]
							);
							// view reverts
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rETH, rBTC, { from: owner }),
								'too volatile'
							);
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rBTC, rETH, { from: owner }),
								'too volatile'
							);
						});
					});

					it('no exchange happens when dynamic fee is too high', async () => {
						await rETHContract.issue(account1, toUnit('10'));

						async function echangeSuccessful() {
							// this should work
							const txn = await rwaone.exchange(rETH, toUnit('1'), rUSD, { from: account1 });
							const logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [rwaone, exchanger, systemStatus],
							});
							// some exchange took place (this is just to control for correct assertion)
							return logs.some(({ name } = {}) => name === 'RwaExchange');
						}

						// should work for no change
						assert.ok(await echangeSuccessful());
						// view doesn't revert
						await exchanger.getAmountsForExchange(toUnit('1'), rETH, rUSD, { from: account1 });

						// spike the rate a little
						await updateRates([rETH], [toUnit(103)]);
						// should still work
						assert.ok(await echangeSuccessful());
						// view doesn't revert
						await exchanger.getAmountsForExchange(toUnit('1'), rETH, rUSD, { from: account1 });

						// spike the rate too much
						await updateRates([rETH], [toUnit(110)]);
						// should not work now
						assert.notOk(await echangeSuccessful());
						// view reverts
						await assert.revert(
							exchanger.getAmountsForExchange(toUnit('1'), rETH, rUSD, { from: account1 }),
							'too volatile'
						);
					});

					it('dynamic fee decays with time', async () => {
						await updateRates([rETH], [toUnit(105)]);
						// (price diff ratio (5%)- threshold)
						let expectedDynamicFee = toUnit(0.05).sub(threshold);
						assert.bnEqual(
							await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
							bipsCrypto.add(expectedDynamicFee)
						);
						assert.deepEqual(
							await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
							[expectedDynamicFee, false]
						);

						const decay = toBN(EXCHANGE_DYNAMIC_FEE_WEIGHT_DECAY);

						// next round
						await updateRates([rETH], [toUnit(105)]);
						expectedDynamicFee = multiplyDecimal(expectedDynamicFee, decay);
						assert.bnEqual(
							await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
							bipsCrypto.add(expectedDynamicFee)
						);
						assert.deepEqual(
							await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
							[expectedDynamicFee, false]
						);

						// another round
						await updateRates([rETH], [toUnit(105)]);
						expectedDynamicFee = multiplyDecimal(expectedDynamicFee, decay);
						assert.bnEqual(
							await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
							bipsCrypto.add(expectedDynamicFee)
						);
						assert.deepEqual(
							await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
							[expectedDynamicFee, false]
						);

						// EXCHANGE_DYNAMIC_FEE_ROUNDS after spike dynamic fee is 0
						for (let i = 0; i < EXCHANGE_DYNAMIC_FEE_ROUNDS - 3; i++) {
							await updateRates([rETH], [toUnit(105)]);
						}
						assert.bnEqual(
							await exchanger.feeRateForExchange(rUSD, rETH, { from: owner }),
							bipsCrypto
						);
						assert.deepEqual(
							await exchanger.dynamicFeeRateForExchange(rUSD, rETH, { from: owner }),
							[0, false]
						);
					});
				});
			});
		});
	};

	const exchangeFeeIncurred = (amountToExchange, exchangeFeeRate) => {
		return multiplyDecimal(amountToExchange, exchangeFeeRate);
	};

	const amountAfterExchangeFee = ({ amount }) => {
		// exchange fee is applied twice, because we assume it is the same one used for both rwas in the exchange
		return multiplyDecimal(
			amount,
			toUnit('1')
				.sub(exchangeFeeRate)
				.sub(exchangeFeeRate)
		);
	};

	const calculateExpectedSettlementAmount = ({ amount, oldRate, newRate }) => {
		// Note: exchangeFeeRate is in a parent scope. Tests may mutate it in beforeEach and
		// be assured that this function, when called in a test, will use that mutated value
		const result = multiplyDecimal(amountAfterExchangeFee({ amount }), oldRate.sub(newRate));
		return {
			reclaimAmount: result.isNeg() ? new web3.utils.BN(0) : result,
			rebateAmount: result.isNeg() ? result.abs() : new web3.utils.BN(0),
		};
	};

	/**
	 * Ensure a settle() transaction emits the expected events
	 */
	const ensureTxnEmitsSettlementEvents = async ({ hash, rwa, expected }) => {
		// Get receipt to collect all transaction events
		const logs = await getDecodedLogs({ hash, contracts: [rwaone, exchanger, rUSDContract] });

		const currencyKey = await rwa.currencyKey();
		// Can only either be reclaim or rebate - not both
		const isReclaim = !expected.reclaimAmount.isZero();
		const expectedAmount = isReclaim ? expected.reclaimAmount : expected.rebateAmount;

		const eventName = `Exchange${isReclaim ? 'Reclaim' : 'Rebate'}`;
		decodedEventEqual({
			log: logs.find(({ name }) => name === eventName), // logs[0] is individual reclaim/rebate events, logs[1] is either an Issued or Burned event
			event: eventName,
			emittedFrom: await rwaone.proxy(),
			args: [account1, currencyKey, expectedAmount],
			bnCloseVariance,
		});

		// return all logs for any other usage
		return logs;
	};

	const itSettles = () => {
		describe('settlement', () => {
			describe('suspension conditions', () => {
				const rwa = rETH;
				['System', 'Rwa'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true, rwa });
							// Disable Dynamic Fee here as settlement is L1 and Dynamic fee is on L2
							await setExchangeDynamicFeeRounds('1');
						});
						it('then calling settle() reverts', async () => {
							await assert.revert(
								rwaone.settle(rETH, { from: account1 }),
								'Operation prohibited'
							);
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false, rwa });
							});
							it('then calling exchange() succeeds', async () => {
								await rwaone.settle(rETH, { from: account1 });
							});
						});
					});
				});
				describe('when Rwa(rBTC) is suspended', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'Rwa', suspend: true, rwa: rBTC });
					});
					it('then settling other rwas still works', async () => {
						await rwaone.settle(rETH, { from: account1 });
						await rwaone.settle(sAUD, { from: account2 });
					});
				});
				describe('when Rwa(rBTC) is suspended for exchanging', () => {
					beforeEach(async () => {
						await setStatus({
							owner,
							systemStatus,
							section: 'RwaExchange',
							suspend: true,
							rwa: rBTC,
						});
					});
					it('then settling it still works', async () => {
						await rwaone.settle(rBTC, { from: account1 });
					});
				});
			});
			describe('given the sEUR rate is 2, and rETH is 100, rBTC is 9000', () => {
				beforeEach(async () => {
					// set rUSD:sEUR as 2:1, rUSD:rETH at 100:1, rUSD:rBTC at 9000:1
					await updateRates([sEUR, rETH, rBTC], ['2', '100', '9000'].map(toUnit));
					// Disable Dynamic Fee by setting rounds to 1
					await setExchangeDynamicFeeRounds('1');
				});
				describe('and the exchange fee rate is 1% for easier human consumption', () => {
					beforeEach(async () => {
						// Warning: this is mutating the global exchangeFeeRate for this test block and will be reset when out of scope
						exchangeFeeRate = toUnit('0.01');
						await setExchangeFeeRateForRwas({
							owner,
							systemSettings,
							rwaKeys,
							exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
						});
					});
					describe('and the waitingPeriodSecs is set to 60', () => {
						beforeEach(async () => {
							await systemSettings.setWaitingPeriodSecs('60', { from: owner });
						});
						describe('various rebate & reclaim scenarios', () => {
							describe('when the debt cache is replaced with a spy', () => {
								let debtCacheSpy;
								beforeEach(async () => {
									// populate with a mocked DebtCache so we can inspect it
									debtCacheSpy = await smock.fake('DebtCache');
									await resolver.importAddresses([toBytes32('DebtCache')], [debtCacheSpy.address], {
										from: owner,
									});
									await exchanger.rebuildCache();
								});
								describe('and the priceDeviationThresholdFactor is set to a factor of 2.5', () => {
									beforeEach(async () => {
										// prevent circuit breaker from firing for doubling or halving rates by upping the threshold difference to 2.5
										await systemSettings.setPriceDeviationThresholdFactor(toUnit('2.5'), {
											from: owner,
										});
									});
									describe('when the first user exchanges 100 rUSD into rUSD:sEUR at 2:1', () => {
										let amountOfSrcExchanged;
										let exchangeTime;
										let exchangeTransaction;
										beforeEach(async () => {
											amountOfSrcExchanged = toUnit('100');
											exchangeTime = await currentTime();
											exchangeTransaction = await rwaone.exchange(
												rUSD,
												amountOfSrcExchanged,
												sEUR,
												{
													from: account1,
												}
											);

											const {
												amountReceived,
												exchangeFeeRate,
											} = await exchanger.getAmountsForExchange(amountOfSrcExchanged, rUSD, sEUR, {
												from: account1,
											});

											const logs = await getDecodedLogs({
												hash: exchangeTransaction.tx,
												contracts: [
													rwaone,
													exchanger,
													rUSDContract,
													issuer,
													flexibleStorage,
													debtCache,
												],
											});

											// ExchangeEntryAppended is emitted for exchange
											decodedEventEqual({
												log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
												event: 'ExchangeEntryAppended',
												emittedFrom: exchanger.address,
												args: [
													account1,
													rUSD,
													amountOfSrcExchanged,
													sEUR,
													amountReceived,
													exchangeFeeRate,
													new web3.utils.BN(1),
													new web3.utils.BN(2),
												],
												bnCloseVariance,
											});
										});
										it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
											const settlement = await exchanger.settlementOwing(account1, sEUR);
											assert.equal(settlement.reclaimAmount, '0', 'Nothing can be reclaimAmount');
											assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
											assert.equal(
												settlement.numEntries,
												'1',
												'Must be one entry in the settlement queue'
											);
										});
										describe('when settle() is invoked on sEUR', () => {
											it('then it reverts as the waiting period has not ended', async () => {
												await assert.revert(
													rwaone.settle(sEUR, { from: account1 }),
													'Cannot settle during waiting period'
												);
											});
										});

										describe('when the waiting period elapses', () => {
											beforeEach(async () => {
												await fastForward(60);
											});
											describe('when settle() is invoked on sEUR', () => {
												let txn;
												beforeEach(async () => {
													txn = await rwaone.settle(sEUR, {
														from: account1,
													});
												});
												it('then it completes with one settlement', async () => {
													const logs = await getDecodedLogs({
														hash: txn.tx,
														contracts: [rwaone, exchanger, rUSDContract],
													});

													assert.equal(
														logs.filter(({ name }) => name === 'ExchangeEntrySettled').length,
														1
													);

													decodedEventEqual({
														log: logs.find(({ name }) => name === 'ExchangeEntrySettled'),
														event: 'ExchangeEntrySettled',
														emittedFrom: exchanger.address,
														args: [
															account1,
															rUSD,
															amountOfSrcExchanged,
															sEUR,
															'0',
															'0',
															new web3.utils.BN(1),
															new web3.utils.BN(3),
															exchangeTime + 1,
														],
														bnCloseVariance,
													});
												});
												it('and the debt cache sync is not called', async () => {
													expect(debtCacheSpy.updateCachedRwaDebts).to.have.length(0);
												});
											});
										});
										it('when sEUR is attempted to be exchanged away by the user, it reverts', async () => {
											await assert.revert(
												rwaone.exchange(sEUR, toUnit('1'), rBTC, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});

										describe('when settle() is invoked on the src rwa - rUSD', () => {
											it('then it completes with no reclaim or rebate', async () => {
												const txn = await rwaone.settle(rUSD, {
													from: account1,
												});
												assert.equal(
													txn.logs.length,
													0,
													'Must not emit any events as no settlement required'
												);
											});
										});
										describe('when settle() is invoked on sEUR by another user', () => {
											it('then it completes with no reclaim or rebate', async () => {
												const txn = await rwaone.settle(sEUR, {
													from: account2,
												});
												assert.equal(
													txn.logs.length,
													0,
													'Must not emit any events as no settlement required'
												);
											});
										});
										describe('when the price doubles for rUSD:sEUR to 4:1', () => {
											beforeEach(async () => {
												await fastForward(5);
												await updateRates([sEUR], ['4'].map(toUnit));
											});
											it('then settlement reclaimAmount shows a reclaim of half the entire balance of sEUR', async () => {
												const expected = calculateExpectedSettlementAmount({
													amount: amountOfSrcExchanged,
													oldRate: divideDecimal(1, 2),
													newRate: divideDecimal(1, 4),
												});

												const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
													account1,
													sEUR
												);

												assert.bnEqual(rebateAmount, expected.rebateAmount);
												assert.bnEqual(reclaimAmount, expected.reclaimAmount);
											});
											describe('when settle() is invoked', () => {
												it('then it reverts as the waiting period has not ended', async () => {
													await assert.revert(
														rwaone.settle(sEUR, { from: account1 }),
														'Cannot settle during waiting period'
													);
												});
											});
											describe('when another minute passes', () => {
												let expectedSettlement;
												let srcBalanceBeforeExchange;

												beforeEach(async () => {
													await fastForward(60);
													srcBalanceBeforeExchange = await sEURContract.balanceOf(account1);

													expectedSettlement = calculateExpectedSettlementAmount({
														amount: amountOfSrcExchanged,
														oldRate: divideDecimal(1, 2),
														newRate: divideDecimal(1, 4),
													});
												});

												describe('when full exchange() is invoked before settle', () => {
													let expectedAmountReceived;
													beforeEach(async () => {
														expectedAmountReceived = (
															await exchanger.getAmountsForExchange(
																srcBalanceBeforeExchange.sub(expectedSettlement.reclaimAmount),
																sEUR,
																rBTC,
																{ from: account1 }
															)
														)[0];

														await rwaone.exchange(
															sEUR,
															await sEURContract.balanceOf(account1),
															rBTC,
															{
																from: account1,
															}
														);
													});
													it('then exchanges with settled amount', async () => {
														assert.bnEqual(
															await rBTCContract.balanceOf(account1),
															expectedAmountReceived
														);
													});
												});

												describe('when settle() is invoked', () => {
													let transaction;
													beforeEach(async () => {
														transaction = await rwaone.settle(sEUR, {
															from: account1,
														});
													});
													it('then it settles with a reclaim', async () => {
														await ensureTxnEmitsSettlementEvents({
															hash: transaction.tx,
															rwa: sEURContract,
															expected: expectedSettlement,
														});
													});
													it('then it settles with a ExchangeEntrySettled event with reclaim', async () => {
														const logs = await getDecodedLogs({
															hash: transaction.tx,
															contracts: [rwaone, exchanger, rUSDContract],
														});

														decodedEventEqual({
															log: logs.find(({ name }) => name === 'ExchangeEntrySettled'),
															event: 'ExchangeEntrySettled',
															emittedFrom: exchanger.address,
															args: [
																account1,
																rUSD,
																amountOfSrcExchanged,
																sEUR,
																expectedSettlement.reclaimAmount,
																new web3.utils.BN(0),
																new web3.utils.BN(1),
																new web3.utils.BN(3),
																exchangeTime + 1,
															],
															bnCloseVariance,
														});
													});
													it('and the debt cache is called', async () => {
														expect(debtCacheSpy.updateCachedRwaDebts).to.have.length(0);
														debtCacheSpy.updateCachedRwaDebts.returnsAtCall(0, sEUR);
													});
												});
												describe('when settle() is invoked and the exchange fee rate has changed', () => {
													beforeEach(async () => {
														await setExchangeFeeRateForRwas({
															owner,
															systemSettings,
															rwaKeys: [rBTC],
															exchangeFeeRates: [toUnit('0.1')],
														});
													});
													it('then it settles with a reclaim', async () => {
														const { tx: hash } = await rwaone.settle(sEUR, {
															from: account1,
														});
														await ensureTxnEmitsSettlementEvents({
															hash,
															rwa: sEURContract,
															expected: expectedSettlement,
														});
													});
												});

												// The user has ~49.5 sEUR and has a reclaim of ~24.75 - so 24.75 after settlement
												describe(
													'when an exchange out of sEUR for more than the balance after settlement,' +
													'but less than the total initially',
													() => {
														let txn;
														beforeEach(async () => {
															txn = await rwaone.exchange(sEUR, toUnit('30'), rBTC, {
																from: account1,
															});
														});
														it('then it succeeds, exchanging the entire amount after settlement', async () => {
															const srcBalanceAfterExchange = await sEURContract.balanceOf(
																account1
															);
															assert.equal(srcBalanceAfterExchange, '0');

															const decodedLogs = await ensureTxnEmitsSettlementEvents({
																hash: txn.tx,
																rwa: sEURContract,
																expected: expectedSettlement,
															});

															decodedEventEqual({
																log: decodedLogs.find(({ name }) => name === 'RwaExchange'),
																event: 'RwaExchange',
																emittedFrom: await rwaone.proxy(),
																args: [
																	account1,
																	sEUR,
																	srcBalanceBeforeExchange.sub(expectedSettlement.reclaimAmount),
																	rBTC,
																],
															});
														});
													}
												);

												describe(
													'when an exchange out of sEUR for more than the balance after settlement,' +
													'and more than the total initially and the exchangefee rate changed',
													() => {
														let txn;
														beforeEach(async () => {
															txn = await rwaone.exchange(sEUR, toUnit('50'), rBTC, {
																from: account1,
															});
															await setExchangeFeeRateForRwas({
																owner,
																systemSettings,
																rwaKeys: [rBTC],
																exchangeFeeRates: [toUnit('0.1')],
															});
														});
														it('then it succeeds, exchanging the entire amount after settlement', async () => {
															const srcBalanceAfterExchange = await sEURContract.balanceOf(
																account1
															);
															assert.equal(srcBalanceAfterExchange, '0');

															const decodedLogs = await ensureTxnEmitsSettlementEvents({
																hash: txn.tx,
																rwa: sEURContract,
																expected: expectedSettlement,
															});

															decodedEventEqual({
																log: decodedLogs.find(({ name }) => name === 'RwaExchange'),
																event: 'RwaExchange',
																emittedFrom: await rwaone.proxy(),
																args: [
																	account1,
																	sEUR,
																	srcBalanceBeforeExchange.sub(expectedSettlement.reclaimAmount),
																	rBTC,
																],
															});
														});
													}
												);

												describe('when an exchange out of sEUR for less than the balance after settlement', () => {
													let newAmountToExchange;
													let txn;
													beforeEach(async () => {
														newAmountToExchange = toUnit('10');
														txn = await rwaone.exchange(sEUR, newAmountToExchange, rBTC, {
															from: account1,
														});
													});
													it('then it succeeds, exchanging the amount given', async () => {
														const srcBalanceAfterExchange = await sEURContract.balanceOf(account1);

														assert.bnClose(
															srcBalanceAfterExchange,
															srcBalanceBeforeExchange
																.sub(expectedSettlement.reclaimAmount)
																.sub(newAmountToExchange)
														);

														const decodedLogs = await ensureTxnEmitsSettlementEvents({
															hash: txn.tx,
															rwa: sEURContract,
															expected: expectedSettlement,
														});

														decodedEventEqual({
															log: decodedLogs.find(({ name }) => name === 'RwaExchange'),
															event: 'RwaExchange',
															emittedFrom: await rwaone.proxy(),
															args: [account1, sEUR, newAmountToExchange, rBTC], // amount to exchange must be the reclaim amount
														});
													});
												});
											});
										});
										describe('when the price halves for rUSD:sEUR to 1:1', () => {
											beforeEach(async () => {
												await fastForward(5);
												await updateRates([sEUR], ['1'].map(toUnit));
											});
											it('then settlement rebateAmount shows a rebate of half the entire balance of sEUR', async () => {
												const expected = calculateExpectedSettlementAmount({
													amount: amountOfSrcExchanged,
													oldRate: divideDecimal(1, 2),
													newRate: divideDecimal(1, 1),
												});

												const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
													account1,
													sEUR
												);

												assert.bnEqual(rebateAmount, expected.rebateAmount);
												assert.bnEqual(reclaimAmount, expected.reclaimAmount);
											});

											describe('when another minute passes', () => {
												beforeEach(async () => {
													await fastForward(60);
												});

												describe('when full exchange() is invoked before settle', () => {
													let expectedAmountReceived;
													beforeEach(async () => {
														const srcBalanceBeforeExchange = await sEURContract.balanceOf(account1);
														const expectedSettlement = calculateExpectedSettlementAmount({
															amount: amountOfSrcExchanged,
															oldRate: divideDecimal(1, 2),
															newRate: divideDecimal(1, 1),
														});

														expectedAmountReceived = (
															await exchanger.getAmountsForExchange(
																srcBalanceBeforeExchange.add(expectedSettlement.rebateAmount),
																sEUR,
																rBTC,
																{ from: account1 }
															)
														)[0];

														await rwaone.exchange(
															sEUR,
															await sEURContract.balanceOf(account1),
															rBTC,
															{
																from: account1,
															}
														);
													});
													it('then exchanges with settled amount', async () => {
														assert.bnEqual(
															await rBTCContract.balanceOf(account1),
															expectedAmountReceived
														);
													});
												});
											});

											describe('when the user makes a 2nd exchange of 100 rUSD into rUSD:sEUR at 1:1', () => {
												beforeEach(async () => {
													// fast forward 60 seconds so 1st exchange is using first rate
													await fastForward(60);

													await rwaone.exchange(rUSD, amountOfSrcExchanged, sEUR, {
														from: account1,
													});
												});

												describe('and then the price increases for rUSD:sEUR to 2:1', () => {
													beforeEach(async () => {
														await fastForward(5);
														await updateRates([sEUR], ['2'].map(toUnit));
													});
													describe('when settlement is invoked', () => {
														describe('when another minute passes', () => {
															let expectedSettlementReclaim;
															let expectedSettlementRebate;
															beforeEach(async () => {
																await fastForward(60);

																expectedSettlementRebate = calculateExpectedSettlementAmount({
																	amount: amountOfSrcExchanged,
																	oldRate: divideDecimal(1, 2),
																	newRate: divideDecimal(1, 1),
																});

																expectedSettlementReclaim = calculateExpectedSettlementAmount({
																	amount: amountOfSrcExchanged,
																	oldRate: divideDecimal(1, 1),
																	newRate: divideDecimal(1, 2),
																});
															});

															describe('when settle() is invoked', () => {
																let transaction;
																beforeEach(async () => {
																	transaction = await rwaone.settle(sEUR, {
																		from: account1,
																	});
																});
																it('then it settles with two ExchangeEntrySettled events one for reclaim and one for rebate', async () => {
																	const logs = await getDecodedLogs({
																		hash: transaction.tx,
																		contracts: [rwaone, exchanger, rUSDContract],
																	});

																	// check the rebate event first
																	decodedEventEqual({
																		log: logs.filter(
																			({ name }) => name === 'ExchangeEntrySettled'
																		)[0],
																		event: 'ExchangeEntrySettled',
																		emittedFrom: exchanger.address,
																		args: [
																			account1,
																			rUSD,
																			amountOfSrcExchanged,
																			sEUR,
																			new web3.utils.BN(0),
																			expectedSettlementRebate.rebateAmount,
																			new web3.utils.BN(1),
																			new web3.utils.BN(2),
																			exchangeTime + 1,
																		],
																		bnCloseVariance,
																	});

																	// check the reclaim event
																	decodedEventEqual({
																		log: logs.filter(
																			({ name }) => name === 'ExchangeEntrySettled'
																		)[1],
																		event: 'ExchangeEntrySettled',
																		emittedFrom: exchanger.address,
																		args: [
																			account1,
																			rUSD,
																			amountOfSrcExchanged,
																			sEUR,
																			expectedSettlementReclaim.reclaimAmount,
																			new web3.utils.BN(0),
																			new web3.utils.BN(1),
																			new web3.utils.BN(2),
																		],
																		bnCloseVariance,
																	});
																});
															});
														});
													});
												});
											});
											describe('when settlement is invoked', () => {
												it('then it reverts as the waiting period has not ended', async () => {
													await assert.revert(
														rwaone.settle(sEUR, { from: account1 }),
														'Cannot settle during waiting period'
													);
												});
												describe('when another minute passes', () => {
													let expectedSettlement;
													let srcBalanceBeforeExchange;

													beforeEach(async () => {
														await fastForward(60);
														srcBalanceBeforeExchange = await sEURContract.balanceOf(account1);

														expectedSettlement = calculateExpectedSettlementAmount({
															amount: amountOfSrcExchanged,
															oldRate: divideDecimal(1, 2),
															newRate: divideDecimal(1, 1),
														});
													});

													describe('when settle() is invoked', () => {
														let transaction;
														beforeEach(async () => {
															transaction = await rwaone.settle(sEUR, {
																from: account1,
															});
														});
														it('then it settles with a rebate', async () => {
															await ensureTxnEmitsSettlementEvents({
																hash: transaction.tx,
																rwa: sEURContract,
																expected: expectedSettlement,
															});
														});
														it('then it settles with a ExchangeEntrySettled event with rebate', async () => {
															const logs = await getDecodedLogs({
																hash: transaction.tx,
																contracts: [rwaone, exchanger, rUSDContract],
															});

															decodedEventEqual({
																log: logs.find(({ name }) => name === 'ExchangeEntrySettled'),
																event: 'ExchangeEntrySettled',
																emittedFrom: exchanger.address,
																args: [
																	account1,
																	rUSD,
																	amountOfSrcExchanged,
																	sEUR,
																	new web3.utils.BN(0),
																	expectedSettlement.rebateAmount,
																	new web3.utils.BN(1),
																	new web3.utils.BN(2),
																	exchangeTime + 1,
																],
																bnCloseVariance,
															});
														});
													});

													// The user has 49 sEUR and has a rebate of 49 - so 98 after settlement
													describe('when an exchange out of sEUR for their expected balance before exchange', () => {
														let txn;
														beforeEach(async () => {
															txn = await rwaone.exchange(sEUR, toUnit('49'), rBTC, {
																from: account1,
															});
														});
														it('then it succeeds, exchanging the entire amount plus the rebate', async () => {
															const srcBalanceAfterExchange = await sEURContract.balanceOf(
																account1
															);
															assert.equal(srcBalanceAfterExchange, '0');

															const decodedLogs = await ensureTxnEmitsSettlementEvents({
																hash: txn.tx,
																rwa: sEURContract,
																expected: expectedSettlement,
															});

															decodedEventEqual({
																log: decodedLogs.find(({ name }) => name === 'RwaExchange'),
																event: 'RwaExchange',
																emittedFrom: await rwaone.proxy(),
																args: [
																	account1,
																	sEUR,
																	srcBalanceBeforeExchange.add(expectedSettlement.rebateAmount),
																	rBTC,
																],
															});
														});
													});

													describe('when an exchange out of sEUR for some amount less than their balance before exchange', () => {
														let txn;
														beforeEach(async () => {
															txn = await rwaone.exchange(sEUR, toUnit('10'), rBTC, {
																from: account1,
															});
														});
														it('then it succeeds, exchanging the amount plus the rebate', async () => {
															const decodedLogs = await ensureTxnEmitsSettlementEvents({
																hash: txn.tx,
																rwa: sEURContract,
																expected: expectedSettlement,
															});

															decodedEventEqual({
																log: decodedLogs.find(({ name }) => name === 'RwaExchange'),
																event: 'RwaExchange',
																emittedFrom: await rwaone.proxy(),
																args: [
																	account1,
																	sEUR,
																	toUnit('10').add(expectedSettlement.rebateAmount),
																	rBTC,
																],
															});
														});
													});
												});
											});
											describe('when the price returns to rUSD:sEUR to 2:1', () => {
												beforeEach(async () => {
													await fastForward(12);
													await updateRates([sEUR], ['2'].map(toUnit));
												});
												it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
													const settlement = await exchanger.settlementOwing(account1, sEUR);
													assert.equal(
														settlement.reclaimAmount,
														'0',
														'Nothing can be reclaimAmount'
													);
													assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
												});
												describe('when another minute elapses and the rETH price changes', () => {
													beforeEach(async () => {
														await fastForward(60);
														await updateRates([sEUR], ['3'].map(toUnit));
													});
													it('then settlement reclaimAmount still shows 0 reclaim and 0 refund as the timeout period ended', async () => {
														const settlement = await exchanger.settlementOwing(account1, sEUR);
														assert.equal(
															settlement.reclaimAmount,
															'0',
															'Nothing can be reclaimAmount'
														);
														assert.equal(
															settlement.rebateAmount,
															'0',
															'Nothing can be rebateAmount'
														);
													});
													describe('when settle() is invoked', () => {
														it('then it settles with no reclaim or rebate', async () => {
															const txn = await rwaone.settle(sEUR, {
																from: account1,
															});
															assert.equal(
																txn.logs.length,
																0,
																'Must not emit any events as no settlement required'
															);
														});
													});
												});
											});
										});
									});
									describe('given the first user has 1000 sEUR', () => {
										beforeEach(async () => {
											await sEURContract.issue(account1, toUnit('1000'));
										});
										describe('when the first user exchanges 100 sEUR into sEUR:rBTC at 9000:2', () => {
											let amountOfSrcExchanged;
											beforeEach(async () => {
												amountOfSrcExchanged = toUnit('100');
												await rwaone.exchange(sEUR, amountOfSrcExchanged, rBTC, {
													from: account1,
												});
											});
											it('then settlement reclaimAmount shows 0 reclaim and 0 refund', async () => {
												const settlement = await exchanger.settlementOwing(account1, rBTC);
												assert.equal(settlement.reclaimAmount, '0', 'Nothing can be reclaimAmount');
												assert.equal(settlement.rebateAmount, '0', 'Nothing can be rebateAmount');
												assert.equal(
													settlement.numEntries,
													'1',
													'Must be one entry in the settlement queue'
												);
											});
											describe('when the price doubles for rUSD:sEUR to 4:1', () => {
												beforeEach(async () => {
													await fastForward(5);
													await updateRates([sEUR], ['4'].map(toUnit));
												});
												it('then settlement shows a rebate rebateAmount', async () => {
													const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
														account1,
														rBTC
													);

													const expected = calculateExpectedSettlementAmount({
														amount: amountOfSrcExchanged,
														oldRate: divideDecimal(2, 9000),
														newRate: divideDecimal(4, 9000),
													});

													assert.bnClose(rebateAmount, expected.rebateAmount, bnCloseVariance);
													assert.bnEqual(reclaimAmount, expected.reclaimAmount);
												});
												describe('when settlement is invoked', () => {
													it('then it reverts as the waiting period has not ended', async () => {
														await assert.revert(
															rwaone.settle(rBTC, { from: account1 }),
															'Cannot settle during waiting period'
														);
													});
												});
												describe('when the price gains for rBTC more than the loss of the sEUR change', () => {
													beforeEach(async () => {
														await updateRates([rBTC], ['20000'].map(toUnit));
													});
													it('then the reclaimAmount is whats left when subtracting the rebate', async () => {
														const { reclaimAmount, rebateAmount } = await exchanger.settlementOwing(
															account1,
															rBTC
														);

														const expected = calculateExpectedSettlementAmount({
															amount: amountOfSrcExchanged,
															oldRate: divideDecimal(2, 9000),
															newRate: divideDecimal(4, 20000),
														});

														assert.bnEqual(rebateAmount, expected.rebateAmount);
														assert.bnClose(reclaimAmount, expected.reclaimAmount, bnCloseVariance);
													});
													describe('when the same user exchanges some rUSD into rBTC - the same destination', () => {
														let amountOfSrcExchangedSecondary;
														beforeEach(async () => {
															amountOfSrcExchangedSecondary = toUnit('10');
															await rwaone.exchange(rUSD, amountOfSrcExchangedSecondary, rBTC, {
																from: account1,
															});
														});
														it('then the reclaimAmount is unchanged', async () => {
															const {
																reclaimAmount,
																rebateAmount,
																numEntries,
															} = await exchanger.settlementOwing(account1, rBTC);

															const expected = calculateExpectedSettlementAmount({
																amount: amountOfSrcExchanged,
																oldRate: divideDecimal(2, 9000),
																newRate: divideDecimal(4, 20000),
															});

															assert.bnEqual(rebateAmount, expected.rebateAmount);
															assert.bnClose(
																reclaimAmount,
																expected.reclaimAmount,
																bnCloseVariance
															);
															assert.equal(
																numEntries,
																'2',
																'Must be two entries in the settlement queue'
															);
														});
														describe('when the price of rBTC lowers, turning the profit to a loss', () => {
															let expectedFromFirst;
															let expectedFromSecond;
															beforeEach(async () => {
																await fastForward(5);

																await updateRates([rBTC], ['10000'].map(toUnit));

																expectedFromFirst = calculateExpectedSettlementAmount({
																	amount: amountOfSrcExchanged,
																	oldRate: divideDecimal(2, 9000),
																	newRate: divideDecimal(4, 10000),
																});
																expectedFromSecond = calculateExpectedSettlementAmount({
																	amount: amountOfSrcExchangedSecondary,
																	oldRate: divideDecimal(1, 20000),
																	newRate: divideDecimal(1, 10000),
																});
															});
															it('then the rebateAmount calculation of settlementOwing on rBTC includes both exchanges', async () => {
																const {
																	reclaimAmount,
																	rebateAmount,
																} = await exchanger.settlementOwing(account1, rBTC);

																assert.equal(reclaimAmount, '0');

																assert.bnClose(
																	rebateAmount,
																	expectedFromFirst.rebateAmount.add(
																		expectedFromSecond.rebateAmount
																	),
																	bnCloseVariance
																);
															});
															describe('when another minute passes', () => {
																beforeEach(async () => {
																	await fastForward(60);
																});
																describe('when settle() is invoked for rBTC', () => {
																	it('then it settles with a rebate @gasprofile', async () => {
																		const txn = await rwaone.settle(rBTC, {
																			from: account1,
																		});

																		await ensureTxnEmitsSettlementEvents({
																			hash: txn.tx,
																			rwa: rBTCContract,
																			expected: {
																				reclaimAmount: new web3.utils.BN(0),
																				rebateAmount: expectedFromFirst.rebateAmount.add(
																					expectedFromSecond.rebateAmount
																				),
																			},
																		});
																	});
																});
															});
															describe('when another minute passes and the exchange fee rate has increased', () => {
																beforeEach(async () => {
																	await fastForward(60);
																	await setExchangeFeeRateForRwas({
																		owner,
																		systemSettings,
																		rwaKeys: [rBTC],
																		exchangeFeeRates: [toUnit('0.1')],
																	});
																});
																describe('when settle() is invoked for rBTC', () => {
																	it('then it settles with a rebate using the exchange fee rate at time of trade', async () => {
																		const { tx: hash } = await rwaone.settle(rBTC, {
																			from: account1,
																		});

																		await ensureTxnEmitsSettlementEvents({
																			hash,
																			rwa: rBTCContract,
																			expected: {
																				reclaimAmount: new web3.utils.BN(0),
																				rebateAmount: expectedFromFirst.rebateAmount.add(
																					expectedFromSecond.rebateAmount
																				),
																			},
																		});
																	});
																});
															});
														});
													});
												});
											});
										});

										describe('and the max number of exchange entries is 5', () => {
											beforeEach(async () => {
												await exchangeState.setMaxEntriesInQueue('5', { from: owner });
											});
											describe('when a user tries to exchange 100 sEUR into rBTC 5 times', () => {
												beforeEach(async () => {
													const txns = [];
													for (let i = 0; i < 5; i++) {
														txns.push(
															await rwaone.exchange(sEUR, toUnit('100'), rBTC, {
																from: account1,
															})
														);
													}
												});
												it('then all succeed', () => { });
												it('when one more is tried, then if fails', async () => {
													await assert.revert(
														rwaone.exchange(sEUR, toUnit('100'), rBTC, { from: account1 }),
														'Max queue length reached'
													);
												});
												describe('when more than 60s elapses', () => {
													beforeEach(async () => {
														await fastForward(70);
													});
													describe('and the user invokes settle() on the dest rwa', () => {
														beforeEach(async () => {
															await rwaone.settle(rBTC, { from: account1 });
														});
														it('then when the user performs 5 more exchanges into the same rwa, it succeeds', async () => {
															for (let i = 0; i < 5; i++) {
																await rwaone.exchange(sEUR, toUnit('100'), rBTC, {
																	from: account1,
																});
															}
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
			});
		});
	};

	const itCalculatesAmountAfterSettlement = () => {
		describe('calculateAmountAfterSettlement()', () => {
			describe('given a user has 1000 sEUR', () => {
				beforeEach(async () => {
					await sEURContract.issue(account1, toUnit('1000'));
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount < 1000 and no refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							sEUR,
							toUnit('500'),
							'0'
						);
					});
					it('then the response is the given amount of 500', () => {
						assert.bnEqual(response, toUnit('500'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount < 1000 and a refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							sEUR,
							toUnit('500'),
							toUnit('25')
						);
					});
					it('then the response is the given amount of 500 plus the refund', () => {
						assert.bnEqual(response, toUnit('525'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount > 1000 and no refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							sEUR,
							toUnit('1200'),
							'0'
						);
					});
					it('then the response is the balance of 1000', () => {
						assert.bnEqual(response, toUnit('1000'));
					});
				});
				describe('when calculatAmountAfterSettlement is invoked with and amount > 1000 and a refund', () => {
					let response;
					beforeEach(async () => {
						response = await exchanger.calculateAmountAfterSettlement(
							account1,
							sEUR,
							toUnit('1200'),
							toUnit('50')
						);
					});
					it('then the response is the given amount of 1000 plus the refund', () => {
						assert.bnEqual(response, toUnit('1050'));
					});
				});
			});
		});
	};

	const itExchanges = () => {
		describe('exchange()', () => {
			it('exchange() cannot be invoked directly by any account', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: exchanger.exchange,
					accounts,
					args: [
						account1,
						account1,
						rUSD,
						toUnit('100'),
						sAUD,
						account1,
						false,
						account1,
						toBytes32(''),
					],
					reason: 'Only rwaone or a rwa contract can perform this action',
				});
			});

			describe('suspension conditions on Rwaone.exchange()', () => {
				const rwa = rETH;
				['System', 'Exchange', 'RwaExchange', 'Rwa'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true, rwa });
						});
						it('then calling exchange() reverts', async () => {
							await assert.revert(
								rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 }),
								'Operation prohibited'
							);
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false, rwa });
							});
							it('then calling exchange() succeeds', async () => {
								await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 });
							});
						});
					});
				});
				describe('when Rwa(rBTC) is suspended', () => {
					beforeEach(async () => {
						// issue sAUD to test non-rUSD exchanges
						await sAUDContract.issue(account2, toUnit('100'));

						await setStatus({ owner, systemStatus, section: 'Rwa', suspend: true, rwa: rBTC });
					});
					it('then exchanging other rwas still works', async () => {
						await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 });
						await rwaone.exchange(sAUD, toUnit('1'), rETH, { from: account2 });
					});
				});
			});

			describe('various exchange scenarios', () => {
				describe('when a user has 1000 rUSD', () => {
					// already issued in the top-level beforeEach

					it('should allow a user to exchange the rwas they hold in one flavour for another', async () => {
						// Exchange rUSD to sAUD
						await rwaone.exchange(rUSD, amountIssued, sAUD, { from: account1 });

						// Get the exchange amounts
						const {
							amountReceived,
							fee,
							exchangeFeeRate: feeRate,
						} = await exchanger.getAmountsForExchange(amountIssued, rUSD, sAUD, {
							from: account1,
						});

						// Assert we have the correct AUD value - exchange fee
						const sAUDBalance = await sAUDContract.balanceOf(account1);
						assert.bnEqual(amountReceived, sAUDBalance);

						// Assert we have the exchange fee to distribute
						const feePeriodZero = await feePool.recentFeePeriods(0);
						const usdFeeAmount = await exchangeRates.effectiveValue(sAUD, fee, rUSD);
						assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);

						// Double the exchange fee rate (once for rUSD, once for sAUD)
						assert.bnEqual(feeRate, exchangeFeeRate.add(exchangeFeeRate));
					});

					it('should emit a RwaExchange event @gasprofile', async () => {
						// Exchange rUSD to sAUD
						const txn = await rwaone.exchange(rUSD, amountIssued, sAUD, {
							from: account1,
						});

						const sAUDBalance = await sAUDContract.balanceOf(account1);

						const rwaExchangeEvent = txn.logs.find(log => log.event === 'RwaExchange');
						assert.eventEqual(rwaExchangeEvent, 'RwaExchange', {
							account: account1,
							fromCurrencyKey: toBytes32('rUSD'),
							fromAmount: amountIssued,
							toCurrencyKey: toBytes32('sAUD'),
							toAmount: sAUDBalance,
							toAddress: account1,
						});
					});

					it('should emit an ExchangeTracking event @gasprofile', async () => {
						// Exchange rUSD to sAUD
						const txn = await rwaone.exchangeWithTracking(
							rUSD,
							amountIssued,
							sAUD,
							account1,
							trackingCode,
							{
								from: account1,
							}
						);

						const { fee } = await exchanger.getAmountsForExchange(amountIssued, rUSD, sAUD, {
							from: account1,
						});
						const usdFeeAmount = await exchangeRates.effectiveValue(sAUD, fee, rUSD);

						const sAUDBalance = await sAUDContract.balanceOf(account1);

						const rwaExchangeEvent = txn.logs.find(log => log.event === 'RwaExchange');
						assert.eventEqual(rwaExchangeEvent, 'RwaExchange', {
							account: account1,
							fromCurrencyKey: toBytes32('rUSD'),
							fromAmount: amountIssued,
							toCurrencyKey: toBytes32('sAUD'),
							toAmount: sAUDBalance,
							toAddress: account1,
						});

						const trackingEvent = txn.logs.find(log => log.event === 'ExchangeTracking');
						assert.eventEqual(trackingEvent, 'ExchangeTracking', {
							trackingCode,
							toCurrencyKey: toBytes32('sAUD'),
							toAmount: sAUDBalance,
							fee: usdFeeAmount,
						});
					});

					it('when a user tries to exchange more than they have, then it fails', async () => {
						await assert.revert(
							rwaone.exchange(sAUD, toUnit('1'), rUSD, {
								from: account1,
							}),
							'SafeMath: subtraction overflow'
						);
					});

					it('when a user tries to exchange more than they have, then it fails', async () => {
						await assert.revert(
							rwaone.exchange(rUSD, toUnit('1001'), sAUD, {
								from: account1,
							}),
							'SafeMath: subtraction overflow'
						);
					});

					[
						'exchange',
						'exchangeOnBehalf',
						'exchangeWithTracking',
						'exchangeOnBehalfWithTracking',
					].forEach(type => {
						describe(`rate stale scenarios for ${type}`, () => {
							const exchange = ({ from, to, amount }) => {
								if (type === 'exchange')
									return rwaone.exchange(from, amount, to, { from: account1 });
								else if (type === 'exchangeOnBehalf')
									return rwaone.exchangeOnBehalf(account1, from, amount, to, { from: account2 });
								if (type === 'exchangeWithTracking')
									return rwaone.exchangeWithTracking(from, amount, to, account1, trackingCode, {
										from: account1,
									});
								else if (type === 'exchangeOnBehalfWithTracking')
									return rwaone.exchangeOnBehalfWithTracking(
										account1,
										from,
										amount,
										to,
										account2,
										trackingCode,
										{ from: account2 }
									);
							};

							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(account2, { from: account1 });
							});
							describe('when rates have gone stale for all rwas', () => {
								beforeEach(async () => {
									await fastForward(
										(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
									);
								});
								it(`attempting to ${type} from rUSD into sAUD reverts with dest stale`, async () => {
									await assert.revert(
										exchange({ from: rUSD, amount: amountIssued, to: sAUD }),
										'dest rate stale or flagged'
									);
									// view reverts
									await assert.revert(
										exchanger.getAmountsForExchange(toUnit('1'), rUSD, sAUD),
										'invalid'
									);
								});
								it('settling still works ', async () => {
									await rwaone.settle(sAUD, { from: account1 });
								});
								describe('when that rwa has a fresh rate', () => {
									beforeEach(async () => {
										await updateRates([sAUD], ['0.75'].map(toUnit));
									});
									describe(`when the user ${type} into that rwa`, () => {
										beforeEach(async () => {
											await exchange({ from: rUSD, amount: amountIssued, to: sAUD });
										});
										describe('after the waiting period expires and the rwa has gone stale', () => {
											beforeEach(async () => {
												await fastForward(
													(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
												);
											});
											it(`${type} back to rUSD fails as the source has no rate`, async () => {
												await assert.revert(
													exchange({ from: sAUD, amount: amountIssued, to: rUSD }),
													'src rate stale or flagged'
												);
											});
										});
									});
								});
							});
						});
					});

					describe('exchanging on behalf', async () => {
						const authoriser = account1;
						const delegate = account2;
						describe('when not approved it should revert on', async () => {
							it('exchangeOnBehalf', async () => {
								await assert.revert(
									rwaone.exchangeOnBehalf(authoriser, sAUD, toUnit('1'), rUSD, {
										from: delegate,
									}),
									'Not approved to act on behalf'
								);
							});
						});
						describe('when delegate address approved to exchangeOnBehalf', async () => {
							// (rUSD amount issued earlier in top-level beforeEach)
							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(delegate, { from: authoriser });
							});
							describe('suspension conditions on Rwaone.exchangeOnBehalf()', () => {
								const rwa = sAUD;
								['System', 'Exchange', 'RwaExchange', 'Rwa'].forEach(section => {
									describe(`when ${section} is suspended`, () => {
										beforeEach(async () => {
											await setStatus({ owner, systemStatus, section, suspend: true, rwa });
										});
										it('then calling exchange() reverts', async () => {
											await assert.revert(
												rwaone.exchangeOnBehalf(authoriser, rUSD, amountIssued, sAUD, {
													from: delegate,
												}),
												'Operation prohibited'
											);
										});
										describe(`when ${section} is resumed`, () => {
											beforeEach(async () => {
												await setStatus({ owner, systemStatus, section, suspend: false, rwa });
											});
											it('then calling exchange() succeeds', async () => {
												await rwaone.exchangeOnBehalf(authoriser, rUSD, amountIssued, sAUD, {
													from: delegate,
												});
											});
										});
									});
								});
								describe('when Rwa(rBTC) is suspended', () => {
									beforeEach(async () => {
										await setStatus({
											owner,
											systemStatus,
											section: 'Rwa',
											suspend: true,
											rwa: rBTC,
										});
									});
									it('then exchanging other rwas on behalf still works', async () => {
										await rwaone.exchangeOnBehalf(authoriser, rUSD, amountIssued, sAUD, {
											from: delegate,
										});
									});
								});
							});

							it('should revert if non-delegate invokes exchangeOnBehalf', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: rwaone.exchangeOnBehalf,
									args: [authoriser, rUSD, amountIssued, sAUD],
									// We cannot test the revert condition with the authoriser as the recipient
									// because this will lead to a regular exchange, not one on behalf
									accounts: accounts.filter(a => a !== authoriser),
									address: delegate,
									reason: 'Not approved to act on behalf',
								});
							});
							it('should exchangeOnBehalf and authoriser recieves the destRwa', async () => {
								// Exchange rUSD to sAUD
								await rwaone.exchangeOnBehalf(authoriser, rUSD, amountIssued, sAUD, {
									from: delegate,
								});

								const { amountReceived, fee } = await exchanger.getAmountsForExchange(
									amountIssued,
									rUSD,
									sAUD,
									{ from: owner }
								);

								// Assert we have the correct AUD value - exchange fee
								const sAUDBalance = await sAUDContract.balanceOf(authoriser);
								assert.bnEqual(amountReceived, sAUDBalance);

								// Assert we have the exchange fee to distribute
								const feePeriodZero = await feePool.recentFeePeriods(0);
								const usdFeeAmount = await exchangeRates.effectiveValue(sAUD, fee, rUSD);
								assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);
							});
						});
					});

					describe('exchanging on behalf with tracking', async () => {
						const authoriser = account1;
						const delegate = account2;

						describe('when not approved it should revert on', async () => {
							it('exchangeOnBehalfWithTracking', async () => {
								await assert.revert(
									rwaone.exchangeOnBehalfWithTracking(
										authoriser,
										sAUD,
										toUnit('1'),
										rUSD,
										authoriser,
										trackingCode,
										{ from: delegate }
									),
									'Not approved to act on behalf'
								);
							});
						});
						describe('when delegate address approved to exchangeOnBehalf', async () => {
							// (rUSD amount issued earlier in top-level beforeEach)
							beforeEach(async () => {
								await delegateApprovals.approveExchangeOnBehalf(delegate, { from: authoriser });
							});
							describe('suspension conditions on Rwaone.exchangeOnBehalfWithTracking()', () => {
								const rwa = sAUD;
								['System', 'Exchange', 'RwaExchange', 'Rwa'].forEach(section => {
									describe(`when ${section} is suspended`, () => {
										beforeEach(async () => {
											await setStatus({ owner, systemStatus, section, suspend: true, rwa });
										});
										it('then calling exchange() reverts', async () => {
											await assert.revert(
												rwaone.exchangeOnBehalfWithTracking(
													authoriser,
													rUSD,
													amountIssued,
													sAUD,
													authoriser,
													trackingCode,
													{
														from: delegate,
													}
												),
												'Operation prohibited'
											);
										});
										describe(`when ${section} is resumed`, () => {
											beforeEach(async () => {
												await setStatus({ owner, systemStatus, section, suspend: false, rwa });
											});
											it('then calling exchange() succeeds', async () => {
												await rwaone.exchangeOnBehalfWithTracking(
													authoriser,
													rUSD,
													amountIssued,
													sAUD,
													authoriser,
													trackingCode,
													{
														from: delegate,
													}
												);
											});
										});
									});
								});
								describe('when Rwa(rBTC) is suspended', () => {
									beforeEach(async () => {
										await setStatus({
											owner,
											systemStatus,
											section: 'Rwa',
											suspend: true,
											rwa: rBTC,
										});
									});
									it('then exchanging other rwas on behalf still works', async () => {
										await rwaone.exchangeOnBehalfWithTracking(
											authoriser,
											rUSD,
											amountIssued,
											sAUD,
											authoriser,
											trackingCode,
											{
												from: delegate,
											}
										);
									});
								});
							});

							it('should revert if non-delegate invokes exchangeOnBehalf', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: rwaone.exchangeOnBehalfWithTracking,
									args: [authoriser, rUSD, amountIssued, sAUD, authoriser, trackingCode],
									// We cannot test the revert condition with the authoriser as the recipient
									// because this will lead to a regular exchange, not one on behalf
									accounts: accounts.filter(a => a !== authoriser),
									address: delegate,
									reason: 'Not approved to act on behalf',
								});
							});
							it('should exchangeOnBehalf and authoriser recieves the destRwa', async () => {
								// Exchange rUSD to sAUD
								const txn = await rwaone.exchangeOnBehalfWithTracking(
									authoriser,
									rUSD,
									amountIssued,
									sAUD,
									authoriser,
									trackingCode,
									{
										from: delegate,
									}
								);

								const { amountReceived, fee } = await exchanger.getAmountsForExchange(
									amountIssued,
									rUSD,
									sAUD,
									{ from: owner }
								);

								// Assert we have the correct AUD value - exchange fee
								const sAUDBalance = await sAUDContract.balanceOf(authoriser);
								assert.bnEqual(amountReceived, sAUDBalance);

								// Assert we have the exchange fee to distribute
								const feePeriodZero = await feePool.recentFeePeriods(0);
								const usdFeeAmount = await exchangeRates.effectiveValue(sAUD, fee, rUSD);
								assert.bnEqual(usdFeeAmount, feePeriodZero.feesToDistribute);

								// Assert the tracking event is fired.
								const trackingEvent = txn.logs.find(log => log.event === 'ExchangeTracking');
								assert.eventEqual(trackingEvent, 'ExchangeTracking', {
									trackingCode,
									toCurrencyKey: toBytes32('sAUD'),
									toAmount: sAUDBalance,
									fee: usdFeeAmount,
								});
							});
						});
					});
				});
			});

			describe('edge case: when an aggregator has a 0 rate', () => {
				describe('when an aggregator is added to the exchangeRates', () => {
					let aggregator;

					beforeEach(async () => {
						aggregator = await MockAggregator.new({ from: owner });
						await exchangeRates.addAggregator(rETH, aggregator.address, { from: owner });
						// set a 0 rate to prevent invalid rate from causing a revert on exchange
						await aggregator.setLatestAnswer('0', await currentTime());
					});

					describe('when exchanging into that rwa', () => {
						it('getAmountsForExchange reverts due to invalid rate', async () => {
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rUSD, rETH),
								'rwa rate invalid'
							);
						});

						it('then it causes a breaker trip from price deviation as the price is 9', async () => {
							const { tx: hash } = await rwaone.exchange(rUSD, toUnit('1'), rETH, {
								from: account1,
							});

							const logs = await getDecodedLogs({
								hash,
								contracts: [rwaone, exchanger, systemStatus],
							});

							// assert no exchange
							console.log(logs);
							assert.ok(!logs.some(({ name } = {}) => name === 'RwaExchange'));

							// check view reverts since breaker has tripped
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rUSD, rETH),
								'rate invalid'
							);
						});
					});
					describe('when exchanging out of that rwa', () => {
						beforeEach(async () => {
							// give the user some rETH
							await rETHContract.issue(account1, toUnit('1'));
						});
						it('getAmountsForExchange reverts due to invalid rate', async () => {
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rETH, rUSD),
								'rwa rate invalid'
							);
						});
						it('then it causes a breaker trip from price deviation', async () => {
							// await assert.revert(
							const { tx: hash } = await rwaone.exchange(rETH, toUnit('1'), rUSD, {
								from: account1,
							});

							const logs = await getDecodedLogs({
								hash,
								contracts: [rwaone, exchanger, systemStatus],
							});

							// assert no exchange
							assert.ok(!logs.some(({ name } = {}) => name === 'RwaExchange'));

							// check view reverts since breaker has tripped
							await assert.revert(
								exchanger.getAmountsForExchange(toUnit('1'), rETH, rUSD),
								'rate invalid'
							);
						});
					});
				});
			});
		});
	};

	const itExchangesWithVirtual = () => {
		describe('exchangeWithVirtual()', () => {
			describe('when a user has 1000 rUSD', () => {
				describe('when the waiting period is set to 60s', () => {
					beforeEach(async () => {
						await systemSettings.setWaitingPeriodSecs('60', { from: owner });
					});
					describe('when a user exchanges into sAUD using virtual rwas with a tracking code', () => {
						let logs;
						let amountReceived;
						let exchangeFeeRate;
						let findNamedEventValue;
						let vRwaAddress;

						beforeEach(async () => {
							const txn = await rwaone.exchangeWithVirtual(
								rUSD,
								amountIssued,
								sAUD,
								toBytes32('AGGREGATOR'),
								{
									from: account1,
								}
							);

							({
								amountReceived,
								exchangeFeeRate,
							} = await exchanger.getAmountsForExchange(amountIssued, rUSD, sAUD, { from: owner }));

							logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [rwaone, exchanger, rUSDContract, issuer, flexibleStorage, debtCache],
							});
							const vRwaCreatedEvent = logs.find(({ name }) => name === 'VirtualRwaCreated');
							assert.ok(vRwaCreatedEvent, 'Found VirtualRwaCreated event');
							findNamedEventValue = param =>
								vRwaCreatedEvent.events.find(({ name }) => name === param);
							vRwaAddress = findNamedEventValue('vRwa').value;
						});

						it('then it emits an ExchangeEntryAppended for the new Virtual Rwa', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'ExchangeEntryAppended'),
								event: 'ExchangeEntryAppended',
								emittedFrom: exchanger.address,
								args: [
									vRwaAddress,
									rUSD,
									amountIssued,
									sAUD,
									amountReceived,
									exchangeFeeRate,
									new web3.utils.BN(1),
									new web3.utils.BN(2),
								],
								bnCloseVariance,
							});
						});

						it('then it emits an RwaExchange into the new Virtual Rwa', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'RwaExchange'),
								event: 'RwaExchange',
								emittedFrom: await rwaone.proxy(),
								args: [account1, rUSD, amountIssued, sAUD, amountReceived, vRwaAddress],
								bnCloseVariance: '0',
							});
						});

						it('then an ExchangeTracking is emitted with the correct code', async () => {
							const evt = logs.find(({ name }) => name === 'ExchangeTracking');
							assert.equal(
								evt.events.find(({ name }) => name === 'trackingCode').value,
								toBytes32('AGGREGATOR')
							);
						});

						it('and it emits the VirtualRwaCreated event', async () => {
							assert.equal(
								findNamedEventValue('rwa').value,
								(await sAUDContract.proxy()).toLowerCase()
							);
							assert.equal(findNamedEventValue('currencyKey').value, sAUD);
							assert.equal(findNamedEventValue('amount').value, amountReceived);
							assert.equal(findNamedEventValue('recipient').value, account1.toLowerCase());
						});
						it('and the balance of the user is nothing', async () => {
							assert.bnEqual(await sAUDContract.balanceOf(account1), '0');
						});
						it('and the user has no fee reclamation entries', async () => {
							const { reclaimAmount, rebateAmount, numEntries } = await exchanger.settlementOwing(
								account1,
								sAUD
							);
							assert.equal(reclaimAmount, '0');
							assert.equal(rebateAmount, '0');
							assert.equal(numEntries, '0');
						});

						describe('with the new virtual rwa', () => {
							let vRwa;
							beforeEach(async () => {
								vRwa = await artifacts.require('VirtualRwa').at(vRwaAddress);
							});
							it('and the balance of the vRwa is the whole amount', async () => {
								assert.bnEqual(await sAUDContract.balanceOf(vRwa.address), amountReceived);
							});
							it('then it is created with the correct parameters', async () => {
								assert.equal(await vRwa.resolver(), resolver.address);
								assert.equal(await vRwa.rwa(), await sAUDContract.proxy());
								assert.equal(await vRwa.currencyKey(), sAUD);
								assert.bnEqual(await vRwa.totalSupply(), amountReceived);
								assert.bnEqual(await vRwa.balanceOf(account1), amountReceived);
								assert.notOk(await vRwa.settled());
							});
							it('and the vRwa has 1 fee reclamation entries', async () => {
								const { reclaimAmount, rebateAmount, numEntries } = await exchanger.settlementOwing(
									vRwa.address,
									sAUD
								);
								assert.equal(reclaimAmount, '0');
								assert.equal(rebateAmount, '0');
								assert.equal(numEntries, '1');
							});
							it('and the secsLeftInWaitingPeriod() returns the waitingPeriodSecs', async () => {
								const maxSecs = await vRwa.secsLeftInWaitingPeriod();
								timeIsClose({ actual: maxSecs, expected: 60, variance: 2 });
							});

							describe('when the waiting period expires', () => {
								beforeEach(async () => {
									// end waiting period
									await fastForward(await systemSettings.waitingPeriodSecs());
								});

								it('and the secsLeftInWaitingPeriod() returns 0', async () => {
									assert.equal(await vRwa.secsLeftInWaitingPeriod(), '0');
								});

								it('and readyToSettle() is true', async () => {
									assert.equal(await vRwa.readyToSettle(), true);
								});

								describe('when the vRwa is settled for the holder', () => {
									let txn;
									let logs;
									beforeEach(async () => {
										txn = await vRwa.settle(account1);

										logs = await getDecodedLogs({
											hash: txn.tx,
											contracts: [
												rwaone,
												exchanger,
												rUSDContract,
												issuer,
												flexibleStorage,
												debtCache,
											],
										});
									});

									it('then the user has all the rwas', async () => {
										assert.bnEqual(await sAUDContract.balanceOf(account1), amountReceived);
									});

									it('and the vRwa is settled', async () => {
										assert.equal(await vRwa.settled(), true);
									});

									it('and ExchangeEntrySettled is emitted', async () => {
										const evt = logs.find(({ name }) => name === 'ExchangeEntrySettled');

										const findEvt = param => evt.events.find(({ name }) => name === param);

										assert.equal(findEvt('from').value, vRwa.address.toLowerCase());
									});

									it('and the entry is settled for the vRwa', async () => {
										const {
											reclaimAmount,
											rebateAmount,
											numEntries,
										} = await exchanger.settlementOwing(vRwa.address, sAUD);
										assert.equal(reclaimAmount, '0');
										assert.equal(rebateAmount, '0');
										assert.equal(numEntries, '0');
									});

									it('and the user still has no fee reclamation entries', async () => {
										const {
											reclaimAmount,
											rebateAmount,
											numEntries,
										} = await exchanger.settlementOwing(account1, sAUD);
										assert.equal(reclaimAmount, '0');
										assert.equal(rebateAmount, '0');
										assert.equal(numEntries, '0');
									});

									it('and no more supply exists in the vRwa', async () => {
										assert.equal(await vRwa.totalSupply(), '0');
									});
								});
							});
						});
					});

					describe('when a user exchanges without a tracking code', () => {
						let logs;
						beforeEach(async () => {
							const txn = await rwaone.exchangeWithVirtual(
								rUSD,
								amountIssued,
								sAUD,
								toBytes32(),
								{
									from: account1,
								}
							);

							logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [rwaone, exchanger, rUSDContract, issuer, flexibleStorage, debtCache],
							});
						});
						it('then no ExchangeTracking is emitted (as no tracking code supplied)', async () => {
							assert.notOk(logs.find(({ name }) => name === 'ExchangeTracking'));
						});
					});
				});
			});
		});
	};

	const itFailsToExchangeWithVirtual = () => {
		describe('it cannot use exchangeWithVirtual()', () => {
			it('errors with not implemented when attempted to exchange', async () => {
				await assert.revert(
					rwaone.exchangeWithVirtual(rUSD, amountIssued, sAUD, toBytes32(), {
						from: account1,
					}),
					'Cannot be run on this layer'
				);
			});
		});
	};

	const itExchangesAtomically = () => {
		describe('exchangeAtomically()', () => {
			describe('atomicMaxVolumePerBlock()', () => {
				it('the default is configured correctly', async () => {
					// Note: this only tests the effectiveness of the setup script, not the deploy script,
					assert.bnEqual(
						await exchanger.atomicMaxVolumePerBlock(),
						await systemSettings.atomicMaxVolumePerBlock()
					);
				});

				describe('when atomic max volume per block is changed in the system settings', () => {
					const maxVolumePerBlock = new BN(ATOMIC_MAX_VOLUME_PER_BLOCK).add(new BN('100'));
					beforeEach(async () => {
						await systemSettings.setAtomicMaxVolumePerBlock(maxVolumePerBlock, { from: owner });
					});
					it('then atomicMaxVolumePerBlock() is correctly updated', async () => {
						assert.bnEqual(await exchanger.atomicMaxVolumePerBlock(), maxVolumePerBlock);
					});
				});
			});

			describe('when a user has 1000 rUSD', () => {
				describe('when the necessary configuration been set', () => {
					const ethOnDex = toUnit('0.005'); // this should be chosen over the 100 (0.01) specified by default
					const ethOnCL = toUnit('200'); // 1 over the ethOnDex

					beforeEach(async () => {
						// CL aggregator with past price data
						const aggregator = await MockAggregator.new({ from: owner });
						await exchangeRates.addAggregator(rETH, aggregator.address, { from: owner });
						// set prices with no volatility over the course of last 20 minutes
						for (let i = 4; i > 0; i--) {
							await aggregator.setLatestAnswer(ethOnCL, (await currentTime()) - i * 5 * 60);
						}

						// Rwa equivalents (needs ability to read into decimals)
						const rusdDexEquivalentToken = await MockToken.new('erUSD equivalent', 'erUSD', '18');
						const hethDexEquivalentToken = await MockToken.new('erETH equivalent', 'erETH', '18');
						await setAtomicEquivalentForDexPricing(rUSD, rusdDexEquivalentToken.address);
						await setAtomicEquivalentForDexPricing(rETH, hethDexEquivalentToken.address);
						await setAtomicVolatilityConsiderationWindow(
							rETH,
							web3.utils.toBN(600) // 10 minutes
						);
						await setAtomicVolatilityUpdateThreshold(rETH, web3.utils.toBN(2));

						// DexPriceAggregator
						const dexPriceAggregator = await MockDexPriceAggregator.new();
						await dexPriceAggregator.setAssetToAssetRate(hethDexEquivalentToken.address, ethOnDex);
						await dexPriceAggregator.setAssetToAssetRate(
							rusdDexEquivalentToken.address,
							toUnit('1')
						);
						await setDexPriceAggregator(dexPriceAggregator.address);
					});

					describe('when a user sets a minimum amount', () => {
						const amountIn = toUnit('100');

						it('reverts when the received amount is too low', async () => {
							await assert.revert(
								rwaone.exchangeAtomically(rUSD, amountIn, rETH, toBytes32(), toUnit('.498'), {
									from: account1,
								}),
								'The amount received is below the minimum amount specified.'
							);
						});

						it('succeeds when the received amount is equal to the minimum amount', async () => {
							await rwaone.exchangeAtomically(
								rUSD,
								amountIn,
								rETH,
								toBytes32(),
								toUnit('.495'),
								{
									from: account1,
								}
							);

							const { amountReceived } = await exchanger.getAmountsForAtomicExchange(
								amountIn,
								rUSD,
								rETH,
								{ from: account1 }
							);

							assert.bnEqual(await rUSDContract.balanceOf(account1), amountIssued.sub(amountIn));
							assert.bnEqual(await rETHContract.balanceOf(account1), amountReceived);
						});
					});

					describe('when the user exchanges into rETH using an atomic exchange with a tracking code', () => {
						const amountIn = toUnit('100');
						const atomicTrackingCode = toBytes32('ATOMIC_AGGREGATOR');

						let logs;
						let amountReceived;
						let amountFee;
						let exchangeFeeRate;

						beforeEach(async () => {
							const txn = await rwaone.exchangeAtomically(
								rUSD,
								amountIn,
								rETH,
								atomicTrackingCode,
								0,
								{
									from: account1,
								}
							);

							({
								amountReceived,
								exchangeFeeRate,
								fee: amountFee,
							} = await exchanger.getAmountsForAtomicExchange(amountIn, rUSD, rETH, {
								from: account1,
							}));

							logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [rwaone, exchanger, rUSDContract, issuer, flexibleStorage, debtCache],
							});
						});

						it('completed the exchange atomically', async () => {
							assert.bnEqual(await rUSDContract.balanceOf(account1), amountIssued.sub(amountIn));
							assert.bnEqual(await rETHContract.balanceOf(account1), amountReceived);
						});

						it('used the correct atomic exchange rate', async () => {
							const expectedAmountWithoutFees = multiplyDecimal(amountIn, ethOnDex); // should have chosen the dex rate
							const expectedAmount = expectedAmountWithoutFees.sub(amountFee);
							assert.bnEqual(amountReceived, expectedAmount);
						});

						it('used correct fee rate', async () => {
							const expectedFeeRate = await exchanger.feeRateForAtomicExchange(rUSD, rETH, {
								from: account1,
							});
							assert.bnEqual(exchangeFeeRate, expectedFeeRate);
							assert.bnEqual(
								multiplyDecimal(amountReceived.add(amountFee), exchangeFeeRate),
								amountFee
							);
						});

						it('emits an RwaExchange directly to the user', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'RwaExchange'),
								event: 'RwaExchange',
								emittedFrom: await rwaone.proxy(),
								args: [account1, rUSD, amountIn, rETH, amountReceived, account1],
								bnCloseVariance: '0',
							});
						});

						it('emits an AtomicRwaExchange directly to the user', async () => {
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'AtomicRwaExchange'),
								event: 'AtomicRwaExchange',
								emittedFrom: await rwaone.proxy(),
								args: [account1, rUSD, amountIn, rETH, amountReceived, account1],
								bnCloseVariance: '0',
							});
						});

						it('emits an ExchangeTracking event with the correct code', async () => {
							const usdFeeAmount = await exchangeRates.effectiveValue(rETH, amountFee, rUSD);
							decodedEventEqual({
								log: logs.find(({ name }) => name === 'ExchangeTracking'),
								event: 'ExchangeTracking',
								emittedFrom: await rwaone.proxy(),
								args: [atomicTrackingCode, rETH, amountReceived, usdFeeAmount],
								bnCloseVariance: '0',
							});
						});

						it('created no new entries and user has no fee reclamation entires', async () => {
							const {
								reclaimAmount,
								rebateAmount,
								numEntries: settleEntries,
							} = await exchanger.settlementOwing(owner, rETH);
							assert.bnEqual(reclaimAmount, '0');
							assert.bnEqual(rebateAmount, '0');
							assert.bnEqual(settleEntries, '0');

							const stateEntries = await exchangeState.getLengthOfEntries(owner, rETH);
							assert.bnEqual(stateEntries, '0');
						});
					});

					describe('when a fee override has been set for atomic exchanges', () => {
						const amountIn = toUnit('100');
						const feeRateOverride = toUnit('0.01');

						let amountReceived;
						let amountFee;
						let exchangeFeeRate;

						beforeEach(async () => {
							await setAtomicExchangeFeeRate(rETH, feeRateOverride);
						});

						beforeEach(async () => {
							await rwaone.exchangeAtomically(rUSD, amountIn, rETH, toBytes32(), 0, {
								from: account1,
							});

							({
								amountReceived,
								exchangeFeeRate,
								fee: amountFee,
							} = await exchanger.getAmountsForAtomicExchange(amountIn, rUSD, rETH, {
								from: account1,
							}));
						});

						it('used correct fee rate', async () => {
							assert.bnEqual(exchangeFeeRate, feeRateOverride);
							assert.bnEqual(
								multiplyDecimal(amountReceived.add(amountFee), exchangeFeeRate),
								amountFee
							);
						});
					});

					describe('when a user exchanges without a tracking code', () => {
						let txn;
						beforeEach(async () => {
							txn = await rwaone.exchangeAtomically(rUSD, toUnit('10'), rETH, toBytes32(), 0, {
								from: account1,
							});
						});
						it('then no ExchangeTracking is emitted (as no tracking code supplied)', async () => {
							const logs = await getDecodedLogs({
								hash: txn.tx,
								contracts: [rwaone, exchanger],
							});
							assert.notOk(logs.find(({ name }) => name === 'ExchangeTracking'));
						});
					});
				});
			});

			describe('when we can use the pure Chainlink price', () => {
				let amountIn;
				let amountReceived;
				let amountFee;

				beforeEach(async () => {
					// Set up Chainlink Prices
					const seurChainlinkPrice = toUnit('1.2');
					const seurAggregator = await MockAggregator.new({ from: owner });
					await exchangeRates.addAggregator(sEUR, seurAggregator.address, { from: owner });
					await seurAggregator.setLatestAnswer(seurChainlinkPrice, await currentTime());

					const saudChainlinkPrice = toUnit('0.7');
					const saudAggregator = await MockAggregator.new({ from: owner });
					await exchangeRates.addAggregator(sAUD, saudAggregator.address, { from: owner });
					await saudAggregator.setLatestAnswer(saudChainlinkPrice, await currentTime());

					const rbtcChainlinkPrice = toUnit('40000');
					const rbtcAggregator = await MockAggregator.new({ from: owner });
					await exchangeRates.addAggregator(rBTC, rbtcAggregator.address, { from: owner });
					await rbtcAggregator.setLatestAnswer(rbtcChainlinkPrice, await currentTime());

					// Add Rwa Equivalents to System Settings
					const rusdDexEquivalentToken = await MockToken.new('rUSD equivalent', 'erUSD', '6');
					const rbtcDexEquivalentToken = await MockToken.new('rBTC equivalent', 'erBTC', '9');
					const seurDexEquivalentToken = await MockToken.new('sEUR equivalent', 'esEUR', '18');
					const saudDexEquivalentToken = await MockToken.new('sAUD equivalent', 'esAUD', '18');
					await setAtomicEquivalentForDexPricing(rUSD, rusdDexEquivalentToken.address);
					await setAtomicEquivalentForDexPricing(rBTC, rbtcDexEquivalentToken.address);
					await setAtomicEquivalentForDexPricing(sEUR, seurDexEquivalentToken.address);
					await setAtomicEquivalentForDexPricing(sAUD, saudDexEquivalentToken.address);

					// Set up Uniswap Price Aggregator with different prices
					const dexPriceAggregator = await MockDexPriceAggregator.new();
					await dexPriceAggregator.setAssetToAssetRate(rusdDexEquivalentToken.address, toUnit('1'));
					await dexPriceAggregator.setAssetToAssetRate(
						seurDexEquivalentToken.address,
						toUnit('1.1')
					);
					await dexPriceAggregator.setAssetToAssetRate(
						saudDexEquivalentToken.address,
						toUnit('0.8')
					);
					await dexPriceAggregator.setAssetToAssetRate(
						rbtcDexEquivalentToken.address,
						toUnit('50000')
					);
					await setDexPriceAggregator(dexPriceAggregator.address, { from: owner });

					// Set Forex to use the pure Chainlink price
					for (const forexCurrencyKey of [sAUD, sEUR, rUSD]) {
						await systemSettings.setPureChainlinkPriceForAtomicSwapsEnabled(
							forexCurrencyKey,
							true,
							{
								from: owner,
							}
						);
					}
				});

				describe('for the source currency', () => {
					// sEUR -> rBTC

					beforeEach(async () => {
						amountIn = toUnit('10000');
						await sEURContract.issue(account1, amountIn);
						({
							amountReceived,
							exchangeFeeRate,
							fee: amountFee,
						} = await exchanger.getAmountsForAtomicExchange(amountIn, sEUR, rBTC, {
							from: account1,
						}));
						await rwaone.exchangeAtomically(sEUR, amountIn, rBTC, toBytes32(), 0, {
							from: account1,
						});
					});

					it('completed the exchange atomically', async () => {
						assert.bnEqual(await sEURContract.balanceOf(account1), 0);
						assert.bnEqual(await rBTCContract.balanceOf(account1), amountReceived);
					});

					it('used the correct atomic exchange rate', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('1.2')); // pure chainlink price
						const expectedAmountInBtc = divideDecimal(expectedAmountInUsd, toUnit('50000')); // dex
						assert.bnEqual(amountReceived.add(amountFee), expectedAmountInBtc);
					});

					it('updates atomic volume correctly', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('1.2')); // pure chainlink price
						const lastAtomicVolume = await exchanger.lastAtomicVolume();
						assert.bnEqual(lastAtomicVolume.volume, expectedAmountInUsd);
					});
				});

				describe('for the destination currency', () => {
					// rBTC -> sEUR

					beforeEach(async () => {
						amountIn = toUnit('1');
						await rBTCContract.issue(account1, amountIn);
						({
							amountReceived,
							exchangeFeeRate,
							fee: amountFee,
						} = await exchanger.getAmountsForAtomicExchange(amountIn, rBTC, sEUR, {
							from: account1,
						}));
						await rwaone.exchangeAtomically(rBTC, amountIn, sEUR, toBytes32(), 0, {
							from: account1,
						});
					});

					it('completed the exchange atomically', async () => {
						assert.bnEqual(await rBTCContract.balanceOf(account1), 0);
						assert.bnEqual(await sEURContract.balanceOf(account1), amountReceived);
					});

					it('used the correct atomic exchange rate', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('40000')); // pure (bc its worse)
						const expectedAmountInEur = divideDecimal(expectedAmountInUsd, toUnit('1.2')); // pure
						assert.bnEqual(amountReceived.add(amountFee), expectedAmountInEur);
					});

					it('updates atomic volume correctly', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('40000')); // pure (bc its worse)
						const lastAtomicVolume = await exchanger.lastAtomicVolume();
						assert.bnEqual(lastAtomicVolume.volume, expectedAmountInUsd);
					});
				});

				describe('for both the source and destination currency', () => {
					// sEUR -> sAUD

					beforeEach(async () => {
						amountIn = toUnit('10000');
						await sEURContract.issue(account1, amountIn);
						({
							amountReceived,
							exchangeFeeRate,
							fee: amountFee,
						} = await exchanger.getAmountsForAtomicExchange(amountIn, sEUR, sAUD, {
							from: account1,
						}));
						await rwaone.exchangeAtomically(sEUR, amountIn, sAUD, toBytes32(), 0, {
							from: account1,
						});
					});

					it('completed the exchange atomically', async () => {
						assert.bnEqual(await sEURContract.balanceOf(account1), 0);
						assert.bnEqual(await sAUDContract.balanceOf(account1), amountReceived);
					});

					it('used the correct atomic exchange rate', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('1.2')); // pure chainlink price
						const expectedAmountInAud = divideDecimal(expectedAmountInUsd, toUnit('0.7')); // pure chainlink price
						assert.bnEqual(amountReceived.add(amountFee), expectedAmountInAud);
					});

					it('updates atomic volume correctly', async () => {
						const expectedAmountInUsd = multiplyDecimal(amountIn, toUnit('1.2')); // pure chainlink price
						const lastAtomicVolume = await exchanger.lastAtomicVolume();
						assert.bnEqual(lastAtomicVolume.volume, expectedAmountInUsd);
					});
				});

				describe('fee reclamation', () => {
					// sEUR -> sAUD
					let amountIn;

					beforeEach('initial rate ensure', async () => {
						await updateRates([sAUD, sEUR], [toUnit('0.7'), toUnit('1.2')]);
						await fastForward(600);
					});

					beforeEach(async () => {
						amountIn = toUnit('10000');
						await sEURContract.issue(account1, amountIn);
						await rwaone.exchange(sEUR, amountIn, sAUD, {
							from: account1,
						});
					});

					const settlementCase = newPrice => {
						describe(`price of sAUD changes to ${newPrice} immediately after trade`, () => {
							let balanceBefore;
							let adjustedTransferBalance;
							let expectedSettlement;
							let expectedReceiveAmount;

							beforeEach('disable dynamic fee', async () => {
								// Disable Dynamic Fee here as settlement is L1 and Dynamic fee is on L2
								await setExchangeDynamicFeeRounds('1');
							});

							beforeEach('record balance and expected settlement', async () => {
								balanceBefore = await sAUDContract.balanceOf(account1);

								expectedSettlement = calculateExpectedSettlementAmount({
									amount: amountIn,
									oldRate: divideDecimal(toUnit('1.2'), toUnit('0.7')),
									newRate: divideDecimal(toUnit('1.2'), newPrice),
								});

								adjustedTransferBalance = balanceBefore.add(
									expectedSettlement.reclaimAmount.gt(toUnit('0'))
										? expectedSettlement.reclaimAmount.neg()
										: expectedSettlement.rebateAmount
								);

								console.log(
									'THE EXPECTED SETTLEMENT',
									expectedSettlement.toString(),
									adjustedTransferBalance.toString()
								);
							});

							beforeEach(`AUD price changes to ${newPrice}`, async () => {
								await fastForward(5);
								await updateRates([sAUD], [newPrice]);
							});

							describe('waiting period passes', () => {
								beforeEach('change', async () => {
									await fastForward(600);
								});

								describe('exchanges for sAUD -> sEUR', () => {
									beforeEach('exchange', async () => {
										expectedReceiveAmount = (
											await exchanger.getAmountsForAtomicExchange(
												adjustedTransferBalance,
												sAUD,
												sEUR,
												{ from: account1 }
											)
										)[0];

										await rwaone.exchangeAtomically(sAUD, balanceBefore, sEUR, toBytes32(), 0, {
											from: account1,
										});
									});

									it('exchanged amounts are correct', async () => {
										assert.bnEqual(await sAUDContract.balanceOf(account1), toUnit(0));
										console.log((await sEURContract.balanceOf(account1)).toString());
										assert.bnClose(
											await sEURContract.balanceOf(account1),
											expectedReceiveAmount,
											10000
										);
									});
								});
							});
						});
					};

					settlementCase(toUnit('0.7'));
					settlementCase(toUnit('0.8'));
					settlementCase(toUnit('0.6'));
				});
			});
		});
	};

	const itFailsToExchangeAtomically = () => {
		describe('it cannot exchange atomically', () => {
			it('errors with not implemented when attempted to exchange', async () => {
				await assert.revert(
					rwaone.exchangeAtomically(rUSD, amountIssued, rETH, toBytes32(), 0, {
						from: account1,
					}),
					'Cannot be run on this layer'
				);
			});
		});
	};

	const itPricesSpikeDeviation = () => {
		describe('priceSpikeDeviation', () => {
			const baseRate = 100;

			beforeEach(async () => {
				// disable dynamic fee here as it will not let trades get through at smaller deviations
				// than required for suspension
				await setExchangeDynamicFeeRounds('1');
			});

			const updateRate = ({ target, rate, resetCircuitBreaker }) => {
				beforeEach(async () => {
					await fastForward(10);
					// this function will not update `circuitBreaker`, which is behavior we want for tests below
					await updateAggregatorRates(
						exchangeRates,
						resetCircuitBreaker ? circuitBreaker : null,
						[target],
						[toUnit(rate)]
					);
				});
			};

			describe(`when the price of rETH is ${baseRate}`, () => {
				updateRate({ target: rETH, rate: baseRate, resetCircuitBreaker: true });

				describe('when price spike deviation is set to a factor of 2', () => {
					const baseFactor = 2;
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit(baseFactor.toString()), {
							from: owner,
						});
					});

					it('lastExchangeRate returns the same thing as CircuitBreaker.lastValue', async () => {
						const lastExchangeRate = await exchanger.lastExchangeRate(rETH);
						assert.bnNotEqual(lastExchangeRate, '0');
						assert.bnEqual(
							lastExchangeRate,
							await circuitBreaker.lastValue(await exchangeRates.aggregators(rETH))
						);
					});

					describe('the isRwaRateInvalid() view correctly returns status', () => {
						it('when called with a rwa with only a single rate, returns false', async () => {
							assert.equal(await exchanger.isRwaRateInvalid(rETH), false);
						});
						it('when called with a rwa with no rate (i.e. 0), returns true', async () => {
							assert.equal(await exchanger.isRwaRateInvalid(toBytes32('XYZ')), true);
						});
						describe('when a rwa rate changes outside of the range', () => {
							updateRate({ target: rETH, rate: baseRate * 5 });

							it('when called with that rwa, returns true', async () => {
								assert.equal(await exchanger.isRwaRateInvalid(rETH), true);
							});

							describe('when the rwa rate changes back into the range', () => {
								updateRate({ target: rETH, rate: baseRate });

								it('then when called with the target, rate is valid again', async () => {
									assert.equal(await exchanger.isRwaRateInvalid(rETH), false);
								});
							});
						});
					});

					describe('suspension is triggered via exchanging', () => {
						describe('given the user has some rETH', () => {
							beforeEach(async () => {
								await rETHContract.issue(account1, toUnit('1'));
							});

							const assertSpike = ({ from, to, target, factor, spikeExpected }) => {
								const rate = Math.abs(
									(factor > 0 ? baseRate * factor : baseRate / factor).toFixed(2)
								);
								describe(`when the rate of ${web3.utils.hexToAscii(
									target
								)} is ${rate} (factor: ${factor})`, () => {
									updateRate({ target, rate });

									describe(`when a user exchanges`, () => {
										let logs;

										beforeEach(async () => {
											const { tx: hash } = await rwaone.exchange(from, toUnit('0.01'), to, {
												from: account1,
											});
											logs = await getDecodedLogs({
												hash,
												contracts: [rwaone, exchanger, systemStatus],
											});
										});
										if (Math.abs(factor) >= baseFactor || spikeExpected) {
											it('no exchange took place', async () => {
												assert.ok(!logs.some(({ name } = {}) => name === 'RwaExchange'));
											});
										} else {
											it('an exchange took place', async () => {
												assert.ok(logs.some(({ name } = {}) => name === 'RwaExchange'));
											});
										}
									});
								});
							};

							const assertRange = ({ from, to, target }) => {
								[1, -1].forEach(multiplier => {
									describe(`${multiplier > 0 ? 'upwards' : 'downwards'} movement`, () => {
										// below threshold
										assertSpike({
											from,
											to,
											target,
											factor: 1.99 * multiplier,
										});

										// on threshold
										assertSpike({
											from,
											to,
											target,
											factor: 2 * multiplier,
										});

										// over threshold
										assertSpike({
											from,
											to,
											target,
											factor: 3 * multiplier,
										});
									});
								});
							};

							const assertBothSidesOfTheExchange = () => {
								describe('on the dest side', () => {
									assertRange({ from: rUSD, to: rETH, target: rETH });
								});

								describe('on the src side', () => {
									assertRange({ from: rETH, to: sAUD, target: rETH });
								});
							};

							describe('with no prior exchange history', () => {
								assertBothSidesOfTheExchange();

								describe('when a recent price rate is set way outside of the threshold', () => {
									beforeEach(async () => {
										await fastForward(10);
										await updateRates([rETH], [toUnit('1000')]);
									});
									describe('and then put back to normal', () => {
										beforeEach(async () => {
											await fastForward(10);
											await updateRates([rETH], [baseRate.toString()]);
										});
										assertSpike({
											from: rUSD,
											to: rETH,
											target: rETH,
											factor: 1,
											spikeExpected: true,
										});
									});
								});
							});

							describe('with a prior exchange from another user into the source', () => {
								beforeEach(async () => {
									await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account2 });
								});

								assertBothSidesOfTheExchange();
							});

							describe('with a prior exchange from another user out of the source', () => {
								beforeEach(async () => {
									await rETHContract.issue(account2, toUnit('1'));
									await rwaone.exchange(rETH, toUnit('1'), sAUD, { from: account2 });
								});

								assertBothSidesOfTheExchange();
							});
						});
					});

					describe('settlement ignores deviations', () => {
						updateRate({ target: rETH, rate: baseRate, resetCircuitBreaker: true });

						describe('when a user exchange 100 rUSD into rETH', () => {
							beforeEach(async () => {
								// Disable Dynamic Fee in settlement by setting rounds to 1
								await setExchangeDynamicFeeRounds('1');
								await rwaone.exchange(rUSD, toUnit('100'), rETH, { from: account1 });
							});
							describe('and the rETH rate moves up by a factor of 2 to 200', () => {
								updateRate({ target: rETH, rate: baseRate * 2 });

								it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
									const {
										reclaimAmount,
										rebateAmount,
										numEntries,
									} = await exchanger.settlementOwing(account1, rETH);
									assert.equal(reclaimAmount, '0');
									assert.equal(rebateAmount, '0');
									assert.equal(numEntries, '1');
								});
							});

							describe('multiple entries to settle', () => {
								describe('when the rETH rate moves down by 20%', () => {
									updateRate({ target: rETH, rate: baseRate * 0.8, resetCircuitBreaker: true });

									describe('and the waiting period expires', () => {
										beforeEach(async () => {
											// end waiting period
											await fastForward(await systemSettings.waitingPeriodSecs());
										});

										it('then settlementOwing is existing rebate with 0 reclaim, with 1 entries', async () => {
											const {
												reclaimAmount,
												rebateAmount,
												numEntries,
											} = await exchanger.settlementOwing(account1, rETH);
											assert.equal(reclaimAmount, '0');
											// some amount close to the 0.25 rebate (after fees)
											assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
											assert.equal(numEntries, '1');
										});

										describe('and the user makes another exchange into rETH', () => {
											beforeEach(async () => {
												await rwaone.exchange(rUSD, toUnit('100'), rETH, { from: account1 });
											});
											describe('and the rETH rate moves up by a factor of 2 to 200, causing the second entry to be skipped', () => {
												updateRate({ target: rETH, rate: baseRate * 2, resetCircuitBreaker: true });

												it('then settlementOwing is existing rebate with 0 reclaim, with 2 entries', async () => {
													const {
														reclaimAmount,
														rebateAmount,
														numEntries,
													} = await exchanger.settlementOwing(account1, rETH);
													assert.equal(reclaimAmount, '0');
													assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
													assert.equal(numEntries, '2');
												});
											});

											describe('and the rETH rate goes back up 25% (from 80 to 100)', () => {
												updateRate({ target: rETH, rate: baseRate, resetCircuitBreaker: true });
												describe('and the waiting period expires', () => {
													beforeEach(async () => {
														// end waiting period
														await fastForward(await systemSettings.waitingPeriodSecs());
													});
													it('then settlementOwing is existing rebate, existing reclaim, and 2 entries', async () => {
														const {
															reclaimAmount,
															rebateAmount,
															numEntries,
														} = await exchanger.settlementOwing(account1, rETH);
														assert.bnClose(reclaimAmount, toUnit('0.25'), (1e16).toString());
														assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
														assert.equal(numEntries, '2');
													});
													describe('and the user makes another exchange into rETH', () => {
														beforeEach(async () => {
															await rwaone.exchange(rUSD, toUnit('100'), rETH, {
																from: account1,
															});
														});
														describe('and the rETH rate moves down by a factor of 2 to 50, causing the third entry to be skipped', () => {
															updateRate({
																target: rETH,
																rate: baseRate * 0.5,
																resetCircuitBreaker: true,
															});

															it('then settlementOwing is existing rebate and reclaim, with 3 entries', async () => {
																const {
																	reclaimAmount,
																	rebateAmount,
																	numEntries,
																} = await exchanger.settlementOwing(account1, rETH);
																assert.bnClose(reclaimAmount, toUnit('0.25'), (1e16).toString());
																assert.bnClose(rebateAmount, toUnit('0.25'), (1e16).toString());
																assert.equal(numEntries, '3');
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

						describe('edge case: aggregator returns 0 for settlement price', () => {
							describe('when an aggregator is added to the exchangeRates', () => {
								let aggregator;

								beforeEach(async () => {
									aggregator = await MockAggregator.new({ from: owner });
									await exchangeRates.addAggregator(rETH, aggregator.address, { from: owner });
								});

								describe('and the aggregator has a rate (so the exchange succeeds)', () => {
									beforeEach(async () => {
										await aggregator.setLatestAnswer(
											convertToAggregatorPrice(100),
											await currentTime()
										);
									});
									describe('when a user exchanges out of the aggregated rate into rUSD', () => {
										beforeEach(async () => {
											// give the user some rETH
											await rETHContract.issue(account1, toUnit('1'));
											await rwaone.exchange(rETH, toUnit('1'), rUSD, { from: account1 });
										});
										describe('and the aggregated rate becomes 0', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswer('0', await currentTime());
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, rUSD);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});
											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, rUSD, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
										describe('and the aggregated rate is received but for a much higher roundId, leaving a large gap in roundIds', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswerWithRound(
													convertToAggregatorPrice(110),
													await currentTime(),
													'9999'
												);
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, rUSD);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});

											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, rUSD, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
									});
									describe('when a user exchanges into the aggregated rate from rUSD', () => {
										beforeEach(async () => {
											await rwaone.exchange(rUSD, toUnit('1'), rETH, { from: account1 });
										});
										describe('and the aggregated rate becomes 0', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswer('0', await currentTime());
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, rETH);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});
											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, rETH, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
												});
											});
										});
										describe('and the aggregated rate is received but for a much higher roundId, leaving a large gap in roundIds', () => {
											beforeEach(async () => {
												await aggregator.setLatestAnswerWithRound(
													convertToAggregatorPrice(110),
													await currentTime(),
													'9999'
												);
											});

											it('then settlementOwing is 0 for rebate and reclaim, with 1 entry', async () => {
												const {
													reclaimAmount,
													rebateAmount,
													numEntries,
												} = await exchanger.settlementOwing(account1, rETH);
												assert.equal(reclaimAmount, '0');
												assert.equal(rebateAmount, '0');
												assert.equal(numEntries, '1');
											});

											describe('and the waiting period expires', () => {
												beforeEach(async () => {
													// end waiting period
													await fastForward(await systemSettings.waitingPeriodSecs());
												});
												it('then the user can settle with no impact', async () => {
													const txn = await exchanger.settle(account1, rETH, { from: account1 });
													// Note: no need to decode the logs as they are emitted off the target contract Exchanger
													assert.equal(txn.logs.length, 1); // one settlement entry
													assert.eventEqual(txn, 'ExchangeEntrySettled', {
														reclaim: '0',
														rebate: '0',
													}); // with no reclaim or rebate
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
	};

	const itSetsExchangeFeeRateForRwas = () => {
		describe('Given rwa exchange fee rates to set', async () => {
			const fxBIPS = toUnit('0.01');
			const cryptoBIPS = toUnit('0.03');
			const empty = toBytes32('');

			describe('Given rwa exchange fee rates to update', async () => {
				const newFxBIPS = toUnit('0.02');
				const newCryptoBIPS = toUnit('0.04');

				beforeEach(async () => {
					// Disable Dynamic Fee here as it's testing for the base exchange fee rate
					await setExchangeDynamicFeeRounds('1');

					// Store multiple rates
					await setExchangeFeeRateForRwas({
						owner,
						systemSettings,
						rwaKeys: [rUSD, sAUD, rBTC, rETH],
						exchangeFeeRates: [fxBIPS, fxBIPS, cryptoBIPS, cryptoBIPS],
					});
				});

				it('when 1 exchange rate to update then overwrite existing rate', async () => {
					await setExchangeFeeRateForRwas({
						owner,
						systemSettings,
						rwaKeys: [rUSD],
						exchangeFeeRates: [newFxBIPS],
					});
					const rUSDRate = await exchanger.feeRateForExchange(empty, rUSD, { from: owner });
					assert.bnEqual(rUSDRate, newFxBIPS);
				});

				it('when multiple exchange rates then store them to be readable', async () => {
					// Update multiple rates
					await setExchangeFeeRateForRwas({
						owner,
						systemSettings,
						rwaKeys: [rUSD, sAUD, rBTC, rETH],
						exchangeFeeRates: [newFxBIPS, newFxBIPS, newCryptoBIPS, newCryptoBIPS],
					});
					// Read all rates
					const sAUDRate = await exchanger.feeRateForExchange(empty, sAUD, { from: owner });
					assert.bnEqual(sAUDRate, newFxBIPS);
					const rUSDRate = await exchanger.feeRateForExchange(empty, rUSD, { from: owner });
					assert.bnEqual(rUSDRate, newFxBIPS);
					const rBTCRate = await exchanger.feeRateForExchange(empty, rBTC, { from: owner });
					assert.bnEqual(rBTCRate, newCryptoBIPS);
					const rETHRate = await exchanger.feeRateForExchange(empty, rETH, { from: owner });
					assert.bnEqual(rETHRate, newCryptoBIPS);
				});
			});
		});
	};

	async function updateRates(keys, rates) {
		await updateAggregatorRates(exchangeRates, circuitBreaker, keys, rates);
	}

	describe('With L1 configuration (Rwaone, ExchangerWithFeeRecAlternatives, ExchangeRatesWithDexPricing)', () => {
		before(async () => {
			const VirtualRwaMastercopy = artifacts.require('VirtualRwaMastercopy');
			const rwas = ['rUSD', 'rETH', 'sEUR', 'sAUD', 'rBTC', 'iBTC', 'sTRX'];

			({
				Exchanger: exchanger,
				Rwaone: rwaone,
				ExchangeRates: exchangeRates,
				ExchangeState: exchangeState,
				FeePool: feePool,
				SystemStatus: systemStatus,
				RwarUSD: rUSDContract,
				RwarBTC: rBTCContract,
				RwasEUR: sEURContract,
				RwasAUD: sAUDContract,
				RwarETH: rETHContract,
				SystemSettings: systemSettings,
				DelegateApprovals: delegateApprovals,
				AddressResolver: resolver,
				DebtCache: debtCache,
				Issuer: issuer,
				CircuitBreaker: circuitBreaker,
				FlexibleStorage: flexibleStorage,
			} = await setupAllContracts({
				accounts,
				rwas: rwas,
				contracts: [
					// L1 specific
					'Rwaone',
					'ExchangerWithFeeRecAlternatives',
					'ExchangeRatesWithDexPricing',
					// Same between L1 and L2
					'ExchangeState',
					'DebtCache',
					'Issuer', // necessary for rwaone transfers to succeed
					'FeePool',
					'FeePoolEternalStorage',
					'SystemStatus',
					'SystemSettings',
					'DelegateApprovals',
					'FlexibleStorage',
					'CircuitBreaker',
					'CollateralManager',
				],
				mocks: {
					// Use a real VirtualRwaMastercopy so the spec tests can interrogate deployed vRwas
					VirtualRwaMastercopy: await VirtualRwaMastercopy.new(),
				},
			}));

			await setupPriceAggregators(exchangeRates, owner, rwas.map(toBytes32));

			amountIssued = toUnit('1000');

			// give the first two accounts 1000 rUSD each
			await rUSDContract.issue(account1, amountIssued);
			await rUSDContract.issue(account2, amountIssued);
		});

		addSnapshotBeforeRestoreAfterEach();

		beforeEach(async () => {
			const keys = [sAUD, sEUR, wRWAX, rETH, rBTC, iBTC];
			const rates = ['0.5', '2', '1', '100', '5000', '5000'].map(toUnit);
			await setupPriceAggregators(exchangeRates, owner, keys);
			await updateRates(keys, rates);

			exchangeFeeRate = toUnit('0.005');
			await setExchangeFeeRateForRwas({
				owner,
				systemSettings,
				rwaKeys,
				exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
			});
		});

		itReadsTheWaitingPeriod();

		itWhenTheWaitingPeriodIsZero();

		itDeviatesCorrectly();

		itCalculatesMaxSecsLeft();

		itCalculatesFeeRateForExchange();

		itCalculatesFeeRateForExchange2();

		itSettles();

		itCalculatesAmountAfterSettlement();

		itExchanges();

		itExchangesWithVirtual();

		itExchangesAtomically();

		itPricesSpikeDeviation();

		itSetsExchangeFeeRateForRwas();
	});

	describe('With L2 configuration (MintableRwaone, Exchanger, ExchangeRates)', () => {
		before(async () => {
			const rwas = ['rUSD', 'rETH', 'sEUR', 'sAUD', 'rBTC', 'iBTC', 'sTRX'];
			({
				Exchanger: exchanger,
				Rwaone: rwaone,
				ExchangeRates: exchangeRates,
				ExchangeState: exchangeState,
				FeePool: feePool,
				SystemStatus: systemStatus,
				RwarUSD: rUSDContract,
				RwarBTC: rBTCContract,
				RwasEUR: sEURContract,
				RwasAUD: sAUDContract,
				RwarETH: rETHContract,
				SystemSettings: systemSettings,
				DelegateApprovals: delegateApprovals,
				AddressResolver: resolver,
				DebtCache: debtCache,
				Issuer: issuer,
				CircuitBreaker: circuitBreaker,
				FlexibleStorage: flexibleStorage,
			} = await setupAllContracts({
				accounts,
				rwas: rwas,
				contracts: [
					// L2 specific
					'MintableRwaone',
					'Exchanger',
					'ExchangeRates',
					// Same between L1 and L2
					'ExchangeState',
					'DebtCache',
					'Issuer', // necessary for rwaone transfers to succeed
					'FeePool',
					'FeePoolEternalStorage',
					'SystemStatus',
					'SystemSettings',
					'DelegateApprovals',
					'FlexibleStorage',
					'CircuitBreaker',
					'CollateralManager',
				],
			}));

			await setupPriceAggregators(exchangeRates, owner, rwas.map(toBytes32));

			amountIssued = toUnit('1000');

			// give the first two accounts 1000 rUSD each
			await rUSDContract.issue(account1, amountIssued);
			await rUSDContract.issue(account2, amountIssued);
		});

		addSnapshotBeforeRestoreAfterEach();

		beforeEach(async () => {
			const keys = [sAUD, sEUR, wRWAX, rETH, rBTC, iBTC];
			const rates = ['0.5', '2', '1', '100', '5000', '5000'].map(toUnit);
			await setupPriceAggregators(exchangeRates, owner, keys);
			await updateRates(keys, rates);

			// set a 0.5% exchange fee rate (1/200)
			exchangeFeeRate = toUnit('0.005');
			await setExchangeFeeRateForRwas({
				owner,
				systemSettings,
				rwaKeys,
				exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
			});
		});

		itReadsTheWaitingPeriod();

		itWhenTheWaitingPeriodIsZero();

		itDeviatesCorrectly();

		itCalculatesMaxSecsLeft();

		itCalculatesFeeRateForExchange();

		itCalculatesFeeRateForExchange2();

		itSettles();

		itCalculatesAmountAfterSettlement();

		itExchanges();

		itFailsToExchangeWithVirtual();

		itFailsToExchangeAtomically();

		itPricesSpikeDeviation();

		itSetsExchangeFeeRateForRwas();
	});

	/**
	 * the purpose of this test section is to ensure trades are utilizing all the settings supplied by DirectIntegration rather than elsewhere
	 */
	describe('With Direct Integration overrides configuration (Rwaone, ExchangerWithFeeRecAlternatives, ExchangeRatesWithDexPricing)', () => {
		before(async () => {
			const VirtualRwaMastercopy = artifacts.require('VirtualRwaMastercopy');
			const rwas = ['rUSD', 'rETH', 'sEUR', 'sAUD', 'rBTC', 'iBTC', 'sTRX'];

			({
				Exchanger: exchanger,
				DirectIntegrationManager: directIntegration,
				Rwaone: rwaone,
				ExchangeRates: exchangeRates,
				ExchangeState: exchangeState,
				FeePool: feePool,
				SystemStatus: systemStatus,
				RwarUSD: rUSDContract,
				RwarBTC: rBTCContract,
				RwasEUR: sEURContract,
				RwasAUD: sAUDContract,
				RwarETH: rETHContract,
				SystemSettings: systemSettings,
				DelegateApprovals: delegateApprovals,
				AddressResolver: resolver,
				DebtCache: debtCache,
				Issuer: issuer,
				CircuitBreaker: circuitBreaker,
				FlexibleStorage: flexibleStorage,
			} = await setupAllContracts({
				accounts,
				rwas: rwas,
				contracts: [
					// L1 specific
					'Rwaone',
					'ExchangerWithFeeRecAlternatives',
					'ExchangeRatesWithDexPricing',
					// Same between L1 and L2
					'DirectIntegrationManager',
					'ExchangeState',
					'DebtCache',
					'Issuer', // necessary for rwaone transfers to succeed
					'FeePool',
					'FeePoolEternalStorage',
					'SystemStatus',
					'SystemSettings',
					'DelegateApprovals',
					'FlexibleStorage',
					'CircuitBreaker',
					'CollateralManager',
				],
				mocks: {
					// Use a real VirtualRwaMastercopy so the spec tests can interrogate deployed vRwas
					VirtualRwaMastercopy: await VirtualRwaMastercopy.new(),
				},
			}));

			await setupPriceAggregators(exchangeRates, owner, rwas.map(toBytes32));

			amountIssued = toUnit('1000');

			// give the first two accounts 1000 rUSD each
			await rUSDContract.issue(account1, amountIssued);
			await rUSDContract.issue(account2, amountIssued);
		});

		// set a bunch of fake systemsettings that will surely break the usual tests if not
		before('apply systemsettings & override ', async () => {
			const realDexPriceAggregator = await exchangeRates.dexPriceAggregator();
			const realAtomicTwapWindow = await systemSettings.atomicTwapWindow();
			const realAtomicMaxVolumePerBlock = await systemSettings.atomicMaxVolumePerBlock();
			const realExchangeMaxDynamicFee = await systemSettings.exchangeMaxDynamicFee();
			const realExchangeDynamicFeeRounds = await systemSettings.exchangeDynamicFeeRounds();
			const realExchangeDynamicFeeThreshold = await systemSettings.exchangeDynamicFeeThreshold();
			const realExchangeDynamicFeeWeightDecay = await systemSettings.exchangeDynamicFeeWeightDecay();

			for (const token of [rUSD, sAUD, sEUR, wRWAX, rBTC, iBTC, rETH, iETH]) {
				const overrideParams = [ethers.utils.formatBytes32String('')];
				overrideParams.push(realDexPriceAggregator);
				overrideParams.push(await systemSettings.atomicEquivalentForDexPricing(token));

				if (overrideParams[overrideParams.length - 1] !== ethers.constants.AddressZero) {
					await systemSettings.setAtomicEquivalentForDexPricing(token, account3, { from: owner });
				}

				overrideParams.push(await systemSettings.atomicExchangeFeeRate(token));
				if (!overrideParams[overrideParams.length - 1].isZero()) {
					await systemSettings.setAtomicExchangeFeeRate(token, 100, { from: owner });
				}

				overrideParams.push(realAtomicTwapWindow);
				overrideParams.push(realAtomicMaxVolumePerBlock);

				overrideParams.push(await systemSettings.atomicVolatilityConsiderationWindow(token));
				if (!overrideParams[overrideParams.length - 1].isZero()) {
					await systemSettings.setAtomicVolatilityConsiderationWindow(token, 500, { from: owner });
				}

				overrideParams.push(await systemSettings.atomicVolatilityUpdateThreshold(token));
				if (!overrideParams[overrideParams.length - 1].isZero()) {
					await systemSettings.setAtomicVolatilityUpdateThreshold(token, 700, { from: owner });
				}

				overrideParams.push(await systemSettings.exchangeFeeRate(token));
				if (!overrideParams[overrideParams.length - 1].isZero()) {
					await systemSettings.setExchangeFeeRateForRwas([token], [800], { from: owner });
				}

				overrideParams.push(realExchangeMaxDynamicFee);
				overrideParams.push(realExchangeDynamicFeeRounds);
				overrideParams.push(realExchangeDynamicFeeThreshold);
				overrideParams.push(realExchangeDynamicFeeWeightDecay);

				for (const account of [owner, account1, account2]) {
					await directIntegration.setExchangeParameters(account, [token], overrideParams, {
						from: owner,
					});
				}
			}

			// All the non-token specific settings
			await exchangeRates.setDexPriceAggregator(account3, { from: owner });
			await systemSettings.setAtomicTwapWindow(200, { from: owner });
			await systemSettings.setAtomicMaxVolumePerBlock(400, { from: owner });
			await systemSettings.setExchangeMaxDynamicFee(900, { from: owner });
			await systemSettings.setExchangeDynamicFeeRounds(0, { from: owner });
			await systemSettings.setExchangeDynamicFeeThreshold(1100, { from: owner });
			await systemSettings.setExchangeDynamicFeeWeightDecay(1200, { from: owner });
		});

		addSnapshotBeforeRestoreAfterEach();

		beforeEach(async () => {
			const keys = [sAUD, sEUR, wRWAX, rETH, rBTC, iBTC];
			const rates = ['0.5', '2', '1', '100', '5000', '5000'].map(toUnit);
			await setupPriceAggregators(exchangeRates, owner, keys);
			await updateRates(keys, rates);

			exchangeFeeRate = toUnit('0.005');
			await setExchangeFeeRateForRwas({
				owner,
				systemSettings,
				rwaKeys,
				exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
			});
		});

		itReadsTheWaitingPeriod();

		itWhenTheWaitingPeriodIsZero();

		itDeviatesCorrectly();

		itCalculatesMaxSecsLeft();

		itCalculatesFeeRateForExchange();

		itCalculatesFeeRateForExchange2();

		itSettles();

		itCalculatesAmountAfterSettlement();

		itExchanges();

		itExchangesWithVirtual();

		itExchangesAtomically();

		itPricesSpikeDeviation();

		itSetsExchangeFeeRateForRwas();
	});
});
