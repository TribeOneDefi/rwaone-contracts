'use strict';

const { artifacts, contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('../contracts/common');

const { fastForward, toUnit } = require('../utils')();

const { setupAllContracts } = require('../contracts/setup');

const {
	setExchangeFeeRateForRwas,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');

const { toBytes32 } = require('../..');

contract('ExchangeCircuitBreaker tests', async accounts => {
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

	const rwaKeys = [rUSD, sAUD, sEUR, rBTC, iBTC, rETH, iETH];

	const [, owner, account1, account2] = accounts;

	let rwaone,
		exchangeRates,
		rUSDContract,
		exchangeFeeRate,
		exchangeCircuitBreaker,
		circuitBreaker,
		amountIssued,
		systemSettings;

	// utility function update rates for aggregators that are already set up
	async function updateRates(keys, rates, resetCircuitBreaker = true) {
		await updateAggregatorRates(
			exchangeRates,
			resetCircuitBreaker ? circuitBreaker : null,
			keys,
			rates
		);
	}

	const itPricesSpikeDeviation = () => {
		// skipped because the relevant functionality has been replaced by `CircuitBreaker`
		describe('priceSpikeDeviation', () => {
			const baseRate = 100;

			const updateRate = ({ target, rate, resetCircuitBreaker }) => {
				beforeEach(async () => {
					await fastForward(10);
					await updateRates([target], [toUnit(rate.toString())], resetCircuitBreaker);
				});
			};

			describe(`when the price of rETH is ${baseRate}`, () => {
				updateRate({ target: rETH, rate: baseRate });

				describe('when price spike deviation is set to a factor of 2', () => {
					const baseFactor = 2;
					beforeEach(async () => {
						await systemSettings.setPriceDeviationThresholdFactor(toUnit(baseFactor.toString()), {
							from: owner,
						});
					});

					// lastExchangeRate, used for price deviations (SIP-65)
					describe('lastValue in new CircuitBreaker is persisted during exchanges', () => {
						describe('when a user exchanges into rETH from rUSD', () => {
							beforeEach(async () => {
								await rwaone.exchange(rUSD, toUnit('100'), rETH, { from: account1 });
							});
							it('and the dest side has a rate persisted', async () => {
								assert.bnEqual(
									await circuitBreaker.lastValue(await exchangeRates.aggregators(rETH)),
									toUnit(baseRate.toString())
								);
							});
						});
					});

					describe('the rateWithInvalid() view correctly returns status', () => {
						updateRate({ target: rETH, rate: baseRate, resetCircuitBreaker: true });

						let res;
						it('when called with a rwa with only a single rate, returns false', async () => {
							res = await exchangeCircuitBreaker.rateWithInvalid(rETH);
							assert.bnEqual(res[0], toUnit(baseRate));
							assert.equal(res[1], false);
						});
						it('when called with a rwa with no rate (i.e. 0), returns true', async () => {
							res = await exchangeCircuitBreaker.rateWithInvalid(toBytes32('XYZ'));
							assert.bnEqual(res[0], 0);
							assert.equal(res[1], true);
						});
						describe('when a rwa rate changes outside of the range', () => {
							updateRate({ target: rETH, rate: baseRate * 3, resetCircuitBreaker: false });

							it('when called with that rwa, returns true', async () => {
								res = await exchangeCircuitBreaker.rateWithInvalid(rETH);
								assert.bnEqual(res[0], toUnit(baseRate * 3));
								assert.equal(res[1], true);
							});
						});
					});
				});
			});
		});
	};

	describe('When using Rwaone', () => {
		before(async () => {
			const VirtualRwaMastercopy = artifacts.require('VirtualRwaMastercopy');

			({
				ExchangeCircuitBreaker: exchangeCircuitBreaker,
				CircuitBreaker: circuitBreaker,
				Rwaone: rwaone,
				ExchangeRates: exchangeRates,
				RwarUSD: rUSDContract,
				SystemSettings: systemSettings,
			} = await setupAllContracts({
				accounts,
				rwas: ['rUSD', 'rETH', 'sEUR', 'sAUD', 'rBTC', 'iBTC', 'sTRX'],
				contracts: [
					'Exchanger',
					'ExchangeCircuitBreaker',
					'CircuitBreaker',
					'ExchangeState',
					'ExchangeRates',
					'DebtCache',
					'Issuer', // necessary for rwaone transfers to succeed
					'FeePool',
					'FeePoolEternalStorage',
					'Rwaone',
					'SystemStatus',
					'SystemSettings',
					'DelegateApprovals',
					'FlexibleStorage',
					'CollateralManager',
				],
				mocks: {
					// Use a real VirtualRwaMastercopy so the spec tests can interrogate deployed vRwas
					VirtualRwaMastercopy: await VirtualRwaMastercopy.new(),
				},
			}));

			amountIssued = toUnit('1000');

			// give the first two accounts 1000 rUSD each
			await rUSDContract.issue(account1, amountIssued);
			await rUSDContract.issue(account2, amountIssued);
		});

		addSnapshotBeforeRestoreAfterEach();

		beforeEach(async () => {
			await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, wRWAX, rETH, rBTC, iBTC]);
			await updateRates(
				[sAUD, sEUR, wRWAX, rETH, rBTC, iBTC],
				['0.5', '2', '1', '100', '5000', '5000'].map(toUnit)
			);

			// set a 0.5% exchange fee rate (1/200)
			exchangeFeeRate = toUnit('0.005');
			await setExchangeFeeRateForRwas({
				owner,
				systemSettings,
				rwaKeys,
				exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
			});
		});

		itPricesSpikeDeviation();
	});
});
