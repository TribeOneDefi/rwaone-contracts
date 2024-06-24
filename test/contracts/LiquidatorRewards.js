const { contract } = require('hardhat');
const { toBN } = require('web3-utils');

const { toBytes32 } = require('../..');
const {
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { setupAllContracts } = require('./setup');
const { artifacts } = require('hardhat');
const { toUnit, fastForward } = require('../utils')();

contract('LiquidatorRewards', accounts => {
	const [sAUD, sEUR, wHAKA, hETH, ETH] = ['sAUD', 'sEUR', 'wHAKA', 'hETH', 'ETH'].map(toBytes32);
	const [, owner, , , stakingAccount1, stakingAccount2, mockRwaone] = accounts;

	let addressResolver,
		debtCache,
		circuitBreaker,
		exchangeRates,
		liquidatorRewards,
		tribes,
		rwaone,
		tribeetixProxy,
		tribeetixDebtShare,
		systemSettings;

	const ZERO_BN = toBN(0);

	const setupStakers = async () => {
		const snxCollateral = toUnit('1000');
		await rwaone.transfer(stakingAccount1, snxCollateral, { from: owner });
		await rwaone.transfer(stakingAccount2, snxCollateral, { from: owner });

		await rwaone.issueMaxTribes({ from: stakingAccount1 });
		await rwaone.issueMaxTribes({ from: stakingAccount2 });

		await addressResolver.importAddresses(['Rwaone'].map(toBytes32), [mockRwaone], {
			from: owner,
		});
		await liquidatorRewards.rebuildCache();
	};

	const setupReward = async () => {
		const rewardValue = toUnit('1000');
		await rwaone.transfer(liquidatorRewards.address, rewardValue, { from: owner });

		await liquidatorRewards.notifyRewardAmount(rewardValue, {
			from: mockRwaone,
		});

		await addressResolver.importAddresses(['Rwaone'].map(toBytes32), [rwaone.address], {
			from: owner,
		});
		await liquidatorRewards.rebuildCache();
	};

	addSnapshotBeforeRestoreAfterEach();

	before(async () => {
		tribes = ['hUSD', 'sAUD', 'sEUR', 'hETH'];
		({
			AddressResolver: addressResolver,
			CircuitBreaker: circuitBreaker,
			DebtCache: debtCache,
			ExchangeRates: exchangeRates,
			LiquidatorRewards: liquidatorRewards,
			Rwaone: rwaone,
			ProxyERC20Rwaone: tribeetixProxy,
			RwaoneDebtShare: tribeetixDebtShare,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			tribes,
			contracts: [
				'AddressResolver',
				'CollateralManager',
				'CircuitBreaker',
				'DebtCache',
				'Exchanger',
				'ExchangeRates',
				'Issuer',
				'Liquidator',
				'LiquidatorRewards',
				'RewardEscrowV2',
				'Rwaone',
				'RwaoneDebtShare',
				'SystemSettings',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		rwaone = await artifacts.require('Rwaone').at(tribeetixProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, hETH, ETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// update the rates and take a snapshot
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[sAUD, sEUR, wHAKA, hETH],
			['0.5', '1.25', '0.1', '200'].map(toUnit)
		);
		await debtCache.takeDebtSnapshot();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: liquidatorRewards.abi,
			ignoreParents: ['ReentrancyGuard', 'Owned'],
			expected: ['getReward', 'notifyRewardAmount', 'rebuildCache', 'updateEntry'],
		});
	});

	describe('Constructor & Settings', () => {
		it('should set owner on constructor', async () => {
			const ownerAddress = await liquidatorRewards.owner();
			assert.equal(ownerAddress, owner);
		});
		it('reward balance should be zero', async () => {
			const rewardsBalance = await rwaone.balanceOf(liquidatorRewards.address);
			assert.bnEqual(rewardsBalance, ZERO_BN);

			const accumulatedRewardsPerShare = await liquidatorRewards.accumulatedRewardsPerShare();
			assert.bnEqual(accumulatedRewardsPerShare, ZERO_BN);
		});
	});

	describe('Function permissions', () => {
		const rewardValue = toUnit('100');

		it('only rwaone can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: liquidatorRewards.notifyRewardAmount,
				accounts,
				args: [rewardValue],
				address: rwaone.address,
				skipPassCheck: true,
				reason: 'Rwaone only',
			});
		});
	});

	describe('earned()', () => {
		it('should be 0 when not staking', async () => {
			await addressResolver.importAddresses(['Rwaone'].map(toBytes32), [mockRwaone], {
				from: owner,
			});
			await liquidatorRewards.rebuildCache();

			const rewardValue = toUnit('100');
			await rwaone.transfer(liquidatorRewards.address, rewardValue, { from: owner });

			assert.bnEqual(await liquidatorRewards.earned(stakingAccount1), ZERO_BN);
		});

		it('should be > 0 when staking', async () => {
			await setupStakers();

			const rewardValue = toUnit('100');
			await rwaone.transfer(liquidatorRewards.address, rewardValue, { from: owner });

			await liquidatorRewards.notifyRewardAmount(rewardValue, {
				from: mockRwaone,
			});

			const earned = await liquidatorRewards.earned(stakingAccount1);
			assert.bnGt(earned, ZERO_BN);
		});

		it('should increase if new rewards come in', async () => {
			await setupStakers();

			const earnedBalanceBefore = await liquidatorRewards.earned(stakingAccount1);
			const rewardsBalanceBefore = await rwaone.balanceOf(liquidatorRewards.address);
			const accumulatedRewardsBefore = await liquidatorRewards.accumulatedRewardsPerShare();

			const newRewards = toUnit('5000');
			await rwaone.transfer(liquidatorRewards.address, newRewards, { from: owner });

			await liquidatorRewards.notifyRewardAmount(newRewards, {
				from: mockRwaone,
			});

			const earnedBalanceAfter = await liquidatorRewards.earned(stakingAccount1);
			assert.bnEqual(earnedBalanceBefore, ZERO_BN);
			assert.bnGt(earnedBalanceAfter, earnedBalanceBefore);

			const rewardsBalanceAfter = await rwaone.balanceOf(liquidatorRewards.address);
			assert.bnEqual(rewardsBalanceBefore, ZERO_BN);
			assert.bnEqual(rewardsBalanceAfter, rewardsBalanceBefore.add(newRewards));

			const accumulatedRewardsAfter = await liquidatorRewards.accumulatedRewardsPerShare();
			assert.bnEqual(accumulatedRewardsBefore, ZERO_BN);
			assert.bnEqual(
				accumulatedRewardsAfter,
				accumulatedRewardsBefore.add(
					newRewards.mul(toUnit(1)).div(await tribeetixDebtShare.totalSupply())
				)
			);
		});

		describe('when minting or burning debt', () => {
			beforeEach(async () => {
				await setupStakers();

				const rewardValue = toUnit('100');
				await rwaone.transfer(liquidatorRewards.address, rewardValue, { from: owner });

				await liquidatorRewards.notifyRewardAmount(rewardValue, {
					from: mockRwaone,
				});
			});

			it('equal after minting', async () => {
				const beforeEarnedValue = await liquidatorRewards.earned(stakingAccount1);
				const beforeDebtShareBalance = await tribeetixDebtShare.balanceOf(stakingAccount2);
				const beforeDebtSharesSupply = await tribeetixDebtShare.totalSupply();

				await rwaone.transfer(stakingAccount2, toUnit('1000'), { from: owner });
				await rwaone.issueMaxTribes({ from: stakingAccount2 });

				const afterEarnedValue = await liquidatorRewards.earned(stakingAccount1);
				const afterDebtShareBalance = await tribeetixDebtShare.balanceOf(stakingAccount2);
				const afterDebtSharesSupply = await tribeetixDebtShare.totalSupply();

				assert.bnEqual(afterEarnedValue, beforeEarnedValue);
				assert.bnGt(afterDebtShareBalance, beforeDebtShareBalance);
				assert.bnGt(afterDebtSharesSupply, beforeDebtSharesSupply);
			});

			it('equal after burning', async () => {
				const beforeEarnedValue = await liquidatorRewards.earned(stakingAccount1);
				const beforeDebtShareBalance = await tribeetixDebtShare.balanceOf(stakingAccount2);
				const beforeDebtSharesSupply = await tribeetixDebtShare.totalSupply();

				// skip minimumStakeTime in order to burn tribes
				await systemSettings.setMinimumStakeTime(10, { from: owner });
				await fastForward(10);

				await rwaone.burnTribes(toUnit('100'), { from: stakingAccount2 });

				const afterEarnedValue = await liquidatorRewards.earned(stakingAccount1);
				const afterDebtShareBalance = await tribeetixDebtShare.balanceOf(stakingAccount2);
				const afterDebtSharesSupply = await tribeetixDebtShare.totalSupply();

				assert.bnEqual(afterEarnedValue, beforeEarnedValue);
				assert.bnLt(afterDebtShareBalance, beforeDebtShareBalance);
				assert.bnLt(afterDebtSharesSupply, beforeDebtSharesSupply);
			});
		});
	});

	describe('getReward()', () => {
		beforeEach(async () => {
			await setupStakers();
		});

		it('should be zero if there are no rewards to claim', async () => {
			const accumulatedRewards = await liquidatorRewards.accumulatedRewardsPerShare();
			assert.bnEqual(accumulatedRewards, ZERO_BN);

			const postEarnedBal = await liquidatorRewards.earned(stakingAccount1);
			assert.bnEqual(postEarnedBal, ZERO_BN);

			const collateralBefore = await rwaone.collateral(stakingAccount1);

			await liquidatorRewards.getReward(stakingAccount1, { from: stakingAccount1 });

			const collateralAfter = await rwaone.collateral(stakingAccount1);

			assert.bnEqual(collateralAfter, collateralBefore);
		});

		it('should decrease after rewards are claimed', async () => {
			await setupReward();

			const initialEarnedBal = await liquidatorRewards.earned(stakingAccount1);
			const rewardsBalanceBeforeClaim = await rwaone.balanceOf(liquidatorRewards.address);

			const tx = await liquidatorRewards.getReward(stakingAccount1, { from: stakingAccount1 });

			assert.eventEqual(tx, 'RewardPaid', {
				user: stakingAccount1,
				reward: initialEarnedBal,
			});

			const postEarnedBal = await liquidatorRewards.earned(stakingAccount1);
			assert.bnEqual(postEarnedBal, ZERO_BN);

			const rewardsBalanceAfterClaim = await rwaone.balanceOf(liquidatorRewards.address);
			assert.bnEqual(rewardsBalanceAfterClaim, rewardsBalanceBeforeClaim.sub(initialEarnedBal));
		});

		it('should not allow rewards to be claimed again', async () => {
			await setupReward();

			const initialEarnedBal = await liquidatorRewards.earned(stakingAccount1);
			const rewardsBalanceBeforeClaim = await rwaone.balanceOf(liquidatorRewards.address);

			// claim rewards for the first time
			await liquidatorRewards.getReward(stakingAccount1, { from: stakingAccount1 });

			const rewardsBalanceAfterClaim = await rwaone.balanceOf(liquidatorRewards.address);
			assert.bnEqual(rewardsBalanceAfterClaim, rewardsBalanceBeforeClaim.sub(initialEarnedBal));

			const collateralBefore = await rwaone.collateral(stakingAccount1);

			// attempt to claim rewards again before any new rewards come in
			await liquidatorRewards.getReward(stakingAccount1, { from: stakingAccount1 });

			const collateralAfter = await rwaone.collateral(stakingAccount1);

			assert.bnEqual(collateralAfter, collateralBefore);
		});

		it('should remain the same for an account who did not claim yet', async () => {
			await setupReward();

			const initialEarnedBal1 = await liquidatorRewards.earned(stakingAccount1);
			const initialEarnedBal2 = await liquidatorRewards.earned(stakingAccount2);

			assert.bnGt(initialEarnedBal1, ZERO_BN);
			assert.bnGt(initialEarnedBal2, ZERO_BN);

			await liquidatorRewards.getReward(stakingAccount1, { from: stakingAccount1 });

			const postEarnedBal1 = await liquidatorRewards.earned(stakingAccount1);
			assert.bnEqual(postEarnedBal1, ZERO_BN);

			const postEarnedBal2 = await liquidatorRewards.earned(stakingAccount2);
			assert.bnEqual(postEarnedBal2, initialEarnedBal2);
		});
	});
});
