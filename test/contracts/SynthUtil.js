'use strict';

const { contract } = require('hardhat');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { toBytes32 } = require('../..');
const { toUnit } = require('../utils')();
const {
	setExchangeFeeRateForRwas,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('RwaUtil', accounts => {
	const [, ownerAccount, , account2] = accounts;
	let rwaUtil, rUSDContract, rwaone, exchangeRates, systemSettings, debtCache, circuitBreaker;

	const [rUSD, rBTC, iBTC, wRWAX] = ['rUSD', 'rBTC', 'iBTC', 'wRWAX'].map(toBytes32);
	const rwaKeys = [rUSD, rBTC, iBTC];
	const rwaPrices = [toUnit('1'), toUnit('5000'), toUnit('5000')];

	before(async () => {
		({
			RwaUtil: rwaUtil,
			RwarUSD: rUSDContract,
			Rwaone: rwaone,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			CircuitBreaker: circuitBreaker,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			rwas: ['rUSD', 'rBTC', 'iBTC'],
			contracts: [
				'RwaUtil',
				'Rwaone',
				'Exchanger',
				'ExchangeRates',
				'ExchangeState',
				'FeePoolEternalStorage',
				'SystemSettings',
				'DebtCache',
				'Issuer',
				'LiquidatorRewards',
				'CollateralManager',
				'CircuitBreaker',
				'RewardEscrowV2', // required for issuer._collateral to read collateral
			],
		}));

		await setupPriceAggregators(exchangeRates, ownerAccount, [rBTC, iBTC]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[rBTC, iBTC, wRWAX],
			['5000', '5000', '0.2'].map(toUnit)
		);
		await debtCache.takeDebtSnapshot();

		// set a 0% default exchange fee rate for test purpose
		const exchangeFeeRate = toUnit('0');
		await setExchangeFeeRateForRwas({
			owner: ownerAccount,
			systemSettings,
			rwaKeys,
			exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
		});
	});

	describe('given an instance', () => {
		const rUSDMinted = toUnit('10000');
		const amountToExchange = toUnit('50');
		const rUSDAmount = toUnit('100');
		beforeEach(async () => {
			await rwaone.issueRwas(rUSDMinted, {
				from: ownerAccount,
			});
			await rUSDContract.transfer(account2, rUSDAmount, { from: ownerAccount });
			await rwaone.exchange(rUSD, amountToExchange, rBTC, { from: account2 });
		});
		describe('totalRwasInKey', () => {
			it('should return the total balance of rwas into the specified currency key', async () => {
				assert.bnEqual(await rwaUtil.totalRwasInKey(account2, rUSD), rUSDAmount);
			});
		});
		describe('rwasBalances', () => {
			it('should return the balance and its value in rUSD for every rwa in the wallet', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(rUSD, amountToExchange, rBTC);
				assert.deepEqual(await rwaUtil.rwasBalances(account2), [
					[rUSD, rBTC, iBTC],
					[toUnit('50'), effectiveValue, 0],
					[toUnit('50'), toUnit('50'), 0],
				]);
			});
		});
		describe('rwasRates', () => {
			it('should return the correct rwa rates', async () => {
				assert.deepEqual(await rwaUtil.rwasRates(), [rwaKeys, rwaPrices]);
			});
		});
		describe('rwasTotalSupplies', () => {
			it('should return the correct rwa total supplies', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(rUSD, amountToExchange, rBTC);
				assert.deepEqual(await rwaUtil.rwasTotalSupplies(), [
					rwaKeys,
					[rUSDMinted.sub(amountToExchange), effectiveValue, 0],
					[rUSDMinted.sub(amountToExchange), amountToExchange, 0],
				]);
			});
		});
	});
});
