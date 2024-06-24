'use strict';

const { contract } = require('hardhat');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { toBytes32 } = require('../..');
const { toUnit } = require('../utils')();
const {
	setExchangeFeeRateForTribes,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('TribeUtil', accounts => {
	const [, ownerAccount, , account2] = accounts;
	let tribeUtil, hUSDContract, rwaone, exchangeRates, systemSettings, debtCache, circuitBreaker;

	const [hUSD, hBTC, iBTC, wHAKA] = ['hUSD', 'hBTC', 'iBTC', 'wHAKA'].map(toBytes32);
	const tribeKeys = [hUSD, hBTC, iBTC];
	const tribePrices = [toUnit('1'), toUnit('5000'), toUnit('5000')];

	before(async () => {
		({
			TribeUtil: tribeUtil,
			TribehUSD: hUSDContract,
			Rwaone: rwaone,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			CircuitBreaker: circuitBreaker,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			tribes: ['hUSD', 'hBTC', 'iBTC'],
			contracts: [
				'TribeUtil',
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

		await setupPriceAggregators(exchangeRates, ownerAccount, [hBTC, iBTC]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[hBTC, iBTC, wHAKA],
			['5000', '5000', '0.2'].map(toUnit)
		);
		await debtCache.takeDebtSnapshot();

		// set a 0% default exchange fee rate for test purpose
		const exchangeFeeRate = toUnit('0');
		await setExchangeFeeRateForTribes({
			owner: ownerAccount,
			systemSettings,
			tribeKeys,
			exchangeFeeRates: tribeKeys.map(() => exchangeFeeRate),
		});
	});

	describe('given an instance', () => {
		const hUSDMinted = toUnit('10000');
		const amountToExchange = toUnit('50');
		const hUSDAmount = toUnit('100');
		beforeEach(async () => {
			await rwaone.issueTribes(hUSDMinted, {
				from: ownerAccount,
			});
			await hUSDContract.transfer(account2, hUSDAmount, { from: ownerAccount });
			await rwaone.exchange(hUSD, amountToExchange, hBTC, { from: account2 });
		});
		describe('totalTribesInKey', () => {
			it('should return the total balance of tribes into the specified currency key', async () => {
				assert.bnEqual(await tribeUtil.totalTribesInKey(account2, hUSD), hUSDAmount);
			});
		});
		describe('tribesBalances', () => {
			it('should return the balance and its value in hUSD for every tribe in the wallet', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(hUSD, amountToExchange, hBTC);
				assert.deepEqual(await tribeUtil.tribesBalances(account2), [
					[hUSD, hBTC, iBTC],
					[toUnit('50'), effectiveValue, 0],
					[toUnit('50'), toUnit('50'), 0],
				]);
			});
		});
		describe('tribesRates', () => {
			it('should return the correct tribe rates', async () => {
				assert.deepEqual(await tribeUtil.tribesRates(), [tribeKeys, tribePrices]);
			});
		});
		describe('tribesTotalSupplies', () => {
			it('should return the correct tribe total supplies', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(hUSD, amountToExchange, hBTC);
				assert.deepEqual(await tribeUtil.tribesTotalSupplies(), [
					tribeKeys,
					[hUSDMinted.sub(amountToExchange), effectiveValue, 0],
					[hUSDMinted.sub(amountToExchange), amountToExchange, 0],
				]);
			});
		});
	});
});
