const { artifacts, contract, web3 } = require('hardhat');
const { toBN } = web3.utils;
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { updateAggregatorRates } = require('./helpers');
const { setupAllContracts, setupContract } = require('./setup');
const { toUnit } = require('../utils')();
const { toBytes32, constants } = require('../..');
const {
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	getDecodedLogs,
	decodedEventEqual,
} = require('./helpers');
const ZERO_ADDRESS = constants.ZERO_ADDRESS;

const MockExchanger = artifacts.require('MockExchanger');

contract('FuturesMarketManager', accounts => {
	let futuresMarketManager,
		futuresMarketSettings,
		systemSettings,
		exchangeRates,
		circuitBreaker,
		rUSD,
		debtCache,
		rwaone,
		addressResolver;
	const owner = accounts[1];
	const trader = accounts[2];
	const initialMint = toUnit('100000');

	async function setPrice(asset, price, resetCircuitBreaker = true) {
		await updateAggregatorRates(
			exchangeRates,
			resetCircuitBreaker ? circuitBreaker : null,
			[asset],
			[price]
		);
	}

	before(async () => {
		({
			FuturesMarketManager: futuresMarketManager,
			FuturesMarketSettings: futuresMarketSettings,
			ExchangeRates: exchangeRates,
			CircuitBreaker: circuitBreaker,
			TriberUSD: rUSD,
			DebtCache: debtCache,
			Rwaone: rwaone,
			AddressResolver: addressResolver,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			tribes: ['rUSD'],
			feeds: ['BTC', 'ETH', 'LINK'],
			contracts: [
				'FuturesMarketManager',
				'FuturesMarketSettings',
				'AddressResolver',
				'FeePool',
				'ExchangeRates',
				'CircuitBreaker',
				'ExchangeCircuitBreaker',
				'SystemStatus',
				'SystemSettings',
				'Rwaone',
				'Exchanger',
				'DebtCache',
				'CollateralManager',
			],
		}));

		await rUSD.issue(trader, initialMint, { from: owner });
	});

	addSnapshotBeforeRestoreAfterEach();

	describe('Basic parameters', () => {
		it('Requires rUSD contract', async () => {
			const required = await futuresMarketManager.resolverAddressesRequired();
			assert.deepEqual(required, ['TriberUSD', 'FeePool', 'Exchanger'].map(toBytes32));
		});

		it('only expected functions are mutable', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: futuresMarketManager.abi,
				ignoreParents: ['Owned', 'MixinResolver'],
				expected: [
					'addMarkets',
					'addProxiedMarkets',
					'removeMarkets',
					'removeMarketsByKey',
					'issueRUSD',
					'burnRUSD',
					'payFee',
					'payFee',
					'updateMarketsImplementations',
					'addEndorsedAddresses',
					'removeEndorsedAddresses',
				],
			});
		});

		it('contract has CONTRACT_NAME getter', async () => {
			assert.equal(await futuresMarketManager.CONTRACT_NAME(), toBytes32('FuturesMarketManager'));
		});
	});

	describe('Market management', () => {
		const currencyKeys = ['rBTC', 'rETH'].map(toBytes32);
		let markets, addresses;
		beforeEach(async () => {
			markets = await Promise.all(
				currencyKeys.map(k =>
					setupContract({
						accounts,
						contract: 'MockFuturesMarket',
						args: [futuresMarketManager.address, k, k, toUnit('1000'), false],
						skipPostDeploy: true,
					})
				)
			);

			addresses = markets.map(m => m.address);
			await futuresMarketManager.addMarkets(addresses, { from: owner });
		});

		it('Adding a single market', async () => {
			const markets = await futuresMarketManager.allMarkets();
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(markets.length));
			assert.bnEqual(
				await futuresMarketManager.methods['numMarkets(bool)'](false),
				toBN(markets.length)
			);
			assert.equal(markets.length, 2);
			assert.deepEqual(markets, addresses);

			const market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('sLINK'),
					toBytes32('sLINK'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await futuresMarketManager.addMarkets([market.address], { from: owner });
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(3));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(3));
			assert.equal((await futuresMarketManager.markets(2, 1))[0], market.address);

			assert.equal(await futuresMarketManager.marketForKey(toBytes32('sLINK')), market.address);
		});

		it('Adding multiple markets', async () => {
			const keys = ['sLINK', 'sRWAX'].map(toBytes32);
			const markets = await Promise.all(
				keys.map(k =>
					setupContract({
						accounts,
						contract: 'MockFuturesMarket',
						args: [futuresMarketManager.address, k, k, toUnit('1000'), false],
						skipPostDeploy: true,
					})
				)
			);
			const addresses = markets.map(m => m.address);
			const tx = await futuresMarketManager.addMarkets(addresses, { from: owner });
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(4));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(4));
			assert.deepEqual(await futuresMarketManager.markets(2, 2), addresses);
			assert.deepEqual(await futuresMarketManager.marketsForKeys(keys), addresses);

			const decodedLogs = await getDecodedLogs({ hash: tx.tx, contracts: [futuresMarketManager] });
			assert.equal(decodedLogs.length, 2);
			decodedEventEqual({
				event: 'MarketAdded',
				emittedFrom: futuresMarketManager.address,
				args: [addresses[0], keys[0], keys[0]],
				log: decodedLogs[0],
			});
			decodedEventEqual({
				event: 'MarketAdded',
				emittedFrom: futuresMarketManager.address,
				args: [addresses[1], keys[1], keys[1]],
				log: decodedLogs[1],
			});
		});

		it('Cannot add more than one market for the same key.', async () => {
			const market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('rETH'),
					toBytes32('rETH'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await assert.revert(
				futuresMarketManager.addMarkets([market.address], { from: owner }),
				'Market already exists'
			);
		});

		it('Can add more than one market for the same asset', async () => {
			const firstKey = currencyKeys[1];
			const market1 = markets[1];

			const secondKey = toBytes32('rETH-2'); // different market key
			const market2 = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					await market1.baseAsset(),
					secondKey,
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await futuresMarketManager.addMarkets([market2.address], { from: owner });

			// check correcr addresses returned
			assert.equal(await futuresMarketManager.marketForKey(secondKey), market2.address);
			assert.equal(await futuresMarketManager.marketForKey(firstKey), market1.address);
		});

		it('Removing a single market', async () => {
			await futuresMarketManager.removeMarkets([addresses[0]], { from: owner });

			const markets = await futuresMarketManager.allMarkets();
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(1));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(1));
			assert.deepEqual(markets, [addresses[1]]);

			assert.equal(await futuresMarketManager.marketForKey(currencyKeys[0]), ZERO_ADDRESS);
		});

		it('Removing multiple markets', async () => {
			const tx = await futuresMarketManager.removeMarkets(addresses, { from: owner });
			const markets = await futuresMarketManager.allMarkets();
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(0));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(0));
			assert.deepEqual(markets, []);
			assert.deepEqual(await futuresMarketManager.marketsForKeys(currencyKeys), [
				ZERO_ADDRESS,
				ZERO_ADDRESS,
			]);

			const decodedLogs = await getDecodedLogs({ hash: tx.tx, contracts: [futuresMarketManager] });
			assert.equal(decodedLogs.length, 2);
			decodedEventEqual({
				event: 'MarketRemoved',
				emittedFrom: futuresMarketManager.address,
				args: [addresses[0], currencyKeys[0]],
				log: decodedLogs[0],
			});
			decodedEventEqual({
				event: 'MarketRemoved',
				emittedFrom: futuresMarketManager.address,
				args: [addresses[1], currencyKeys[1]],
				log: decodedLogs[1],
			});
		});

		it('Removing markets by key', async () => {
			await futuresMarketManager.removeMarketsByKey([toBytes32('rETH')], { from: owner });

			let markets = await futuresMarketManager.allMarkets();
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(1));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(1));
			assert.deepEqual(markets, [addresses[0]]);

			const market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('sLINK'),
					toBytes32('sLINK'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await futuresMarketManager.addMarkets([market.address], { from: owner });
			await futuresMarketManager.removeMarketsByKey(['rBTC', 'sLINK'].map(toBytes32), {
				from: owner,
			});

			markets = await futuresMarketManager.allMarkets();
			assert.bnEqual(await futuresMarketManager.numMarkets(), toBN(0));
			assert.bnEqual(await futuresMarketManager.methods['numMarkets(bool)'](false), toBN(0));
			assert.deepEqual(markets, []);
		});

		it('Cannot remove a market which does not exist', async () => {
			await assert.revert(
				futuresMarketManager.removeMarketsByKey([toBytes32('sLINK')], { from: owner }),
				'Unknown market'
			);

			const market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('sLINK'),
					toBytes32('sLINK'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await assert.revert(
				futuresMarketManager.removeMarkets([market.address], { from: owner }),
				'Unknown market'
			);
		});

		it('Only the owner can add or remove markets', async () => {
			const market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('sLINK'),
					toBytes32('sLINK'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});

			const revertReason = 'Only the contract owner may perform this action';

			await onlyGivenAddressCanInvoke({
				fnc: futuresMarketManager.addMarkets,
				args: [[market.address]],
				accounts,
				address: owner,
				skipPassCheck: false,
				reason: revertReason,
			});

			await onlyGivenAddressCanInvoke({
				fnc: futuresMarketManager.removeMarkets,
				args: [[market.address]],
				accounts,
				address: owner,
				skipPassCheck: false,
				reason: revertReason,
			});

			await onlyGivenAddressCanInvoke({
				fnc: futuresMarketManager.removeMarketsByKey,
				args: [['rETH', 'rBTC'].map(toBytes32)],
				accounts,
				address: owner,
				skipPassCheck: false,
				reason: revertReason,
			});
		});
	});

	describe('rUSD issuance', () => {
		let market;
		beforeEach(async () => {
			market = await setupContract({
				accounts,
				contract: 'MockFuturesMarket',
				args: [
					futuresMarketManager.address,
					toBytes32('sLINK'),
					toBytes32('sLINK'),
					toUnit('1000'),
					false,
				],
				skipPostDeploy: true,
			});
			await futuresMarketManager.addMarkets([market.address], { from: owner });
		});

		it('issuing/burning rUSD', async () => {
			await market.issueRUSD(owner, toUnit('10'));
			assert.bnEqual(await rUSD.balanceOf(owner), toUnit('10'));

			await market.burnRUSD(owner, toUnit('5'));
			assert.bnEqual(await rUSD.balanceOf(owner), toUnit('5'));

			await market.issueRUSD(owner, toUnit('2'));
			await market.burnRUSD(owner, toUnit('7'));

			assert.bnEqual(await rUSD.balanceOf(owner), toUnit('0'));
			await assert.revert(market.burnRUSD(owner, toUnit('1')), 'SafeMath: subtraction overflow');
		});

		it('burning respects settlement', async () => {
			// Set up a mock exchanger
			const mockExchanger = await MockExchanger.new(rwaone.address);
			await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [mockExchanger.address], {
				from: owner,
			});
			await rwaone.rebuildCache();
			await futuresMarketManager.rebuildCache();

			await mockExchanger.setReclaim(toUnit('10'));
			await mockExchanger.setNumEntries('1');

			// Issuance works fine
			await market.issueRUSD(owner, toUnit('100'));
			assert.bnEqual(await rUSD.balanceOf(owner), toUnit('100'));

			// But burning properly deducts the reclamation amount
			await market.burnRUSD(owner, toUnit('90'));
			assert.bnEqual(await rUSD.balanceOf(owner), toUnit('0'));
		});

		it('only markets are permitted to issue or burn rUSD', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: futuresMarketManager.issueRUSD,
				args: [owner, toUnit('1')],
				accounts,
				skipPassCheck: true,
				reason: 'Permitted only for market implementations',
			});
			await onlyGivenAddressCanInvoke({
				fnc: futuresMarketManager.burnRUSD,
				args: [owner, toUnit('1')],
				accounts,
				skipPassCheck: true,
				reason: 'Permitted only for market implementations',
			});
		});
	});

	describe('Aggregated Debt', () => {
		it('futures debt is zero when no markets are deployed', async () => {
			// check initial debt
			const initialSystemDebt = (await debtCache.currentDebt())[0];
			// issue some rUSD
			rUSD.issue(trader, toUnit(100), { from: owner });
			await debtCache.takeDebtSnapshot();
			// check debt currentDebt() works as expected
			assert.bnEqual((await debtCache.currentDebt())[0], initialSystemDebt.add(toUnit(100)));
		});

		describe('when there are multiple markets', () => {
			const individualDebt = toUnit('1000');
			const currencyKeys = ['rBTC', 'rETH', 'sLINK'].map(toBytes32);
			let markets;
			beforeEach(async () => {
				markets = await Promise.all(
					currencyKeys.map(k =>
						setupContract({
							accounts,
							contract: 'MockFuturesMarket',
							args: [futuresMarketManager.address, k, k, individualDebt, false],
							skipPostDeploy: true,
						})
					)
				);
				await futuresMarketManager.addMarkets(
					markets.map(m => m.address),
					{ from: owner }
				);
			});

			it('Aggregated debt updates properly as the debt values change', async () => {
				const initialSystemDebt = (await debtCache.currentDebt())[0];

				assert.bnEqual((await futuresMarketManager.totalDebt())[0], individualDebt.mul(toBN(3)));
				assert.bnEqual(initialSystemDebt, individualDebt.mul(toBN(3)).add(initialMint));
				await markets[0].setMarketDebt(toUnit('2500'));
				await markets[1].setMarketDebt(toUnit('200'));
				assert.bnEqual((await futuresMarketManager.totalDebt())[0], toUnit('3700'));
				assert.bnEqual((await debtCache.currentDebt())[0], initialSystemDebt.add(toUnit('700')));

				await futuresMarketManager.removeMarkets([markets[2].address], { from: owner });
				assert.bnEqual((await futuresMarketManager.totalDebt())[0], toUnit('2700'));
				assert.bnEqual((await debtCache.currentDebt())[0], initialSystemDebt.sub(toUnit('300')));
				const market = await setupContract({
					accounts,
					contract: 'MockFuturesMarket',
					args: [
						futuresMarketManager.address,
						toBytes32('sLINK'),
						toBytes32('sLINK'),
						toUnit('4000'),
						false,
					],
					skipPostDeploy: true,
				});
				await futuresMarketManager.addMarkets([market.address], { from: owner });

				assert.bnEqual((await futuresMarketManager.totalDebt())[0], toUnit('6700'));
				assert.bnEqual((await debtCache.currentDebt())[0], initialSystemDebt.add(toUnit('3700')));
			});

			it('Aggregated debt validity updates properly with the individual markets', async () => {
				assert.isFalse((await futuresMarketManager.totalDebt())[1]);
				assert.isFalse((await debtCache.currentDebt())[1]);

				await markets[0].setInvalid(true);
				assert.isTrue((await futuresMarketManager.totalDebt())[1]);
				assert.isTrue((await debtCache.currentDebt())[1]);

				await markets[0].setInvalid(false);
				await markets[2].setInvalid(true);
				assert.isTrue((await futuresMarketManager.totalDebt())[1]);
				assert.isTrue((await debtCache.currentDebt())[1]);

				await futuresMarketManager.removeMarkets([markets[2].address], { from: owner });
				assert.isFalse((await futuresMarketManager.totalDebt())[1]);
				assert.isFalse((await debtCache.currentDebt())[1]);
			});
		});
	});

	// helpful views
	describe('Market summaries', () => {
		const traderInitialBalance = toUnit(1000000);
		const assets = ['BTC', 'ETH', 'LINK'];
		const marketKeys = [];
		const markets = [];

		beforeEach(async () => {
			// Add v1 markets
			for (const symbol of assets) {
				const assetKey = toBytes32(symbol);
				const marketKey = toBytes32('s' + symbol);

				const market = await setupContract({
					accounts,
					contract: 'FuturesMarket',
					args: [
						addressResolver.address,
						assetKey, // base asset
						marketKey,
					],
				});

				markets.push(market);
				marketKeys.push(marketKey);

				await addressResolver.rebuildCaches([market.address], { from: owner });

				await futuresMarketManager.addMarkets([market.address], { from: owner });

				await setPrice(assetKey, toUnit(1000));

				// Now that the market exists we can set the all its parameters
				await futuresMarketSettings.setParameters(
					marketKey,
					toUnit('0.005'), // 0.5% taker fee
					toUnit('0.001'), // 0.1% maker fee
					toUnit('0.0005'), // 0.05% taker fee next price
					toUnit('0'), // 0% maker fee next price
					toBN('2'), // 2 rounds next price confirm window
					toUnit('5'), // 5x max leverage
					toUnit('1000000'), // 1000000 max total margin
					toUnit('0.2'), // 20% max funding rate
					toUnit('100000'), // 100000 USD skewScaleUSD
					{ from: owner }
				);
			}

			// disable dynamic fee for simpler testing
			await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

			// Issue the traders some rUSD
			await rUSD.issue(trader, traderInitialBalance);

			// Update the rates to ensure they aren't stale
			await setPrice(await markets[0].baseAsset(), toUnit(100));

			// The traders take positions on market
			await markets[0].transferMargin(toUnit('1000'), { from: trader });
			await markets[0].modifyPosition(toUnit('5'), { from: trader });

			await markets[1].transferMargin(toUnit('3000'), { from: trader });
			await markets[1].modifyPosition(toUnit('4'), { from: trader });
			await setPrice(await markets[1].baseAsset(), toUnit('999'));
		});

		it('For markets', async () => {
			const market = markets[1];
			const assetKey = toBytes32(assets[1]);
			const marketKey = marketKeys[1];
			const summary = (await futuresMarketManager.marketSummariesForKeys([marketKey]))[0];

			const { price } = await market.assetPrice();

			assert.equal(summary.market, market.address);
			assert.equal(summary.marketKey, marketKey);
			assert.equal(summary.asset, assetKey);
			assert.equal(summary.price, price);
			assert.equal(summary.marketSize, await market.marketSize());
			assert.equal(summary.marketSkew, await market.marketSkew());
			assert.equal(summary.currentFundingRate, await market.currentFundingRate());
			assert.isBoolean(summary.proxied);
			assert.equal(
				summary.currentFundingVelocity,
				summary.proxied ? await market.currentFundingVelocity() : toBN(0)
			);
		});

		it('For market keys', async () => {
			const summaries = await futuresMarketManager.marketSummaries([
				markets[0].address,
				markets[1].address,
			]);
			const summariesForKeys = await futuresMarketManager.marketSummariesForKeys(
				marketKeys.slice(0, 2)
			);
			assert.equal(JSON.stringify(summaries), JSON.stringify(summariesForKeys));
		});

		it('All summaries', async () => {
			const summaries = await futuresMarketManager.allMarketSummaries();

			const btcSummary = summaries.find(summary => summary.marketKey === toBytes32('rBTC'));
			const ethSummary = summaries.find(summary => summary.marketKey === toBytes32('rETH'));
			const linkSummary = summaries.find(summary => summary.marketKey === toBytes32('sLINK'));

			assert.equal(btcSummary.market, markets[0].address);
			assert.equal(btcSummary.asset, toBytes32(assets[0]));
			let price = await markets[0].assetPrice();
			assert.equal(btcSummary.price, price.price);
			assert.equal(btcSummary.marketSize, await markets[0].marketSize());
			assert.equal(btcSummary.marketSkew, await markets[0].marketSkew());
			assert.equal(btcSummary.currentFundingRate, await markets[0].currentFundingRate());
			assert.isBoolean(btcSummary.proxied);
			assert.equal(
				btcSummary.currentFundingVelocity,
				btcSummary.proxied ? await markets[0].currentFundingVelocity() : toBN(0)
			);

			assert.equal(ethSummary.market, markets[1].address);
			assert.equal(ethSummary.asset, toBytes32(assets[1]));
			price = await markets[1].assetPrice();
			assert.equal(ethSummary.price, price.price);
			assert.equal(ethSummary.marketSize, await markets[1].marketSize());
			assert.equal(ethSummary.marketSkew, await markets[1].marketSkew());
			assert.equal(ethSummary.currentFundingRate, await markets[1].currentFundingRate());
			assert.isBoolean(ethSummary.proxied);
			assert.equal(
				ethSummary.currentFundingVelocity,
				ethSummary.proxied ? await markets[1].currentFundingVelocity() : toBN(0)
			);

			assert.equal(linkSummary.market, await futuresMarketManager.marketForKey(toBytes32('sLINK')));
			assert.equal(linkSummary.asset, toBytes32('LINK'));
			assert.equal(linkSummary.price, toUnit(1000));
			assert.equal(linkSummary.marketSize, toUnit(0));
			assert.equal(linkSummary.marketSkew, toUnit(0));
			assert.equal(linkSummary.currentFundingRate, toUnit(0));
			assert.equal(linkSummary.currentFundingVelocity, toUnit(0));
		});
	});
});
