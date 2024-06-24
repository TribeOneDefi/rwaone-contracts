const ethers = require('ethers');
const { toBytes32 } = require('../../../index');
const { assert } = require('../../contracts/common');
const { getRate, addAggregatorAndSetRate } = require('../utils/rates');
const { ensureBalance } = require('../utils/balances');
const { skipLiquidationDelay } = require('../utils/skip');

function itCanLiquidate({ ctx }) {
	describe('liquidating', () => {
		let user7, user8;
		let owner;
		let someUser;
		let liquidatedUser;
		let liquidatorUser;
		let flaggerUser;
		let exchangeRate;
		let Liquidator,
			LiquidatorRewards,
			RewardEscrowV2,
			Rwaone,
			RwaoneDebtShare,
			SystemSettings;

		before('target contracts and users', () => {
			({
				Liquidator,
				LiquidatorRewards,
				RewardEscrowV2,
				Rwaone,
				RwaoneDebtShare,
				SystemSettings,
			} = ctx.contracts);

			({ owner, someUser, liquidatedUser, flaggerUser, liquidatorUser, user7, user8 } = ctx.users);

			RewardEscrowV2 = RewardEscrowV2.connect(owner);
			SystemSettings = SystemSettings.connect(owner);
		});

		before('system settings are set', async () => {
			await SystemSettings.setIssuanceRatio(ethers.utils.parseEther('0.25')); // 400% c-ratio
			await SystemSettings.setLiquidationRatio(ethers.utils.parseEther('0.5')); // 200% c-ratio
			await SystemSettings.setSnxLiquidationPenalty(ethers.utils.parseEther('0.3')); // 30% penalty
			await SystemSettings.setSelfLiquidationPenalty(ethers.utils.parseEther('0.2')); // 20% penalty
			await SystemSettings.setFlagReward(ethers.utils.parseEther('1')); // 1 wHAKA
			await SystemSettings.setLiquidateReward(ethers.utils.parseEther('2')); // 2 wHAKA
		});

		before('ensure liquidatedUser has wHAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'wHAKA',
				user: liquidatedUser,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('ensure someUser has wHAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'wHAKA',
				user: someUser,
				balance: ethers.utils.parseEther('8000'),
			});
		});

		before('ensure user7 has wHAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'wHAKA',
				user: user7,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('ensure user8 has wHAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'wHAKA',
				user: user8,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('exchange rate is set', async () => {
			exchangeRate = await getRate({ ctx, symbol: 'wHAKA' });
			await addAggregatorAndSetRate({
				ctx,
				currencyKey: toBytes32('wHAKA'),
				rate: '6000000000000000000', // $6
			});
		});

		before('liquidatedUser stakes their wHAKA', async () => {
			await Rwaone.connect(liquidatedUser).issueMaxTribes();
		});

		before('someUser stakes their wHAKA', async () => {
			await Rwaone.connect(someUser).issueMaxTribes();
		});

		it('cannot be liquidated at this point', async () => {
			assert.equal(await Liquidator.isLiquidationOpen(liquidatedUser.address, false), false);
		});

		describe('getting marked and partially liquidated', () => {
			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: '2500000000000000000', // $2.50
				});
			});

			before('liquidation is marked', async () => {
				await Liquidator.connect(flaggerUser).flagAccountForLiquidation(liquidatedUser.address);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('still not open for liquidation', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(liquidatedUser.address, false), false);
			});

			it('deadline has not passed yet', async () => {
				assert.equal(await Liquidator.isLiquidationDeadlinePassed(liquidatedUser.address), false);
			});

			describe('when the liquidation delay passes', () => {
				before(async () => {
					await skipLiquidationDelay({ ctx });
				});

				describe('getting liquidated', () => {
					let tx;
					let beforeCRatio;
					let beforeDebtShares, beforeSharesSupply;
					let beforeFlagRewardCredittedSnx,
						beforeLiquidateRewardCredittedSnx,
						beforeRemainingRewardCredittedSnx;

					before('liquidatorUser calls liquidateDelinquentAccount', async () => {
						beforeDebtShares = await RwaoneDebtShare.balanceOf(liquidatedUser.address);
						beforeSharesSupply = await RwaoneDebtShare.totalSupply();
						beforeFlagRewardCredittedSnx = await Rwaone.balanceOf(flaggerUser.address);
						beforeLiquidateRewardCredittedSnx = await Rwaone.balanceOf(liquidatorUser.address);
						beforeRemainingRewardCredittedSnx = await Rwaone.balanceOf(
							LiquidatorRewards.address
						);

						beforeCRatio = await Rwaone.collateralisationRatio(liquidatedUser.address);

						tx = await Rwaone.connect(liquidatorUser).liquidateDelinquentAccount(
							liquidatedUser.address
						);

						const { gasUsed } = await tx.wait();
						console.log(
							`    liquidateDelinquentAccount() with no escrow entries gas used: ${Math.round(
								gasUsed / 1000
							).toString()}k`
						);
					});

					it('fixes the c-ratio of the partially liquidatedUser', async () => {
						const cratio = await Rwaone.collateralisationRatio(liquidatedUser.address);
						// Check that the ratio is repaired
						assert.bnLt(cratio, beforeCRatio);
					});

					it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
						const afterDebtShares = await RwaoneDebtShare.balanceOf(liquidatedUser.address);
						const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
						const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

						assert.bnEqual(await RwaoneDebtShare.totalSupply(), afterSupply);
					});

					it('should remove the liquidation entry for the liquidatedUser', async () => {
						assert.isFalse(await Liquidator.isLiquidationOpen(liquidatedUser.address, false));
						assert.bnEqual(
							await Liquidator.getLiquidationDeadlineForAccount(liquidatedUser.address),
							0
						);
					});

					it('transfers the flag reward to flaggerUser', async () => {
						const flagReward = await Liquidator.flagReward();
						assert.bnEqual(
							await Rwaone.balanceOf(flaggerUser.address),
							beforeFlagRewardCredittedSnx.add(flagReward)
						);
					});

					it('transfers the liquidate reward to liquidatorUser', async () => {
						const liquidateReward = await Liquidator.liquidateReward();
						assert.bnEqual(
							await Rwaone.balanceOf(liquidatorUser.address),
							beforeLiquidateRewardCredittedSnx.add(liquidateReward)
						);
					});

					it('transfers the redeemed wHAKA to LiquidatorRewards', async () => {
						const { events } = await tx.wait();
						const liqEvent = events.find(l => l.event === 'AccountLiquidated');
						const snxRedeemed = liqEvent.args.snxRedeemed;
						assert.bnEqual(
							await Rwaone.balanceOf(LiquidatorRewards.address),
							beforeRemainingRewardCredittedSnx.add(snxRedeemed)
						);
					});

					it('should allow someUser to claim their share of the liquidation rewards', async () => {
						const earnedReward = await LiquidatorRewards.earned(someUser.address);

						const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

						const { events } = await tx.wait();

						const event = events.find(l => l.event === 'RewardPaid');
						const payee = event.args.user;
						const reward = event.args.reward;

						assert.equal(payee, someUser.address);
						assert.bnEqual(reward, earnedReward);

						const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
						assert.bnEqual(earnedRewardAfterClaiming, '0');
					});
				});
			});
		});

		describe('getting marked and completely liquidated', () => {
			before('exchange rate is set', async () => {
				exchangeRate = await getRate({ ctx, symbol: 'wHAKA' });
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: '6000000000000000000', // $6
				});
			});

			before('user7 stakes their wHAKA', async () => {
				await Rwaone.connect(user7).issueMaxTribes();
			});

			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: '1000000000000000000', // $1.00
				});
			});

			before('liquidation is marked', async () => {
				await Liquidator.connect(flaggerUser).flagAccountForLiquidation(user7.address);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('still not open for liquidation', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(user7.address, false), false);
			});

			it('deadline has not passed yet', async () => {
				assert.equal(await Liquidator.isLiquidationDeadlinePassed(user7.address), false);
			});

			describe('when the liquidation delay passes', () => {
				before(async () => {
					await skipLiquidationDelay({ ctx });
				});

				describe('getting liquidated', () => {
					let tx, viewResults;
					let collateralBefore;
					let flagReward, liquidateReward;
					let beforeDebtShares, beforeSharesSupply, beforeDebtBalance;
					let beforeFlagRewardCredittedSnx,
						beforeLiquidateRewardCredittedSnx,
						beforeRemainingRewardCredittedSnx;

					before('liquidatorUser calls liquidateDelinquentAccount', async () => {
						flagReward = await Liquidator.flagReward();
						liquidateReward = await Liquidator.liquidateReward();

						collateralBefore = await Rwaone.collateral(user7.address);
						beforeDebtShares = await RwaoneDebtShare.balanceOf(user7.address);
						beforeSharesSupply = await RwaoneDebtShare.totalSupply();
						beforeFlagRewardCredittedSnx = await Rwaone.balanceOf(flaggerUser.address);
						beforeLiquidateRewardCredittedSnx = await Rwaone.balanceOf(liquidatorUser.address);
						beforeRemainingRewardCredittedSnx = await Rwaone.balanceOf(
							LiquidatorRewards.address
						);
						beforeDebtBalance = await Rwaone.debtBalanceOf(user7.address, toBytes32('rUSD'));

						viewResults = await Liquidator.liquidationAmounts(user7.address, false);
						tx = await Rwaone.connect(liquidatorUser).liquidateDelinquentAccount(user7.address);
					});

					it('results correspond to view before liquidation', async () => {
						assert.bnEqual(
							viewResults.totalRedeemed,
							collateralBefore.sub(flagReward.add(liquidateReward))
						);
						assert.bnEqual(viewResults.escrowToLiquidate, 0);
						assert.bnEqual(viewResults.initialDebtBalance, beforeDebtBalance);
						// debt per debt share changes a bit
						assert.bnEqual(viewResults.debtToRemove.toString(), beforeDebtBalance.toString());
					});

					it('removes all transferable collateral from the liquidated user', async () => {
						const collateralAfter = await Rwaone.collateral(user7.address);
						assert.bnLt(collateralAfter, collateralBefore);
						assert.bnEqual(await Rwaone.balanceOf(user7.address), '0');
						assert.bnEqual(
							viewResults.totalRedeemed,
							collateralBefore.sub(flagReward.add(liquidateReward))
						);
					});

					it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
						const afterDebtShares = await RwaoneDebtShare.balanceOf(user7.address);
						const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
						const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

						assert.bnEqual(await RwaoneDebtShare.totalSupply(), afterSupply);
					});

					it('should remove the liquidation entry for the user7', async () => {
						assert.isFalse(await Liquidator.isLiquidationOpen(user7.address, false));
						assert.bnEqual(await Liquidator.getLiquidationDeadlineForAccount(user7.address), 0);
					});

					it('transfers the flag reward to flaggerUser', async () => {
						const flagReward = await Liquidator.flagReward();
						assert.bnEqual(
							await Rwaone.balanceOf(flaggerUser.address),
							beforeFlagRewardCredittedSnx.add(flagReward)
						);
					});

					it('transfers the liquidate reward to liquidatorUser', async () => {
						const liquidateReward = await Liquidator.liquidateReward();
						assert.bnEqual(
							await Rwaone.balanceOf(liquidatorUser.address),
							beforeLiquidateRewardCredittedSnx.add(liquidateReward)
						);
					});

					it('transfers the redeemed wHAKA to LiquidatorRewards', async () => {
						const { events } = await tx.wait();
						const liqEvent = events.find(l => l.event === 'AccountLiquidated');
						const snxRedeemed = liqEvent.args.snxRedeemed;
						assert.bnEqual(
							await Rwaone.balanceOf(LiquidatorRewards.address),
							beforeRemainingRewardCredittedSnx.add(snxRedeemed)
						);
					});

					it('should allow someUser to claim their share of the liquidation rewards', async () => {
						const earnedReward = await LiquidatorRewards.earned(someUser.address);

						const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

						const { events } = await tx.wait();

						const event = events.find(l => l.event === 'RewardPaid');
						const payee = event.args.user;
						const reward = event.args.reward;

						assert.equal(payee, someUser.address);
						assert.bnEqual(reward, earnedReward);

						const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
						assert.bnEqual(earnedRewardAfterClaiming, '0');
					});
				});
			});
		});

		describe('full liquidation with a majority of collateral in escrow', () => {
			let tx, viewResults;
			let flagReward, liquidateReward;
			let beforeEscrowBalance, beforeDebtBalance;
			let beforeDebtShares, beforeSharesSupply;
			let beforeSnxBalance, beforeRewardsCredittedSnx;

			before('ensure exchange rate is set', async () => {
				exchangeRate = await getRate({ ctx, symbol: 'wHAKA' });
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: '6000000000000000000', // $6
				});
			});

			before('ensure user8 has alot of escrowed wHAKA', async () => {
				flagReward = await Liquidator.flagReward();
				liquidateReward = await Liquidator.liquidateReward();

				await Rwaone.connect(owner).approve(RewardEscrowV2.address, ethers.constants.MaxUint256);

				// 100 entries is a somewhat realistic estimate for an account which as been escrowing for a while and
				// hasnt claimed
				for (let i = 0; i < 100; i++) {
					await RewardEscrowV2.createEscrowEntry(
						user8.address,
						ethers.utils.parseEther('100'), // total 10000
						86400 * 365
					);
				}
			});

			before('user8 stakes their wHAKA', async () => {
				await Rwaone.connect(user8).issueMaxTribes();
			});

			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: '300000000000000000', // $0.30
				});
			});

			it('still not open for liquidation because not flagged', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(user8.address, false), false);
			});

			before('liquidatorUser flags user8', async () => {
				await (
					await Liquidator.connect(liquidatorUser).flagAccountForLiquidation(user8.address)
				).wait();
				await skipLiquidationDelay({ ctx });
			});

			it('user8 cannot self liquidate', async () => {
				// because collateral is in escrow
				await assert.revert(
					Rwaone.connect(user8.address).liquidateSelf(),
					'Not open for liquidation'
				);
			});

			before('liquidatorUser calls liquidateDelinquentAccount', async () => {
				beforeSnxBalance = await Rwaone.balanceOf(user8.address);
				beforeEscrowBalance = await RewardEscrowV2.totalEscrowedAccountBalance(user8.address);
				beforeDebtShares = await RwaoneDebtShare.balanceOf(user8.address);
				beforeSharesSupply = await RwaoneDebtShare.totalSupply();
				beforeDebtBalance = await Rwaone.debtBalanceOf(user8.address, toBytes32('rUSD'));
				beforeRewardsCredittedSnx = await Rwaone.balanceOf(LiquidatorRewards.address);

				viewResults = await Liquidator.liquidationAmounts(user8.address, false);
				tx = await Rwaone.connect(liquidatorUser).liquidateDelinquentAccount(user8.address);

				const { gasUsed } = await tx.wait();
				console.log(
					`liquidateDelinquentAccount() with 100 escrow entries gas used: ${Math.round(
						gasUsed / 1000
					).toString()}k`
				);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('wHAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('should remove all transferable collateral', async () => {
				const afterSnxBalance = await Rwaone.balanceOf(user8.address);
				assert.bnEqual(afterSnxBalance, '0');
			});

			it('should remove all escrow', async () => {
				const afterEscrowBalance = await RewardEscrowV2.totalEscrowedAccountBalance(user8.address);
				assert.bnEqual(afterEscrowBalance, '0');
			});

			it('should remove all debt', async () => {
				const afterDebtBalance = await Rwaone.debtBalanceOf(user8.address, toBytes32('rUSD'));
				assert.bnEqual(afterDebtBalance, '0');
			});

			it('results correspond to view before liquidation', async () => {
				assert.bnEqual(
					viewResults.totalRedeemed,
					beforeSnxBalance.add(beforeEscrowBalance).sub(flagReward.add(liquidateReward))
				);
				assert.bnEqual(viewResults.escrowToLiquidate, beforeEscrowBalance);
				assert.bnEqual(viewResults.initialDebtBalance, beforeDebtBalance);
				// debt per debt share changes a bit
				assert.bnEqual(viewResults.debtToRemove.toString(), beforeDebtBalance.toString());
			});

			it('should liquidate all debt and redeem all wHAKA', async () => {
				// Get event data.
				const { events } = await tx.wait();
				const liqEvent = events.find(l => l.event === 'AccountLiquidated');
				const amountLiquidated = liqEvent.args.amountLiquidated;
				const snxRedeemed = liqEvent.args.snxRedeemed;

				assert.bnEqual(
					snxRedeemed,
					beforeSnxBalance.add(beforeEscrowBalance).sub(flagReward.add(liquidateReward))
				);
				assert.bnEqual(amountLiquidated.toString(), beforeDebtBalance.toString()); // the variance is due to a rounding error as a result of multiplication of the wHAKA rate
			});

			it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
				const afterDebtShares = await RwaoneDebtShare.balanceOf(user8.address);
				const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
				const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

				assert.bnEqual(await RwaoneDebtShare.totalSupply(), afterSupply);
			});

			it('should not be open for liquidation anymore', async () => {
				assert.isFalse(await Liquidator.isLiquidationOpen(user8.address, false));
				assert.bnEqual(await Liquidator.getLiquidationDeadlineForAccount(user8.address), 0);
			});

			it('transfers the redeemed wHAKA + escrow to LiquidatorRewards', async () => {
				const { events } = await tx.wait();
				const liqEvent = events.find(l => l.event === 'AccountLiquidated');
				const snxRedeemed = liqEvent.args.snxRedeemed;
				assert.bnEqual(
					await Rwaone.balanceOf(LiquidatorRewards.address),
					beforeRewardsCredittedSnx.add(snxRedeemed)
				);
			});

			it('should allow someUser to claim their share of the liquidation rewards', async () => {
				const earnedReward = await LiquidatorRewards.earned(someUser.address);

				const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

				const { events } = await tx.wait();

				const event = events.find(l => l.event === 'RewardPaid');
				const payee = event.args.user;
				const reward = event.args.reward;

				assert.equal(payee, someUser.address);
				assert.bnEqual(reward, earnedReward);

				const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
				assert.bnEqual(earnedRewardAfterClaiming, '0');
			});
		});
	});
}

module.exports = {
	itCanLiquidate,
};
