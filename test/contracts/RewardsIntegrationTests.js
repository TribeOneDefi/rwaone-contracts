'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { toBytes32 } = require('../..');

const { fastForward, toUnit, multiplyDecimal } = require('../utils')();

const {
	setExchangeFeeRateForRwas,
	setupPriceAggregators,
	updateRatesWithDefaults,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');
const { artifacts } = require('hardhat');

contract('Rewards Integration Tests', accounts => {
	// These functions are for manual debugging:

	// const logFeePeriods = async () => {
	// 	const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

	// 	console.log('------------------');
	// 	for (let i = 0; i < length; i++) {
	// 		console.log(`Fee Period [${i}]:`);
	// 		const period = await feePool.recentFeePeriods(i);

	// 		for (const key of Object.keys(period)) {
	// 			if (isNaN(parseInt(key))) {
	// 				console.log(`  ${key}: ${period[key]}`);
	// 			}
	// 		}

	// 		console.log();
	// 	}
	// 	console.log('------------------');
	// };

	// const logFeesByPeriod = async account => {
	// 	const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();
	// 	const feesByPeriod = await feePool.feesByPeriod(account);

	// 	console.log('---------------------feesByPeriod----------------------');
	// 	console.log('Account', account);
	// 	for (let i = 0; i < length; i++) {
	// 		console.log(`Fee Period[${i}] Fees: ${feesByPeriod[i][0]} Rewards: ${feesByPeriod[i][1]}`);
	// 	}
	// 	console.log('--------------------------------------------------------');
	// };

	// CURRENCIES
	const [rUSD, sAUD, sEUR, rBTC, wRWAX, iBTC, rETH, ETH] = [
		'rUSD',
		'sAUD',
		'sEUR',
		'rBTC',
		'wRWAX',
		'iBTC',
		'rETH',
		'ETH',
	].map(toBytes32);

	const rwaKeys = [rUSD, sAUD, sEUR, rBTC, iBTC, rETH, ETH];

	const initialInflationAmount = toUnit(800000);

	const fastForwardAndCloseFeePeriod = async () => {
		const feePeriodDuration = await feePool.feePeriodDuration();
		// Note: add on a small addition of 10 seconds - this seems to have
		// alleviated an issues with the tests flaking in CircleCI
		// test: "should assign accounts (1,2,3) to have (40%,40%,20%) of the debt/rewards"
		await fastForward(feePeriodDuration.toNumber() + 10);
		await feePool.closeCurrentFeePeriod({ from: feeAuthority });

		// Fast forward another day after feePeriod closed before minting
		await fastForward(DAY + 10);

		await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
	};

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
	};

	const exchangeFeeRate = toUnit('0.003'); // 30 bips
	const exchangeFeeIncurred = amountToExchange => {
		return multiplyDecimal(amountToExchange, exchangeFeeRate);
	};

	// DIVISIONS
	const half = amount => amount.div(web3.utils.toBN('2'));
	const third = amount => amount.div(web3.utils.toBN('3'));
	// const twoThirds = amount => amount.div(web3.utils.toBN('3')).mul(web3.utils.toBN('2'));
	const quarter = amount => amount.div(web3.utils.toBN('4'));
	// const twoQuarters = amount => amount.div(web3.utils.toBN('4')).mul(web3.utils.toBN('2'));
	// const threeQuarters = amount => amount.div(web3.utils.toBN('4')).mul(web3.utils.toBN('3'));
	const oneFifth = amount => amount.div(web3.utils.toBN('5'));
	const twoFifths = amount => amount.div(web3.utils.toBN('5')).mul(web3.utils.toBN('2'));

	// PERCENTAGES
	const onePercent = toUnit('0.01');
	const twentyPercent = toUnit('0.2');
	const fortyPercent = toUnit('0.4');
	const fiftyPercent = toUnit('0.5');

	// AMOUNTS
	const tenK = toUnit('10000');
	const twentyK = toUnit('20000');

	// TIME IN SECONDS
	const SECOND = 1000;
	const MINUTE = SECOND * 60;
	// const HOUR = MINUTE * 60;
	const DAY = 86400;
	const WEEK = 604800;
	// const YEAR = 31556926;

	const gweiTolerance = '1000000000';

	// ACCOUNTS
	const [deployerAccount, owner, , feeAuthority, account1, account2, account3] = accounts;

	// VARIABLES
	let feePool,
		rwaone,
		rwaoneProxy,
		exchangeRates,
		exchanger,
		debtCache,
		supplySchedule,
		systemSettings,
		rewardEscrow,
		periodOneMintableSupplyMinusMinterReward,
		rUSDContract,
		MINTER_RWAX_REWARD;

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async function () {
		// set a very long timeout for these (requires a non-fat-arrow above)
		this.timeout(180e3);

		({
			ExchangeRates: exchangeRates,
			Exchanger: exchanger,
			DebtCache: debtCache,
			FeePool: feePool,
			RewardEscrowV2: rewardEscrow,
			SupplySchedule: supplySchedule,
			Rwaone: rwaone,
			ProxyERC20Rwaone: rwaoneProxy,
			RwarUSD: rUSDContract,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			rwas: ['rUSD', 'sAUD', 'sEUR', 'rBTC', 'iBTC', 'rETH'],
			contracts: [
				'AddressResolver',
				'Exchanger', // necessary for burnRwas to check settlement of rUSD
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // necessary to claimFees()
				'DebtCache',
				'RewardEscrowV2',
				'RewardsDistribution', // required for Rwaone.mint()
				'SupplySchedule',
				'Rwaone',
				'SystemSettings',
				'CollateralManager',
				'LiquidatorRewards',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		rwaone = await artifacts.require('Rwaone').at(rwaoneProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, rBTC, iBTC, rETH, ETH]);

		MINTER_RWAX_REWARD = await supplySchedule.minterReward();

		await setExchangeFeeRateForRwas({
			owner,
			systemSettings,
			rwaKeys,
			exchangeFeeRates: rwaKeys.map(() => exchangeFeeRate),
		});
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// Fastforward a year into the staking rewards supply
		// await fastForwardAndUpdateRates(YEAR + MINUTE);
		await supplySchedule.setInflationAmount(initialInflationAmount, { from: owner });
		await fastForwardAndUpdateRates(WEEK + DAY);

		// Assign 1/3 of total wRWAX to 3 accounts
		const snxTotalSupply = await rwaone.totalSupply();
		const thirdOfRWAX = third(snxTotalSupply);

		await rwaone.transfer(account1, thirdOfRWAX, { from: owner });
		await rwaone.transfer(account2, thirdOfRWAX, { from: owner });
		await rwaone.transfer(account3, thirdOfRWAX, { from: owner });

		// Get the wRWAX mintableSupply
		periodOneMintableSupplyMinusMinterReward = (await supplySchedule.mintableSupply()).sub(
			MINTER_RWAX_REWARD
		);

		// Mint the staking rewards
		await rwaone.mint({ from: deployerAccount });

		// set minimumStakeTime on issue and burning to 0
		await systemSettings.setMinimumStakeTime(0, { from: owner });

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	describe('3 accounts with 33.33% wRWAX all issue MAX and claim rewards', async () => {
		let FEE_PERIOD_LENGTH;
		let CLAIMABLE_PERIODS;

		beforeEach(async () => {
			FEE_PERIOD_LENGTH = (await feePool.FEE_PERIOD_LENGTH()).toNumber();
			CLAIMABLE_PERIODS = FEE_PERIOD_LENGTH - 1;

			await rwaone.issueMaxRwas({ from: account1 });
			await rwaone.issueMaxRwas({ from: account2 });
			await rwaone.issueMaxRwas({ from: account3 });
		});

		it('should allocate the 3 accounts a third of the rewards for 1 period', async () => {
			// Close Fee Period
			await fastForwardAndCloseFeePeriod();

			// All 3 accounts claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// All 3 accounts have 1/3 of the rewards
			const accOneEscrowed = await rewardEscrow.getVestingEntry(account1, 1);
			assert.bnClose(
				accOneEscrowed.escrowAmount,
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			const accTwoEscrowed = await rewardEscrow.getVestingEntry(account2, 2);
			assert.bnClose(
				accTwoEscrowed.escrowAmount,
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			const accThreeEscrowed = await rewardEscrow.getVestingEntry(account3, 3);
			assert.bnClose(
				accThreeEscrowed.escrowAmount,
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);
		});

		it('should show the totalRewardsAvailable in the claimable period 1', async () => {
			// Close Fee Period
			await fastForwardAndCloseFeePeriod();

			// Assert that we have correct values in the fee pool
			const totalRewardsAvailable = await feePool.totalRewardsAvailable();

			assert.bnEqual(totalRewardsAvailable, periodOneMintableSupplyMinusMinterReward);
		});

		it('should show the totalRewardsAvailable in the claimable periods 1 & 2', async () => {
			let mintedRewardsSupply;
			// We are currently in the 2nd week, close it and the next
			for (let i = 0; i <= CLAIMABLE_PERIODS - 1; i++) {
				// console.log('Close Fee Period', i);
				await fastForwardAndCloseFeePeriod();

				// FastForward a little for minting
				await fastForwardAndUpdateRates(MINUTE);

				// Get the wRWAX mintableSupply - the minter reward of 200 wRWAX
				mintedRewardsSupply = (await supplySchedule.mintableSupply()).sub(MINTER_RWAX_REWARD);
				// console.log('mintedRewardsSupply', mintedRewardsSupply.toString());
				// Mint the staking rewards
				await rwaone.mint({ from: owner });

				// await logFeePeriods();
			}

			// Assert that we have correct values in the fee pool
			const totalRewardsAvailable = await feePool.totalRewardsAvailable();

			const twoWeeksRewards = mintedRewardsSupply.mul(web3.utils.toBN(CLAIMABLE_PERIODS));

			assert.bnEqual(totalRewardsAvailable, twoWeeksRewards);
		});

		it('should show the totalRewardsAvailable in the claimable periods 1 & 2 after 2 accounts claims', async () => {
			let mintedRewardsSupply;
			// We are currently in the 2nd week, close it and the next
			for (let i = 0; i <= CLAIMABLE_PERIODS - 1; i++) {
				// console.log('Close Fee Period', i);
				await fastForwardAndCloseFeePeriod();

				// FastForward a little for minting
				await fastForwardAndUpdateRates(MINUTE);

				// Get the wRWAX mintableSupply - the minter reward of 200 wRWAX
				mintedRewardsSupply = (await supplySchedule.mintableSupply()).sub(MINTER_RWAX_REWARD);
				// console.log('mintedRewardsSupply', mintedRewardsSupply.toString());
				// Mint the staking rewards
				await rwaone.mint({ from: owner });

				// await logFeePeriods();
			}

			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			// await logFeePeriods();

			// Assert that we have correct values in the fee pool
			const totalRewardsAvailable = await feePool.totalRewardsAvailable();

			const twoWeeksRewards = mintedRewardsSupply.mul(web3.utils.toBN(CLAIMABLE_PERIODS));

			const rewardsLessAccountClaims = third(twoWeeksRewards);

			assert.bnClose(totalRewardsAvailable, rewardsLessAccountClaims, '1000000000');
		});

		it('should mint wRWAX for the all claimable fee periods then all 3 accounts claim at the end of the claimable period', async () => {
			let mintedRewardsSupply;
			// We are currently in the 2nd week, close it and the next
			for (let i = 0; i <= CLAIMABLE_PERIODS - 1; i++) {
				// console.log('Close Fee Period', i);
				await fastForwardAndCloseFeePeriod();

				// FastForward a little for minting
				await fastForwardAndUpdateRates(MINUTE);

				// Get the wRWAX mintableSupply - the minter reward of 200 wRWAX
				mintedRewardsSupply = (await supplySchedule.mintableSupply()).sub(MINTER_RWAX_REWARD);

				// Mint the staking rewards
				await rwaone.mint({ from: owner });

				// await logFeePeriods();
			}

			// All 3 accounts claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// await logFeePeriods();

			const twoWeeksRewards = third(mintedRewardsSupply).mul(web3.utils.toBN(CLAIMABLE_PERIODS));

			// All 3 accounts have 1/3 of the rewards
			const accOneEscrowed = await rewardEscrow.getVestingEntry(account1, 1);
			assert.bnClose(accOneEscrowed.escrowAmount, twoWeeksRewards, '1000000000');

			const accTwoEscrowed = await rewardEscrow.getVestingEntry(account2, 2);
			assert.bnClose(accTwoEscrowed.escrowAmount, twoWeeksRewards, '1000000000');

			const accThreeEscrowed = await rewardEscrow.getVestingEntry(account3, 3);
			assert.bnClose(accThreeEscrowed.escrowAmount, twoWeeksRewards, '1000000000');
		});

		it('should rollover the unclaimed wRWAX rewards', async () => {
			// Close all claimable periods
			for (let i = 0; i <= CLAIMABLE_PERIODS; i++) {
				// console.log('Close Fee Period', i);
				await fastForwardAndCloseFeePeriod();
				// FastForward a bit to be able to mint
				await fastForwardAndUpdateRates(MINUTE);

				// Mint the staking rewards
				await rwaone.mint({ from: owner });

				// await logFeePeriods();
			}
			// Get the Rewards to roll over from the last week
			const periodToRollOver = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);
			const rollOverRewards = periodToRollOver.rewardsToDistribute;

			// Close the extra week
			await fastForwardAndCloseFeePeriod();
			// FastForward a bit to be able to mint
			await fastForwardAndUpdateRates(MINUTE);
			// Mint the staking rewards
			await rwaone.mint({ from: owner });

			// Get last FeePeriod
			const lastFeePeriod = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);

			// await logFeePeriods();

			// Assert rewards have rolled over
			assert.bnEqual(
				lastFeePeriod.rewardsToDistribute,
				periodOneMintableSupplyMinusMinterReward.add(rollOverRewards)
			);
		});

		it('should rollover the unclaimed wRWAX rewards on week over 2 terms', async () => {
			for (let i = 0; i <= 2; i++) {
				await fastForwardAndCloseFeePeriod();
				// FastForward a bit to be able to mint
				await fastForwardAndUpdateRates(MINUTE);
				// Mint the staking rewards
				await rwaone.mint({ from: owner });
				// await logFeePeriods();
			}
			// Get the Rewards to RollOver
			const periodToRollOver = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);
			const rollOverRewards = periodToRollOver.rewardsToDistribute;

			// Close for the roll over
			await fastForwardAndCloseFeePeriod();
			// FastForward a bit to be able to mint
			await fastForwardAndUpdateRates(MINUTE);
			// Mint the staking rewards
			await rwaone.mint({ from: owner });
			// Get last FeePeriod
			const lastFeePeriod = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);
			// await logFeePeriods();
			// Assert rewards have rolled over
			assert.bnEqual(
				lastFeePeriod.rewardsToDistribute,
				periodOneMintableSupplyMinusMinterReward.add(rollOverRewards)
			);
		});

		it('should rollover the partial unclaimed wRWAX rewards', async () => {
			// await logFeePeriods();
			for (let i = 0; i <= FEE_PERIOD_LENGTH; i++) {
				// Get the Rewards to RollOver
				const periodToRollOver = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);
				const currenPeriod = await feePool.recentFeePeriods(CLAIMABLE_PERIODS - 1);
				const rollOverRewards = periodToRollOver.rewardsToDistribute.sub(
					periodToRollOver.rewardsClaimed
				);
				const previousRewards = currenPeriod.rewardsToDistribute;

				// FastForward a bit to be able to mint
				await fastForwardAndCloseFeePeriod();
				await fastForwardAndUpdateRates(MINUTE);

				// Mint the staking rewards
				await rwaone.mint({ from: owner });

				// Only 1 account claims rewards
				await feePool.claimFees({ from: account1 });
				// await logFeePeriods();

				// Get last FeePeriod
				const lastFeePeriod = await feePool.recentFeePeriods(CLAIMABLE_PERIODS);

				// Assert that Account 1 has claimed a third of the rewardsToDistribute
				assert.bnClose(
					lastFeePeriod.rewardsClaimed,
					third(lastFeePeriod.rewardsToDistribute),
					gweiTolerance
				);

				// Assert rewards have rolled over
				assert.bnEqual(lastFeePeriod.rewardsToDistribute, previousRewards.add(rollOverRewards));
			}
		});

		it('should allow a user to leave the system and return and still claim rewards', async () => {
			// Close week 1
			await fastForwardAndCloseFeePeriod();
			// FastForward a bit to be able to mint
			await fastForwardAndUpdateRates(MINUTE);
			// Mint the staking rewards
			await rwaone.mint({ from: owner });
			// await logFeePeriods();

			// Account 1 leaves the system in week 2
			const burnableTotal = await rwaone.debtBalanceOf(account1, rUSD);
			await rwaone.burnRwas(burnableTotal, { from: account1 });
			// await logFeesByPeriod(account1);

			// Account 1 comes back into the system
			await rwaone.issueMaxRwas({ from: account1 });

			// Only Account 1 claims rewards
			const rewardsAmount = third(periodOneMintableSupplyMinusMinterReward);
			const feesByPeriod = await feePool.feesByPeriod(account1);

			// await logFeesByPeriod(account1);
			// [1] ---------------------feesByPeriod----------------------
			// [1] Fee Period[0] Fees: 0 Rewards: 480702564102564102564102
			// [1] Fee Period[1] Fees: 0 Rewards: 480702564102564102564102
			// [1] -------------------------------------------------------

			// Assert Account 1 has re-entered the system and has awards in period 0 & 1
			assert.bnClose(feesByPeriod[0][1], rewardsAmount, gweiTolerance);
			assert.bnClose(feesByPeriod[1][1], rewardsAmount, gweiTolerance);

			// Only Account 1 claims rewards
			await feePool.claimFees({ from: account1 });

			// await logFeesByPeriod(account1);
			// [1] ---------------------feesByPeriod----------------------
			// [1] Fee Period[0] Fees: 0 Rewards: 480702564102564102564102
			// [1] Fee Period[1] Fees: 0 Rewards: 0                        * claimed
			// [1] -------------------------------------------------------

			// Assert Account 1 has their rewards
			const account1EscrowEntry = await rewardEscrow.getVestingEntry(account1, 1);
			assert.bnClose(account1EscrowEntry.escrowAmount, rewardsAmount, gweiTolerance);
		});

		it('should allocate correct wRWAX rewards as others leave the system', async () => {
			// Close Fee Period
			// console.log('Close Fee Period');
			await fastForwardAndCloseFeePeriod();

			// Account1 claims but 2 & 3 dont
			await feePool.claimFees({ from: account1 });

			// All Account 1 has 1/3 of the rewards escrowed
			const account1Escrowed = await rewardEscrow.getVestingEntry(account1, 1);
			assert.bnClose(
				account1Escrowed.escrowAmount,
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			// Account 1 leaves the system
			const burnableTotal = await rwaone.debtBalanceOf(account1, rUSD);
			await rwaone.burnRwas(burnableTotal, { from: account1 });

			// FastForward into the second mintable week
			await fastForwardAndUpdateRates(WEEK + MINUTE);

			// Get the wRWAX mintableSupply for period 2
			const period2MintedRewardsSupply = (await supplySchedule.mintableSupply()).sub(
				MINTER_RWAX_REWARD
			);

			// Mint the staking rewards for p2
			await rwaone.mint({ from: owner });

			// Close the period after user leaves system
			fastForwardAndCloseFeePeriod();

			// Account1 Reenters in current unclosed period so no rewards yet
			// await rwaone.issueMaxRwas({ from: account1 });

			// Accounts 2 & 3 now have 33% of period 1 and 50% of period 2
			// console.log('33% of p1', third(periodOneMintableSupplyMinusMinterReward).toString());
			// console.log('50% of p2', half(period2MintedRewardsSupply).toString());
			const rewardsAmount = third(periodOneMintableSupplyMinusMinterReward).add(
				half(period2MintedRewardsSupply)
			);
			// console.log('rewardsAmount calculated', rewardsAmount.toString());

			// await logFeePeriods();
			await new Promise(resolve => setTimeout(resolve, 1000)); // Test would fail without the logFeePeriods(). Race condition on chain. Just need to delay a tad.

			// Check account2 has correct rewardsAvailable
			const account2Rewards = await feePool.feesAvailable(account2);
			// console.log('account2Rewards', rewardsAmount.toString(), account2Rewards[1].toString());
			assert.bnClose(account2Rewards[1], rewardsAmount, gweiTolerance);

			// Check account3 has correct rewardsAvailable
			const account3Rewards = await feePool.feesAvailable(account3);
			// console.log('rewardsAvailable', rewardsAmount.toString(), account3Rewards[1].toString());
			assert.bnClose(account3Rewards[1], rewardsAmount, gweiTolerance);

			// Accounts 2 & 3 claim
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// Accounts 2 & 3 now have the rewards escrowed
			const account2Escrowed = await rewardEscrow.getVestingEntry(account2, 2);
			// console.log('account2Escrowed[3]', account2Escrowed[1].toString());
			assert.bnClose(account2Escrowed.escrowAmount, rewardsAmount, gweiTolerance);
			const account3Escrowed = await rewardEscrow.getVestingEntry(account3, 3);
			// console.log('account3Escrowed[3]', account2Escrowed[1].toString());
			assert.bnClose(account3Escrowed.escrowAmount, rewardsAmount, gweiTolerance);
		});
	});

	describe('Exchange Rate Shift tests', async () => {
		it('should assign accounts (1,2,3) to have (40%,40%,20%) of the debt/rewards', async () => {
			// Account 1&2 issue 10K USD and exchange in rBTC each, holding 50% of the total debt.
			await rwaone.issueRwas(tenK, { from: account1 });
			await rwaone.issueRwas(tenK, { from: account2 });

			await rwaone.exchange(rUSD, tenK, rBTC, { from: account1 });
			await rwaone.exchange(rUSD, tenK, rBTC, { from: account2 });

			await fastForwardAndCloseFeePeriod();
			// //////////////////////////////////////////////
			// 2nd Week
			// //////////////////////////////////////////////

			// Assert 1, 2 have 50% each of the effectiveDebtRatioForPeriod
			const debtRatioAccount1 = await feePool.effectiveDebtRatioForPeriod(account1, 1);
			// console.log('debtRatioAccount1', debtRatioAccount1.toString());
			const debtRatioAccount2 = await feePool.effectiveDebtRatioForPeriod(account2, 1);
			// console.log('debtRatioAccount2', debtRatioAccount1.toString());

			assert.bnEqual(debtRatioAccount1, fiftyPercent);
			assert.bnEqual(debtRatioAccount2, fiftyPercent);

			// Accounts 1&2 claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });

			// Assert Accounts 1&2 have 50% of the minted rewards in their initial escrow entry
			const account1Escrow = await rewardEscrow.getVestingEntry(account1, 1);
			// console.log('account1Escrow[3]', account1Escrow[3].toString());
			assert.bnClose(
				account1Escrow.escrowAmount,
				half(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			const account2Escrow = await rewardEscrow.getVestingEntry(account2, 2);
			// console.log('account2Escrow[3]', account2Escrow[3].toString());
			assert.bnClose(
				account2Escrow.escrowAmount,
				half(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			// Increase rBTC price by 100%
			await updateAggregatorRates(exchangeRates, null, [rBTC], ['10000'].map(toUnit));
			await debtCache.takeDebtSnapshot();

			// Account 3 (enters the system and) mints 10K rUSD (minus half of an exchange fee - to balance the fact
			// that the other two holders have doubled their rBTC holdings) and should have 20% of the debt not 33.33%
			const potentialFee = exchangeFeeIncurred(toUnit('20000'));
			await rwaone.issueRwas(tenK.sub(half(potentialFee)), { from: account3 });

			// Get the wRWAX mintableSupply for week 2
			const periodTwoMintableSupply = (await supplySchedule.mintableSupply()).sub(
				MINTER_RWAX_REWARD
			);

			// Mint the staking rewards
			await rwaone.mint({ from: owner });

			// Do some exchanging to generateFees
			// disable dynamic fee here otherwise it will flag rates as too volatile
			await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

			const { amountReceived } = await exchanger.getAmountsForExchange(tenK, rUSD, rBTC);
			await rwaone.exchange(rBTC, amountReceived, rUSD, { from: account1 });
			await rwaone.exchange(rBTC, amountReceived, rUSD, { from: account2 });

			// Close so we can claim
			await fastForwardAndCloseFeePeriod();
			// //////////////////////////////////////////////
			// 3rd Week
			// //////////////////////////////////////////////

			// await logFeePeriods();

			// Note: this is failing because 10k isn't 20% but rather a shade more, this is
			// due to the fact that 10k isn't accurately the right amount - should be

			// Assert (1,2,3) have (40%,40%,20%) of the debt in the recently closed period
			const acc1Ownership = await feePool.effectiveDebtRatioForPeriod(account1, 1);
			const acc2Ownership = await feePool.effectiveDebtRatioForPeriod(account2, 1);
			const acc3Ownership = await feePool.effectiveDebtRatioForPeriod(account3, 1);
			// console.log('Account1.effectiveDebtRatioForPeriod', acc1Ownership.toString());
			// console.log('Account2.effectiveDebtRatioForPeriod', acc2Ownership.toString());
			// console.log('Account3.effectiveDebtRatioForPeriod', acc3Ownership.toString());
			assert.bnClose(acc1Ownership, fortyPercent, acc1Ownership.mul(onePercent)); // add on a delta to handle shifts in debt share values
			assert.bnClose(acc2Ownership, fortyPercent, acc2Ownership.mul(onePercent));
			assert.bnClose(acc3Ownership, twentyPercent, acc3Ownership.mul(onePercent));

			// await logFeesByPeriod(account1);
			// await logFeesByPeriod(account2);
			// await logFeesByPeriod(account3);

			// All 3 accounts claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// await logFeePeriods();

			// Assert (1,2,3) have (40%,40%,20%) of the rewards in their 2nd escrow entry
			const account1EscrowEntry2 = await rewardEscrow.getVestingEntry(account1, 3);
			const account2EscrowEntry2 = await rewardEscrow.getVestingEntry(account2, 4);
			const account3EscrowEntry1 = await rewardEscrow.getVestingEntry(account3, 5); // Account3's first escrow entry
			// console.log('account1EscrowEntry2[3]', account1EscrowEntry2[3].toString());
			// console.log(
			// 	'twoFifths(periodTwoMintableSupply)',
			// 	twoFifths(periodTwoMintableSupply).toString()
			// );
			// console.log('account2EscrowEntry2[3]', account2EscrowEntry2[3].toString());
			// console.log(
			// 	'twoFifths(periodTwoMintableSupply)',
			// 	twoFifths(periodTwoMintableSupply).toString()
			// );
			// console.log('account3EscrowEntry1[3]', account3EscrowEntry1[3].toString());
			// console.log(
			// 	'oneFifth(periodTwoMintableSupply)',
			// 	oneFifth(periodTwoMintableSupply).toString()
			// );

			assert.bnClose(
				account1EscrowEntry2.escrowAmount,
				twoFifths(periodTwoMintableSupply),
				account1EscrowEntry2.escrowAmount.mul(onePercent) // add on a delta to handle shifts in debt share values
			);
			assert.bnClose(
				account2EscrowEntry2.escrowAmount,
				twoFifths(periodTwoMintableSupply),
				account2EscrowEntry2.escrowAmount.mul(onePercent)
			);
			assert.bnClose(
				account3EscrowEntry1.escrowAmount,
				oneFifth(periodTwoMintableSupply),
				account3EscrowEntry1.escrowAmount.mul(onePercent)
			);

			// Commenting out this logic for now (v2.14.x) - needs to be relooked at -JJ

			// // now in p3 Acc1 burns all and leaves (-40%) and Acc2 has 67% and Acc3 33% rewards allocated as such
			// // Account 1 exchanges all rBTC back to rUSD
			// const acc1rBTCBalance = await rBTCContract.balanceOf(account1, { from: account1 });
			// await rwaone.exchange(rBTC, acc1rBTCBalance, rUSD, { from: account1 });
			// const amountAfterExchange = await feePool.amountReceivedFromExchange(acc1rBTCBalance);
			// const amountAfterExchangeInUSD = await exchangeRates.effectiveValue(
			// 	rBTC,
			// 	amountAfterExchange,
			// 	rUSD
			// );

			// await rwaone.burnRwas(amountAfterExchangeInUSD, { from: account1 });

			// // Get the wRWAX mintableSupply for week 3
			// // const periodThreeMintableSupply = (await supplySchedule.mintableSupply()).sub(
			// // 	MINTER_RWAX_REWARD
			// // );

			// // Mint the staking rewards
			// await rwaone.mint({ from: owner });

			// // Close so we can claim
			// await fastForwardAndCloseFeePeriod();
			// // //////////////////////////////////////////////
			// // 4th Week
			// // //////////////////////////////////////////////

			// // Accounts 2&3 claim rewards
			// await feePool.claimFees({ from: account1 });
			// await feePool.claimFees({ from: account2 });
			// await feePool.claimFees({ from: account3 });

			// await logFeesByPeriod(account1);
			// await logFeesByPeriod(account2);
			// await logFeesByPeriod(account3);
			// await logFeePeriods();

			// Account2 should have 67% of the minted rewards
			// const account2Escrow3 = await rewardEscrow.getVestingEntry(account2, 2); // Account2's 3rd escrow entry
			// console.log('account2Escrow3[1]', account2Escrow3[1].toString());
			// console.log(
			// 	'twoThirds(periodThreeMintableSupply)',
			// 	twoFifths(periodThreeMintableSupply).toString()
			// );
			// assert.bnClose(account2Escrow3[1], twoFifths(periodThreeMintableSupply));
			// assert.bnEqual(account2Escrow3[1], twoFifths(periodThreeMintableSupply));

			// // Account3 should have 33% of the minted rewards
			// const account3Escrow2 = await rewardEscrow.getVestingEntry(account3, 1); // Account3's 2nd escrow entry
			// console.log('account3Escrow3[1]', account3Escrow2[1].toString());
			// console.log(
			// 	'third(periodThreeMintableSupply)',
			// 	oneFifth(periodThreeMintableSupply).toString()
			// );
			// assert.bnClose(account3Escrow2[1], oneFifth(periodThreeMintableSupply), 15);

			// // Acc1 mints 20K (40%) close p (40,40,20)');
			// await rwaone.issueRwas(twentyK, { from: account1 });

			// // Get the wRWAX mintableSupply for week 4
			// const periodFourMintableSupply = (await supplySchedule.mintableSupply()).sub(
			// 	MINTER_RWAX_REWARD
			// );

			// // Mint the staking rewards
			// await rwaone.mint({ from: owner });

			// // Close so we can claim
			// await fastForwardAndCloseFeePeriod();

			// /// ///////////////////////////////////////////
			// /* 5th Week */
			// /// ///////////////////////////////////////////

			// // Accounts 1,2,3 claim rewards
			// await feePool.claimFees({ from: account1 });
			// await feePool.claimFees({ from: account2 });
			// await feePool.claimFees({ from: account3 });

			// // Assert (1,2,3) have (40%,40%,20%) of the rewards in their 2nd escrow entry
			// const account1EscrowEntry4 = await rewardEscrow.getVestingEntry(account1, 1);
			// const account2EscrowEntry4 = await rewardEscrow.getVestingEntry(account2, 1);
			// const account3EscrowEntry3 = await rewardEscrow.getVestingEntry(account3, 0); // Account3's first escrow entry
			// console.log('account1EscrowEntry4[1]', account1EscrowEntry4[1].toString());
			// console.log('account1EscrowEntry4[1]', account2EscrowEntry4[1].toString());
			// console.log('account1EscrowEntry4[1]', account3EscrowEntry3[1].toString());

			// assert.bnClose(account1EscrowEntry4[1], twoFifths(periodFourMintableSupply));
			// assert.bnClose(account2EscrowEntry4[1], twoFifths(periodFourMintableSupply));
			// assert.bnClose(account3EscrowEntry3[1], oneFifth(periodFourMintableSupply), 16);
		});
	});

	describe('3 Accounts issue 10K rUSD each in week 1', async () => {
		beforeEach(async () => {
			await rwaone.issueRwas(tenK, { from: account1 });
			await rwaone.issueRwas(tenK, { from: account2 });
			await rwaone.issueRwas(tenK, { from: account3 });
		});

		it('Acc1 issues and burns multiple times and should have accounts 1,2,3 rewards 50%,25%,25%', async () => {
			// Acc 1 Issues 20K rUSD
			await rwaone.issueRwas(tenK, { from: account1 });

			// Close week 2
			await fastForwardAndCloseFeePeriod();

			// //////////////////////////////////////////////
			// 3rd Week
			// //////////////////////////////////////////////

			// Accounts 1,2,3 claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// Assert Accounts 1 has 50% & 2&3 have 25% of the minted rewards in their initial escrow entry
			const account1Escrow = await rewardEscrow.getVestingEntry(account1, 1);
			const account2Escrow = await rewardEscrow.getVestingEntry(account2, 2);
			const account3Escrow = await rewardEscrow.getVestingEntry(account3, 3);
			// console.log('account1Escrow[3]', account1Escrow[3].toString());
			// console.log('account2Escrow[3]', account2Escrow[3].toString());
			// console.log('account3Escrow[3]', account3Escrow[3].toString());
			// console.log(
			// 	'half(periodOneMintableSupplyMinusMinterReward',
			// 	half(periodOneMintableSupplyMinusMinterReward).toString()
			// );
			// console.log(
			// 	'quarter(periodOneMintableSupplyMinusMinterReward)',
			// 	quarter(periodOneMintableSupplyMinusMinterReward).toString()
			// );
			assert.bnClose(
				account1Escrow.escrowAmount,
				half(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);
			assert.bnClose(
				account2Escrow.escrowAmount,
				quarter(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);
			assert.bnClose(
				account3Escrow.escrowAmount,
				quarter(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);

			// Acc1 Burns all
			await rwaone.burnRwas(twentyK, { from: account1 });
			// Acc 1 Issues 10K rUSD
			await rwaone.issueRwas(tenK, { from: account1 });
			// Acc 1 Issues 10K rUSD again
			await rwaone.issueRwas(tenK, { from: account1 });

			// Get the wRWAX mintableSupply for week 2
			const periodTwoMintableSupply = (await supplySchedule.mintableSupply()).sub(
				MINTER_RWAX_REWARD
			);

			// Mint the staking rewards
			await rwaone.mint({ from: owner });

			// Close week 3
			await fastForwardAndCloseFeePeriod();

			// //////////////////////////////////////////////
			// 3rd Week
			// //////////////////////////////////////////////

			// await logFeePeriods();
			// await logFeesByPeriod(account1);
			// await logFeesByPeriod(account2);
			// await logFeesByPeriod(account3);

			// Accounts 1,2,3 claim rewards
			await feePool.claimFees({ from: account1 });
			await feePool.claimFees({ from: account2 });
			await feePool.claimFees({ from: account3 });

			// Assert Accounts 2&3 have 25% of the minted rewards in their initial escrow entry
			const account1Escrow2 = await rewardEscrow.getVestingEntry(account1, 4);
			const account2Escrow2 = await rewardEscrow.getVestingEntry(account2, 5);
			const account3Escrow2 = await rewardEscrow.getVestingEntry(account3, 6);
			// console.log('account1Escrow2[3]', account1Escrow2[3].toString());
			// console.log('account2Escrow2[3]', account2Escrow2[3].toString());
			// console.log('account3Escrow2[3]', account3Escrow2[3].toString());
			// console.log('half(periodTwoMintableSupply', half(periodTwoMintableSupply).toString());
			// console.log('quarter(periodTwoMintableSupply)', quarter(periodTwoMintableSupply).toString());
			assert.bnClose(account1Escrow2.escrowAmount, half(periodTwoMintableSupply), gweiTolerance);
			assert.bnClose(account2Escrow2.escrowAmount, quarter(periodTwoMintableSupply), gweiTolerance);
			assert.bnClose(account3Escrow2.escrowAmount, quarter(periodTwoMintableSupply), gweiTolerance);
		});
	});

	describe('Collateralisation Ratio Penalties', async () => {
		beforeEach(async () => {
			// console.log('3 accounts issueMaxRwas in p1');
			await rwaone.issueMaxRwas({ from: account1 });
			await rwaone.issueMaxRwas({ from: account2 });
			await rwaone.issueMaxRwas({ from: account3 });

			// We should have zero rewards available because the period is still open.
			const rewardsBefore = await feePool.feesAvailable(account1);
			assert.bnEqual(rewardsBefore[1], 0);

			// Once the fee period is closed we should have 1/3 the rewards available because we have
			// 1/3 the collateral backing up the system.
			await fastForwardAndCloseFeePeriod();
			const rewardsAfter = await feePool.feesAvailable(account1);
			// console.log('rewardsAfter', rewardsAfter[1].toString());
			assert.bnClose(
				rewardsAfter[1],
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);
		});

		it('should apply no penalty when users claim rewards above the penalty threshold ratio of 1%', async () => {
			// Decrease wRWAX collateral price by .9%
			const currentRate = await exchangeRates.rateForCurrency(wRWAX);
			const newRate = currentRate.sub(multiplyDecimal(currentRate, toUnit('0.009')));

			await updateAggregatorRates(exchangeRates, null, [wRWAX], [newRate]);

			// we will be able to claim fees
			assert.equal(await feePool.isFeesClaimable(account1), true);

			const snxRewards = await feePool.feesAvailable(account1);
			assert.bnClose(snxRewards[1], third(periodOneMintableSupplyMinusMinterReward), gweiTolerance);

			// And if we claim them
			await feePool.claimFees({ from: account1 });

			// We should have our decreased rewards amount in escrow
			const vestingScheduleEntry = await rewardEscrow.getVestingEntry(account1, 1);
			assert.bnClose(
				vestingScheduleEntry.escrowAmount,
				third(periodOneMintableSupplyMinusMinterReward),
				gweiTolerance
			);
		});
		it('should block user from claiming fees and rewards when users claim rewards >10% threshold collateralisation ratio', async () => {
			// But if the price of wRWAX decreases a lot...
			const newRate = (await exchangeRates.rateForCurrency(wRWAX)).sub(toUnit('0.09'));
			await updateAggregatorRates(exchangeRates, null, [wRWAX], [newRate]);
			// we will fall into the >100% bracket
			assert.equal(await feePool.isFeesClaimable(account1), false);

			// And if we claim then it should revert as there is nothing to claim
			await assert.revert(feePool.claimFees({ from: account1 }));
		});
	});

	describe('When user is the last to call claimFees()', () => {
		beforeEach(async () => {
			const oneThousand = toUnit('10000');
			await rwaone.issueRwas(oneThousand, { from: account2 });
			await rwaone.issueRwas(oneThousand, { from: account1 });

			await rwaone.exchange(rUSD, oneThousand, sAUD, { from: account2 });
			await rwaone.exchange(rUSD, oneThousand, sAUD, { from: account1 });

			await fastForwardAndCloseFeePeriod();
		});

		it('then account gets remainder of fees/rewards available after wei rounding', async () => {
			// Assert that we have correct values in the fee pool
			const feesAvailableUSD = await feePool.feesAvailable(account2);
			const oldrUSDBalance = await rUSDContract.balanceOf(account2);

			// Now we should be able to claim them.
			const claimFeesTx = await feePool.claimFees({ from: account2 });
			assert.eventEqual(claimFeesTx, 'FeesClaimed', {
				rUSDAmount: feesAvailableUSD[0],
				snxRewards: feesAvailableUSD[1],
			});

			const newUSDBalance = await rUSDContract.balanceOf(account2);
			// rUSD balance remains unchanged since the fees are burned.
			assert.bnEqual(newUSDBalance, oldrUSDBalance);

			const period = await feePool.recentFeePeriods(1);
			period.index = 1;

			// Simulate rounding on rUSD leaving fraction less for the last claimer.
			// No need to simulate for wRWAX as the 1.44M wRWAX has a 1 wei rounding already
			period.feesClaimed = period.feesClaimed.add(toUnit('0.000000000000000001'));
			await feePool.importFeePeriod(
				period.index,
				period.feePeriodId,
				period.startTime,
				period.feesToDistribute,
				period.feesClaimed,
				period.rewardsToDistribute,
				period.rewardsClaimed,
				{ from: owner }
			);

			const feesAvailableUSDAcc1 = await feePool.feesAvailable(account1);

			// last claimer should get the fraction less
			// is entitled to 721,053.846153846153846154 wRWAX
			// however only   721,053.846153846153846153 Claimable after rounding to 18 decimals
			const transaction = await feePool.claimFees({ from: account1 });
			assert.eventEqual(transaction, 'FeesClaimed', {
				rUSDAmount: feesAvailableUSDAcc1[0],
				snxRewards: feesAvailableUSDAcc1[1],
			});
		});
	});
});
