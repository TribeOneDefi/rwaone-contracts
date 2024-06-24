const { contract, web3 } = require('hardhat');
const { setupAllContracts } = require('./setup');
const { assert } = require('./common');
const { toBN } = web3.utils;
const {
	defaults: {
		CROSS_DOMAIN_DEPOSIT_GAS_LIMIT,
		CROSS_DOMAIN_ESCROW_GAS_LIMIT,
		CROSS_DOMAIN_REWARD_GAS_LIMIT,
		CROSS_DOMAIN_WITHDRAWAL_GAS_LIMIT,
	},
} = require('../../');
const { artifacts } = require('hardhat');

contract('RwaoneBridgeToOptimism (spec tests) @ovm-skip', accounts => {
	const [, owner, randomAddress] = accounts;

	let rwaone,
		tribeetixProxy,
		tribeetixBridgeToOptimism,
		tribeetixBridgeEscrow,
		systemSettings,
		rewardsDistribution;

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				Rwaone: rwaone,
				ProxyERC20Rwaone: tribeetixProxy,
				RwaoneBridgeToOptimism: tribeetixBridgeToOptimism,
				SystemSettings: systemSettings,
				RwaoneBridgeEscrow: tribeetixBridgeEscrow,
				RewardsDistribution: rewardsDistribution,
			} = await setupAllContracts({
				accounts,
				contracts: [
					'Rwaone',
					'RwaoneBridgeToOptimism',
					'SystemSettings',
					'RewardsDistribution',
				],
			}));

			// use implementation ABI on the proxy address to simplify calling
			rwaone = await artifacts.require('Rwaone').at(tribeetixProxy.address);
		});

		it('returns the expected cross domain message gas limit', async () => {
			assert.bnEqual(
				await systemSettings.crossDomainMessageGasLimit(0),
				CROSS_DOMAIN_DEPOSIT_GAS_LIMIT
			);
			assert.bnEqual(
				await systemSettings.crossDomainMessageGasLimit(1),
				CROSS_DOMAIN_ESCROW_GAS_LIMIT
			);
			assert.bnEqual(
				await systemSettings.crossDomainMessageGasLimit(2),
				CROSS_DOMAIN_REWARD_GAS_LIMIT
			);
			assert.bnEqual(
				await systemSettings.crossDomainMessageGasLimit(3),
				CROSS_DOMAIN_WITHDRAWAL_GAS_LIMIT
			);
		});

		describe('migrateEscrow', () => {
			it('reverts when an entriesId subarray contains an empty array', async () => {
				const entryIdsEmpty = [[1, 2, 3], []];
				await assert.revert(
					tribeetixBridgeToOptimism.migrateEscrow(entryIdsEmpty),
					'Entry IDs required'
				);
			});
		});

		describe('migrateEscrow', () => {
			it('reverts when an entriesId subarray contains an empty array', async () => {
				const entryIdsEmpty = [[], [1, 2, 3]];
				await assert.revert(
					tribeetixBridgeToOptimism.depositAndMigrateEscrow(1, entryIdsEmpty),
					'Entry IDs required'
				);
			});
		});

		describe('deposit', () => {
			const amountToDeposit = 1;

			describe('when a user has not provided allowance to the bridge contract', () => {
				it('the deposit should fail', async () => {
					await assert.revert(
						tribeetixBridgeToOptimism.deposit(amountToDeposit, { from: owner }),
						'SafeMath: subtraction overflow'
					);
				});
			});

			describe('when a user has provided allowance to the bridge contract', () => {
				before('approve RwaoneBridgeToOptimism', async () => {
					await rwaone.approve(tribeetixBridgeToOptimism.address, amountToDeposit, {
						from: owner,
					});
				});

				describe('when performing a deposit', () => {
					let userBalanceBefore;

					before('record balance before', async () => {
						userBalanceBefore = await rwaone.balanceOf(owner);
					});

					before('perform a deposit', async () => {
						await tribeetixBridgeToOptimism.deposit(amountToDeposit, {
							from: owner,
						});
					});

					it('reduces the user balance', async () => {
						const userBalanceAfter = await rwaone.balanceOf(owner);

						assert.bnEqual(userBalanceBefore.sub(toBN(amountToDeposit)), userBalanceAfter);
					});

					it("increases the escrow's balance", async () => {
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeEscrow.address),
							amountToDeposit
						);
					});
				});
			});
		});

		describe('depositTo', () => {
			const amountToDeposit = toBN(1);

			describe('when a user has not provided allowance to the bridge contract', () => {
				it('the deposit should fail', async () => {
					await assert.revert(
						tribeetixBridgeToOptimism.depositTo(randomAddress, amountToDeposit, { from: owner }),
						'SafeMath: subtraction overflow'
					);
				});
			});

			describe('when a user has provided allowance to the bridge contract', () => {
				before('approve RwaoneBridgeToOptimism', async () => {
					await rwaone.approve(tribeetixBridgeToOptimism.address, amountToDeposit, {
						from: owner,
					});
				});

				describe('when performing a deposit', () => {
					let userBalanceBefore;
					let contractBalanceBefore;

					before('record balances before', async () => {
						userBalanceBefore = await rwaone.balanceOf(owner);
						contractBalanceBefore = await rwaone.balanceOf(tribeetixBridgeEscrow.address);
					});

					before('perform a deposit to a separate address', async () => {
						await tribeetixBridgeToOptimism.depositTo(randomAddress, amountToDeposit, {
							from: owner,
						});
					});

					it('reduces the user balance', async () => {
						const userBalanceAfter = await rwaone.balanceOf(owner);

						assert.bnEqual(userBalanceBefore.sub(toBN(amountToDeposit)), userBalanceAfter);
					});

					it("increases the escrow's balance", async () => {
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeEscrow.address),
							contractBalanceBefore.add(amountToDeposit)
						);
					});
				});
			});
		});

		describe('depositReward', () => {
			describe('when a user has provided allowance to the bridge contract', () => {
				const amountToDeposit = toBN(1);

				before('approve RwaoneBridgeToOptimism', async () => {
					await rwaone.approve(tribeetixBridgeToOptimism.address, amountToDeposit, {
						from: owner,
					});
				});

				describe('when performing a deposit', () => {
					let userBalanceBefore;
					let contractBalanceBefore;

					before('record balance before', async () => {
						userBalanceBefore = await rwaone.balanceOf(owner);
						contractBalanceBefore = await rwaone.balanceOf(tribeetixBridgeEscrow.address);
					});

					before('perform a depositReward', async () => {
						await tribeetixBridgeToOptimism.depositReward(amountToDeposit, {
							from: owner,
						});
					});

					it('reduces the user balance', async () => {
						const userBalanceAfter = await rwaone.balanceOf(owner);

						assert.bnEqual(userBalanceBefore.sub(toBN(amountToDeposit)), userBalanceAfter);
					});

					it("increases the escrow's balance", async () => {
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeEscrow.address),
							contractBalanceBefore.add(amountToDeposit)
						);
					});
				});
			});
		});

		describe('notifyReward', () => {
			describe('the owner has added RwaoneBridgeToOptimism to rewards distributins list', () => {
				const amountToDistribute = toBN(1000);
				before('addRewardDistribution', async () => {
					await rewardsDistribution.addRewardDistribution(
						tribeetixBridgeToOptimism.address,
						amountToDistribute,
						{
							from: owner,
						}
					);
				});

				describe('distributing the rewards', () => {
					let bridgeBalanceBefore;
					let escrowBalanceBefore;

					before('record balance before', async () => {
						bridgeBalanceBefore = await rwaone.balanceOf(tribeetixBridgeToOptimism.address);
						escrowBalanceBefore = await rwaone.balanceOf(tribeetixBridgeEscrow.address);
					});

					before('transfer amount to be distributed and distributeRewards', async () => {
						// first pawn the authority contract
						await rewardsDistribution.setAuthority(owner, {
							from: owner,
						});
						await rwaone.transfer(rewardsDistribution.address, amountToDistribute, {
							from: owner,
						});
						await rewardsDistribution.distributeRewards(amountToDistribute, {
							from: owner,
						});
					});

					it('the balance of the bridge remains intact', async () => {
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeToOptimism.address),
							bridgeBalanceBefore
						);
					});

					it("increases the escrow's balance", async () => {
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeEscrow.address),
							escrowBalanceBefore.add(amountToDistribute)
						);
					});
				});
			});
		});

		describe('forwardTokensToEscrow', () => {
			describe('when some wRWAX tokens are accidentally transferred to the bridge', () => {
				const amount = toBN('999');
				let initialAmount;
				before(async () => {
					initialAmount = await rwaone.balanceOf(tribeetixBridgeEscrow.address);
					await rwaone.transfer(tribeetixBridgeToOptimism.address, amount, {
						from: owner,
					});
					assert.bnEqual(await rwaone.balanceOf(tribeetixBridgeToOptimism.address), amount);
				});
				describe('when anyone invokeds forwardTokensToEscrow', () => {
					before(async () => {
						await tribeetixBridgeToOptimism.forwardTokensToEscrow(rwaone.address, {
							from: randomAddress,
						});
					});
					it('then the tokens are sent from the bridge to the escrow', async () => {
						assert.equal(await rwaone.balanceOf(tribeetixBridgeToOptimism.address), '0');
						assert.bnEqual(
							await rwaone.balanceOf(tribeetixBridgeEscrow.address),
							initialAmount.add(amount)
						);
					});
				});
			});
		});
	});
});
