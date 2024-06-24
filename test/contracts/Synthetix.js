'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

require('./common'); // import common test scaffolding

const { setupContract, setupAllContracts } = require('./setup');

const { fastForwardTo, toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	updateRatesWithDefaults,
	setupPriceAggregators,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { inflationStartTimestampInSecs },
} = require('../..');

contract('Rwaone', async accounts => {
	const [sAUD, sEUR, rUSD, rETH] = ['sAUD', 'sEUR', 'rUSD', 'rETH'].map(toBytes32);

	const [, owner, account1, account2, account3] = accounts;

	let rwaone,
		tribeetixProxy,
		exchangeRates,
		debtCache,
		supplySchedule,
		rewardEscrow,
		rewardEscrowV2,
		addressResolver,
		systemStatus,
		rUSDContract,
		rETHContract;

	before(async () => {
		({
			Rwaone: rwaone,
			ProxyERC20Rwaone: tribeetixProxy,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			DebtCache: debtCache,
			SystemStatus: systemStatus,
			RewardEscrow: rewardEscrow,
			RewardEscrowV2: rewardEscrowV2,
			SupplySchedule: supplySchedule,
			TriberUSD: rUSDContract,
			TriberETH: rETHContract,
		} = await setupAllContracts({
			accounts,
			tribes: ['rUSD', 'rETH', 'sEUR', 'sAUD'],
			contracts: [
				'Rwaone',
				'SupplySchedule',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'DebtCache',
				'Issuer',
				'LiquidatorRewards',
				'Exchanger',
				'RewardsDistribution',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral to read collateral
				'RewardEscrow',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		tribeetixProxy = await artifacts.require('Rwaone').at(tribeetixProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, rETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: rwaone.abi,
			ignoreParents: ['BaseRwaone'],
			expected: ['emitAtomicTribeExchange', 'migrateEscrowBalanceToRewardEscrowV2'],
		});
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const RWAONEETIX_TOTAL_SUPPLY = web3.utils.toWei('100000000');
			const instance = await setupContract({
				contract: 'Rwaone',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, RWAONEETIX_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), RWAONEETIX_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});
	});

	describe('mint() - inflationary supply minting', async () => {
		const INITIAL_WEEKLY_SUPPLY = 800000;

		const DAY = 86400;
		const WEEK = 604800;

		const INFLATION_START_DATE = inflationStartTimestampInSecs;
		// Set inflation amount
		beforeEach(async () => {
			await supplySchedule.setInflationAmount(toUnit(INITIAL_WEEKLY_SUPPLY), { from: owner });
		});
		describe('suspension conditions', () => {
			beforeEach(async () => {
				// ensure mint() can succeed by default
				const week234 = INFLATION_START_DATE + WEEK * 234;
				await fastForwardTo(new Date(week234 * 1000));
				await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
				await supplySchedule.setInflationAmount(toUnit(INITIAL_WEEKLY_SUPPLY), { from: owner });
			});
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling mint() reverts', async () => {
						await assert.revert(rwaone.mint(), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling mint() succeeds', async () => {
							await rwaone.mint();
						});
					});
				});
			});
		});
		it('should allow rwaone contract to mint for 234 weeks', async () => {
			// fast forward EVM - inflation supply at week 234
			const week234 = INFLATION_START_DATE + WEEK * 234 + DAY;
			await fastForwardTo(new Date(week234 * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingSupply = await rwaone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			const currentRewardEscrowBalance = await rwaone.balanceOf(rewardEscrow.address);

			// Call mint on Rwaone
			await rwaone.mint();

			const newTotalSupply = await rwaone.totalSupply();
			const minterReward = await supplySchedule.minterReward();

			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			// as the precise rounding is not exact but has no effect on the end result to 6 decimals.
			const expectedSupplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 234);
			const expectedNewTotalSupply = existingSupply.add(expectedSupplyToMint);
			assert.bnEqual(newTotalSupply, expectedNewTotalSupply);

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await rwaone.balanceOf(rewardEscrowV2.address), expectedEscrowBalance);
		});

		it('should allow rwaone contract to mint 2 weeks of supply and minus minterReward', async () => {
			// Issue
			const expectedSupplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 2);

			// fast forward EVM to Week 3 in of the inflationary supply
			const weekThree = INFLATION_START_DATE + WEEK * 2 + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingSupply = await rwaone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();
			const currentRewardEscrowBalance = await rwaone.balanceOf(rewardEscrow.address);

			// call mint on Rwaone
			await rwaone.mint();

			const newTotalSupply = await rwaone.totalSupply();

			const minterReward = await supplySchedule.minterReward();
			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			const expectedNewTotalSupply = existingSupply.add(expectedSupplyToMint);
			assert.bnEqual(newTotalSupply, expectedNewTotalSupply);

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await rwaone.balanceOf(rewardEscrowV2.address), expectedEscrowBalance);
		});

		it('should be able to mint again after another 7 days period', async () => {
			// fast forward EVM to Week 3 in Year 2 schedule starting at UNIX 1553040000+
			const weekThree = INFLATION_START_DATE + 2 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			let existingTotalSupply = await rwaone.totalSupply();
			let mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Rwaone
			await rwaone.mint();

			let newTotalSupply = await rwaone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			// fast forward EVM to Week 4
			const weekFour = weekThree + 1 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekFour * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			existingTotalSupply = await rwaone.totalSupply();
			mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Rwaone
			await rwaone.mint();

			newTotalSupply = await rwaone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));
		});

		it('should revert when trying to mint again within the 7 days period', async () => {
			// fast forward EVM to Week 3 of inflation
			const weekThree = INFLATION_START_DATE + 2 * WEEK + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingTotalSupply = await rwaone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on Rwaone
			await rwaone.mint();

			const newTotalSupply = await rwaone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			const weekFour = weekThree + DAY * 1;
			await fastForwardTo(new Date(weekFour * 1000));

			// should revert if try to mint again within 7 day period / mintable supply is 0
			await assert.revert(rwaone.mint(), 'No supply is mintable');
		});
	});

	describe('migration - transfer escrow balances to reward escrow v2', () => {
		let rewardEscrowBalanceBefore;
		beforeEach(async () => {
			// transfer wRWAX to rewardEscrow
			await tribeetixProxy.transfer(rewardEscrow.address, toUnit('100'), { from: owner });

			rewardEscrowBalanceBefore = await rwaone.balanceOf(rewardEscrow.address);
		});
		it('should revert if called by non-owner account', async () => {
			await assert.revert(
				rwaone.migrateEscrowBalanceToRewardEscrowV2({ from: account1 }),
				'Only the contract owner may perform this action'
			);
		});
		it('should have transferred reward escrow balance to reward escrow v2', async () => {
			// call the migrate function
			await rwaone.migrateEscrowBalanceToRewardEscrowV2({ from: owner });

			// should have transferred balance to rewardEscrowV2
			assert.bnEqual(await rwaone.balanceOf(rewardEscrowV2.address), rewardEscrowBalanceBefore);

			// rewardEscrow should have 0 balance
			assert.bnEqual(await rwaone.balanceOf(rewardEscrow.address), 0);
		});
	});

	describe('Using a contract to invoke exchangeWithTrackingForInitiator', () => {
		describe('when a third party contract is setup to exchange tribes', () => {
			let contractExample;
			let amountOfrUSD;
			beforeEach(async () => {
				amountOfrUSD = toUnit('100');

				const MockThirdPartyExchangeContract = artifacts.require('MockThirdPartyExchangeContract');

				// create a contract
				contractExample = await MockThirdPartyExchangeContract.new(addressResolver.address);

				// ensure rates are set
				await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

				// issue rUSD from the owner
				await rwaone.issueTribes(amountOfrUSD, { from: owner });

				// transfer the rUSD to the contract
				await rUSDContract.transfer(contractExample.address, toUnit('100'), { from: owner });
			});

			describe('when Barrie invokes the exchange function on the contract', () => {
				let txn;
				beforeEach(async () => {
					// Barrie has no rETH to start
					assert.equal(await rETHContract.balanceOf(account3), '0');

					txn = await contractExample.exchange(rUSD, amountOfrUSD, rETH, { from: account3 });
				});
				it('then Barrie has the tribes in her account', async () => {
					assert.bnGt(await rETHContract.balanceOf(account3), toUnit('0.01'));
				});
				it('and the contract has none', async () => {
					assert.equal(await rETHContract.balanceOf(contractExample.address), '0');
				});
				it('and the event emitted indicates that Barrie was the destinationAddress', async () => {
					const logs = artifacts.require('Rwaone').decodeLogs(txn.receipt.rawLogs);
					assert.eventEqual(
						logs.find(log => log.event === 'TribeExchange'),
						'TribeExchange',
						{
							account: contractExample.address,
							fromCurrencyKey: rUSD,
							fromAmount: amountOfrUSD,
							toCurrencyKey: rETH,
							toAddress: account3,
						}
					);
				});
			});
		});
	});
});
