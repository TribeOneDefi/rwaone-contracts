const { contract, web3 } = require('hardhat');
const { toBN } = web3.utils;
const { assert, addSnapshotBeforeRestoreAfter } = require('../contracts/common');
const { setupAllContracts } = require('../contracts/setup');
const { toUnit, multiplyDecimal } = require('../utils')();
const {
	setExchangeFeeRateForTribes,
	getDecodedLogs,
	decodedEventEqual,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');
const { toBytes32 } = require('../..');

/*
 * This tests the TradingRewards contract's integration
 * with the rest of the Tribeone system.
 *
 * Inner workings of the contract are tested in TradingRewards.unit.js.
 **/
contract('TradingRewards', accounts => {
	const [, owner, account1] = accounts;

	const tribes = ['hUSD', 'hETH', 'hBTC', 'HAKA'];
	const tribeKeys = tribes.map(toBytes32);
	const [hUSD, hETH, hBTC, HAKA] = tribeKeys;

	let tribeone, exchanger, exchangeRates, rewards, resolver, systemSettings;
	let hUSDContract, hETHContract, hBTCContract;

	let exchangeLogs;

	const zeroAddress = '0x0000000000000000000000000000000000000000';

	const amountIssued = toUnit('1000');
	const allExchangeFeeRates = toUnit('0.001');
	const rates = {
		[hETH]: toUnit('100'),
		[hBTC]: toUnit('12000'),
		[HAKA]: toUnit('0.2'),
	};

	let feesPaidUSD;

	async function getExchangeLogs({ exchangeTx }) {
		const logs = await getDecodedLogs({
			hash: exchangeTx.tx,
			contracts: [tribeone, rewards],
		});

		return logs.filter(log => log !== undefined);
	}

	async function executeTrade({ account, fromCurrencyKey, fromCurrencyAmount, toCurrencyKey }) {
		const exchangeTx = await tribeone.exchange(
			fromCurrencyKey,
			fromCurrencyAmount,
			toCurrencyKey,
			{
				from: account,
			}
		);

		const { fee } = await exchanger.getAmountsForExchange(
			fromCurrencyAmount,
			fromCurrencyKey,
			toCurrencyKey
		);

		const rate = rates[toCurrencyKey];
		feesPaidUSD = multiplyDecimal(fee, rate);

		exchangeLogs = await getExchangeLogs({ exchangeTx });
	}

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				Tribeone: tribeone,
				TradingRewards: rewards,
				AddressResolver: resolver,
				Exchanger: exchanger,
				ExchangeRates: exchangeRates,
				TribehUSD: hUSDContract,
				TribehETH: hETHContract,
				TribehBTC: hBTCContract,
				SystemSettings: systemSettings,
			} = await setupAllContracts({
				accounts,
				tribes,
				contracts: [
					'Tribeone',
					'TradingRewards',
					'Exchanger',
					'AddressResolver',
					'ExchangeRates',
					'SystemSettings',
					'CollateralManager',
				],
			}));

			await setupPriceAggregators(exchangeRates, owner, [hETH, hBTC]);
		});

		before('BRRRRRR', async () => {
			await hUSDContract.issue(account1, amountIssued);
			await hETHContract.issue(account1, amountIssued);
			await hBTCContract.issue(account1, amountIssued);
		});

		before('set exchange rates', async () => {
			await updateAggregatorRates(exchangeRates, null, [hETH, hBTC, HAKA], Object.values(rates));

			await setExchangeFeeRateForTribes({
				owner,
				systemSettings,
				tribeKeys,
				exchangeFeeRates: tribeKeys.map(() => allExchangeFeeRates),
			});
		});

		it('has expected balances for accounts', async () => {
			assert.bnEqual(amountIssued, await hUSDContract.balanceOf(account1));
			assert.bnEqual(amountIssued, await hETHContract.balanceOf(account1));
			assert.bnEqual(amountIssued, await hBTCContract.balanceOf(account1));
		});

		it('has expected parameters', async () => {
			assert.equal(owner, await rewards.getPeriodController());
			assert.equal(owner, await rewards.owner());
			assert.equal(tribeone.address, await rewards.getRewardsToken());
			assert.equal(resolver.address, await rewards.resolver());
		});

		describe('when SystemSettings tradingRewardsEnabled is false', () => {
			it('tradingRewardsEnabled is false', async () => {
				assert.isFalse(await systemSettings.tradingRewardsEnabled());
				assert.isFalse(await exchanger.tradingRewardsEnabled());
			});

			describe('when performing an exchange', () => {
				addSnapshotBeforeRestoreAfter();

				before('perform an exchange and get tx logs', async () => {
					await executeTrade({
						account: account1,
						fromCurrencyKey: hUSD,
						fromCurrencyAmount: toUnit('100'),
						toCurrencyKey: hETH,
					});
				});

				it('emitted a TribeExchange event', async () => {
					assert.isTrue(exchangeLogs.some(log => log.name === 'TribeExchange'));
				});

				it('did not emit an ExchangeFeeRecorded event', async () => {
					assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
				});

				it('did not record a fee in TradingRewards', async () => {
					assert.bnEqual(await rewards.getUnaccountedFeesForAccountForPeriod(account1, 0), toBN(0));
				});
			});
		});

		describe('when SystemSettings tradingRewardsEnabled is set to true', () => {
			before('set tradingRewardsEnabled to true', async () => {
				await systemSettings.setTradingRewardsEnabled(true, { from: owner });
			});

			it('tradingRewardsEnabled is true', async () => {
				assert.isTrue(await systemSettings.tradingRewardsEnabled());
				assert.isTrue(await exchanger.tradingRewardsEnabled());
			});

			const itCorrectlyPerformsAnExchange = ({
				account,
				fromCurrencyKey,
				fromCurrencyAmount,
				toCurrencyKey,
			}) => {
				describe('when performing a regular exchange', () => {
					addSnapshotBeforeRestoreAfter();

					before('perform an exchange and get tx logs', async () => {
						await executeTrade({
							account,
							fromCurrencyKey,
							fromCurrencyAmount,
							toCurrencyKey,
						});
					});

					it('emitted a TribeExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'TribeExchange'));
					});

					it('emitted an ExchangeFeeRecorded event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));

						const feeRecordLog = exchangeLogs.find(log => log.name === 'ExchangeFeeRecorded');
						decodedEventEqual({
							event: 'ExchangeFeeRecorded',
							log: feeRecordLog,
							emittedFrom: rewards.address,
							args: [account, feesPaidUSD, 0],
						});
					});

					it('recorded a fee in TradingRewards', async () => {
						assert.bnEqual(
							await rewards.getUnaccountedFeesForAccountForPeriod(account1, 0),
							feesPaidUSD
						);
					});
				});
			};

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: hUSD,
				fromCurrencyAmount: toUnit('100'),
				toCurrencyKey: hETH,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: hUSD,
				fromCurrencyAmount: toUnit('100'),
				toCurrencyKey: hBTC,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: hETH,
				fromCurrencyAmount: toUnit('10'),
				toCurrencyKey: hBTC,
			});

			itCorrectlyPerformsAnExchange({
				account: account1,
				fromCurrencyKey: hBTC,
				fromCurrencyAmount: toUnit('1'),
				toCurrencyKey: hETH,
			});

			describe('when exchangeFeeRate is set to 0', () => {
				addSnapshotBeforeRestoreAfter();

				before('set fee rate', async () => {
					const zeroRate = toBN(0);

					await setExchangeFeeRateForTribes({
						owner,
						systemSettings,
						tribeKeys,
						exchangeFeeRates: tribeKeys.map(() => zeroRate),
					});
				});

				describe('when performing an exchange', () => {
					before('perform an exchange and get tx logs', async () => {
						await executeTrade({
							account: account1,
							fromCurrencyKey: hUSD,
							fromCurrencyAmount: toUnit('100'),
							toCurrencyKey: hETH,
						});
					});

					it('emitted a TribeExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'TribeExchange'));
					});

					it('did not emit an ExchangeFeeRecorded event', async () => {
						assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});
			});

			describe('when executing an exchange with tracking', () => {
				addSnapshotBeforeRestoreAfter();

				describe('when a valid reward address is passed', () => {
					before('execute exchange with tracking', async () => {
						const exchangeTx = await tribeone.exchangeWithTracking(
							hUSD,
							toUnit('100'),
							hETH,
							account1,
							toBytes32('1INCH'),
							{
								from: account1,
							}
						);

						exchangeLogs = await getExchangeLogs({ exchangeTx });
					});

					it('emitted a TribeExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'TribeExchange'));
					});

					it('emitted an ExchangeFeeRecorded event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});

				describe('when no valid reward address is passed', () => {
					before('execute exchange with tracking', async () => {
						const exchangeTx = await tribeone.exchangeWithTracking(
							hUSD,
							toUnit('100'),
							hETH,
							zeroAddress, // No reward address = 0x0
							toBytes32('1INCH'),
							{
								from: account1,
							}
						);

						exchangeLogs = await getExchangeLogs({ exchangeTx });
					});

					it('emitted a TribeExchange event', async () => {
						assert.isTrue(exchangeLogs.some(log => log.name === 'TribeExchange'));
					});

					it('did not emit an ExchangeFeeRecorded event', async () => {
						assert.isFalse(exchangeLogs.some(log => log.name === 'ExchangeFeeRecorded'));
					});
				});
			});
		});
	});
});
