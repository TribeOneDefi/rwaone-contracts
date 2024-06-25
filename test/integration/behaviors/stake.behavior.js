const ethers = require('ethers');
const { toBytes32 } = require('../../../index');
const { assert, addSnapshotBeforeRestoreAfter } = require('../../contracts/common');
const { ensureBalance } = require('../utils/balances');
const { skipMinimumStakeTime } = require('../utils/skip');
const { createMockAggregatorFactory } = require('../../utils/index')();

function itCanStake({ ctx }) {
	describe('staking and claiming', () => {
		const RWAXAmount = ethers.utils.parseEther('1000');
		const amountToIssueAndBurnrUSD = ethers.utils.parseEther('1');

		let tx;
		let user, owner;
		let aggregator;
		let AddressResolver, Rwaone, RwaoneDebtShare, RwarUSD, Issuer;
		let balancerUSD, debtrUSD;

		addSnapshotBeforeRestoreAfter();

		before('target contracts and users', () => {
			({ AddressResolver, Rwaone, RwaoneDebtShare, RwarUSD, Issuer } = ctx.contracts);

			user = ctx.users.otherUser;
			owner = ctx.users.owner;
		});

		before('ensure the user has enough wRWAX', async () => {
			await ensureBalance({ ctx, symbol: 'wRWAX', user, balance: RWAXAmount });
		});

		before('setup mock debt ratio aggregator', async () => {
			const MockAggregatorFactory = await createMockAggregatorFactory(owner);
			aggregator = (await MockAggregatorFactory.deploy()).connect(owner);

			tx = await aggregator.setDecimals(27);
			await tx.wait();

			const { timestamp } = await ctx.provider.getBlock();
			// debt share ratio of 0.5
			tx = await aggregator.setLatestAnswer(ethers.utils.parseUnits('0.5', 27), timestamp);
			await tx.wait();
		});

		before('import the aggregator to the resolver', async () => {
			AddressResolver = AddressResolver.connect(owner);
			tx = await AddressResolver.importAddresses(
				[toBytes32('ext:AggregatorDebtRatio')],
				[aggregator.address]
			);
			await tx.wait();
		});

		before('rebuild caches', async () => {
			tx = await Issuer.connect(owner).rebuildCache();
			await tx.wait();
		});

		describe('when the user issues rUSD', () => {
			before('record balances', async () => {
				balancerUSD = await RwarUSD.balanceOf(user.address);
				debtrUSD = await RwaoneDebtShare.balanceOf(user.address);
			});

			before('issue rUSD', async () => {
				Rwaone = Rwaone.connect(user);

				const tx = await Rwaone.issueRwas(amountToIssueAndBurnrUSD);
				const { gasUsed } = await tx.wait();
				console.log(`issueRwas() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('issues the expected amount of rUSD', async () => {
				assert.bnEqual(
					await RwarUSD.balanceOf(user.address),
					balancerUSD.add(amountToIssueAndBurnrUSD)
				);
			});

			it('issues the expected amount of debt shares', async () => {
				// mints (amountToIssueAndBurnrUSD / ratio) = debt shares
				assert.bnEqual(
					await RwaoneDebtShare.balanceOf(user.address),
					debtrUSD.add(amountToIssueAndBurnrUSD.mul(2))
				);
			});

			describe('when the user issues rUSD again', () => {
				before('record balances', async () => {
					balancerUSD = await RwarUSD.balanceOf(user.address);
					debtrUSD = await RwaoneDebtShare.balanceOf(user.address);
				});

				before('issue rUSD', async () => {
					const tx = await Rwaone.issueRwas(amountToIssueAndBurnrUSD.mul(2));
					await tx.wait();
				});

				it('issues the expected amount of rUSD', async () => {
					assert.bnEqual(
						await RwarUSD.balanceOf(user.address),
						balancerUSD.add(amountToIssueAndBurnrUSD.mul(2))
					);
				});

				it('issues the expected amount of debt shares', async () => {
					// mints (amountToIssueAndBurnrUSD / ratio) = debt shares
					assert.bnEqual(
						await RwaoneDebtShare.balanceOf(user.address),
						debtrUSD.add(amountToIssueAndBurnrUSD.mul(4))
					);
				});

				describe('when the user burns this new amount of rUSD', () => {
					before('record balances', async () => {
						balancerUSD = await RwarUSD.balanceOf(user.address);
						debtrUSD = await RwaoneDebtShare.balanceOf(user.address);
					});

					before('skip min stake time', async () => {
						await skipMinimumStakeTime({ ctx });
					});

					before('burn rUSD', async () => {
						const tx = await Rwaone.burnRwas(amountToIssueAndBurnrUSD);
						await tx.wait();
					});

					it('debt should decrease', async () => {
						assert.bnEqual(
							await RwarUSD.balanceOf(user.address),
							balancerUSD.sub(amountToIssueAndBurnrUSD)
						);
					});

					it('debt share should decrease correctly', async () => {
						// burns (amountToIssueAndBurnrUSD / ratio) = debt shares
						assert.bnEqual(
							await RwaoneDebtShare.balanceOf(user.address),
							debtrUSD.sub(amountToIssueAndBurnrUSD.mul(2))
						);
					});
				});
			});
		});

		describe('when the user burns rUSD again', () => {
			before('skip min stake time', async () => {
				await skipMinimumStakeTime({ ctx });
			});

			before('record debt', async () => {
				debtrUSD = await Rwaone.debtBalanceOf(user.address, toBytes32('rUSD'));
			});

			before('burn rUSD', async () => {
				Rwaone = Rwaone.connect(user);

				const tx = await Rwaone.burnRwas(amountToIssueAndBurnrUSD);
				const { gasUsed } = await tx.wait();
				console.log(`burnRwas() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('reduces the expected amount of debt', async () => {
				const newDebtrUSD = await Rwaone.debtBalanceOf(user.address, toBytes32('rUSD'));
				const debtReduction = debtrUSD.sub(newDebtrUSD);

				const tolerance = ethers.utils.parseUnits('0.01', 'ether');
				assert.bnClose(
					debtReduction.toString(),
					amountToIssueAndBurnrUSD.toString(),
					tolerance.toString()
				);
			});

			it('reduces the expected amount of debt shares', async () => {
				// burns (amountToIssueAndBurnrUSD / ratio) = debt shares
				assert.bnEqual(
					await RwaoneDebtShare.balanceOf(user.address),
					amountToIssueAndBurnrUSD.mul(2)
				);
			});
		});
	});
}

module.exports = {
	itCanStake,
};
