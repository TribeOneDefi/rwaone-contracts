const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');

const { toBytes32 } = require('../../../index');

const { exchangeSomething } = require('../utils/exchanging');
const { ensureBalance } = require('../utils/balances');
const { skipFeePeriod, skipMinimumStakeTime } = require('../utils/skip');

const ethers = require('ethers');

describe('staking & claiming integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	describe('staking and claiming', () => {
		const HAKAAmount = ethers.utils.parseEther('1000');
		const amountToIssueAndBurnhUSD = ethers.utils.parseEther('1');

		let user;
		let Rwaone, TribehUSD, FeePool;
		let balancehUSD, debthUSD;

		before('target contracts and users', () => {
			({ Rwaone, TribehUSD, FeePool } = ctx.l1.contracts);

			user = ctx.l1.users.someUser;
		});

		before('ensure the user has enough wHAKA', async () => {
			await ensureBalance({ ctx: ctx.l1, symbol: 'wHAKA', user, balance: HAKAAmount });
		});

		describe('when the user issues hUSD', () => {
			before('record balances', async () => {
				balancehUSD = await TribehUSD.balanceOf(user.address);
			});

			before('issue hUSD', async () => {
				Rwaone = Rwaone.connect(user);

				const tx = await Rwaone.issueTribes(amountToIssueAndBurnhUSD);
				const { gasUsed } = await tx.wait();
				console.log(`issueTribes() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('issues the expected amount of hUSD', async () => {
				assert.bnEqual(
					await TribehUSD.balanceOf(user.address),
					balancehUSD.add(amountToIssueAndBurnhUSD)
				);
			});

			describe('claiming', () => {
				before('exchange something', async () => {
					await exchangeSomething({ ctx: ctx.l1 });
				});

				describe('when the fee period closes', () => {
					before('skip fee period', async () => {
						await skipFeePeriod({ ctx: ctx.l1 });
					});

					before('close the current fee period', async () => {
						FeePool = FeePool.connect(ctx.l1.users.owner);

						const tx = await FeePool.closeCurrentFeePeriod();
						await tx.wait();
					});

					describe('when the user claims rewards', () => {
						before('record balances', async () => {
							balancehUSD = await TribehUSD.balanceOf(user.address);
						});

						before('claim', async () => {
							FeePool = FeePool.connect(user);

							const tx = await FeePool.claimFees();
							const { gasUsed } = await tx.wait();
							console.log(`claimFees() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
						});

						it('shows no change in the users hUSD balance', async () => {
							assert.bnEqual(await TribehUSD.balanceOf(user.address), balancehUSD);
						});
					});
				});
			});

			describe('when the user burns hUSD', () => {
				before('skip min stake time', async () => {
					await skipMinimumStakeTime({ ctx: ctx.l1 });
				});

				before('record debt', async () => {
					debthUSD = await Rwaone.debtBalanceOf(user.address, toBytes32('hUSD'));
				});

				before('burn hUSD', async () => {
					Rwaone = Rwaone.connect(user);

					const tx = await Rwaone.burnTribes(amountToIssueAndBurnhUSD);
					const { gasUsed } = await tx.wait();
					console.log(`burnTribes() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
				});

				it('reduced the expected amount of debt', async () => {
					const newDebthUSD = await Rwaone.debtBalanceOf(user.address, toBytes32('hUSD'));
					const debtReduction = debthUSD.sub(newDebthUSD);

					const tolerance = ethers.utils.parseUnits('0.01', 'ether');
					assert.bnClose(
						debtReduction.toString(),
						amountToIssueAndBurnhUSD.toString(),
						tolerance.toString()
					);
				});
			});
		});
	});
});
