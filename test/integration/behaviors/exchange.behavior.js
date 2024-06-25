const ethers = require('ethers');
const chalk = require('chalk');
const { assert } = require('../../contracts/common');
const { toBytes32 } = require('../../../index');
const { ensureBalance } = require('../utils/balances');
const { skipWaitingPeriod } = require('../utils/skip');
const { updateCache } = require('../utils/rates');

function itCanExchange({ ctx }) {
	describe('exchanging and settling', () => {
		const rUSDAmount = ethers.utils.parseEther('100');

		let owner;
		let balancerETH, originialPendingSettlements;
		let Rwaone, Exchanger, RwarETH;

		before('target contracts and users', () => {
			({ Rwaone, Exchanger, RwarETH } = ctx.contracts);

			owner = ctx.users.owner;
		});

		before('ensure the owner has rUSD', async () => {
			await ensureBalance({ ctx, symbol: 'rUSD', user: owner, balance: rUSDAmount });
		});

		describe('when the owner exchanges rUSD to rETH', () => {
			before('record balances', async () => {
				balancerETH = await RwarETH.balanceOf(owner.address);
			});

			before('record pending settlements', async () => {
				const { numEntries } = await Exchanger.settlementOwing(owner.address, toBytes32('rETH'));

				originialPendingSettlements = numEntries;
			});

			before('perform the exchange', async () => {
				Rwaone = Rwaone.connect(owner);

				await updateCache({ ctx });

				const tx = await Rwaone.exchange(toBytes32('rUSD'), rUSDAmount, toBytes32('rETH'));
				const { gasUsed } = await tx.wait();
				console.log(`exchange() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('receives the expected amount of rETH', async () => {
				const [expectedAmount, ,] = await Exchanger.getAmountsForExchange(
					rUSDAmount,
					toBytes32('rUSD'),
					toBytes32('rETH')
				);

				assert.bnEqual(await RwarETH.balanceOf(owner.address), balancerETH.add(expectedAmount));
			});

			before('skip if waiting period is zero', async function () {
				const waitingPeriodSecs = await Exchanger.waitingPeriodSecs();
				if (waitingPeriodSecs.toString() === '0') {
					console.log(
						chalk.yellow('> Skipping pending settlement checks because waiting period is zero.')
					);
					this.skip();
				}
			});

			it('shows that the user now has pending settlements', async () => {
				const { numEntries } = await Exchanger.settlementOwing(owner.address, toBytes32('rETH'));

				assert.bnEqual(numEntries, originialPendingSettlements.add(ethers.constants.One));
			});

			describe('when settle is called', () => {
				before('skip waiting period', async () => {
					await skipWaitingPeriod({ ctx });
				});

				before('settle', async () => {
					const tx = await Rwaone.settle(toBytes32('rETH'));
					const { gasUsed } = await tx.wait();
					console.log(`settle() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
				});

				it('shows that the user no longer has pending settlements', async () => {
					const { numEntries } = await Exchanger.settlementOwing(owner.address, toBytes32('rETH'));

					assert.bnEqual(numEntries, ethers.constants.Zero);
				});
			});
		});
	});

	describe('settings are configurable', async () => {
		let owner, SystemSettings;

		before('target contracts and users', () => {
			({ SystemSettings } = ctx.contracts);
			owner = ctx.users.owner;
		});

		it('set rUSD to use the pure chainlink price for atomic swap', async () => {
			await SystemSettings.connect(owner).setPureChainlinkPriceForAtomicSwapsEnabled(
				toBytes32('rUSD'),
				false
			);
			const resp1 = await SystemSettings.pureChainlinkPriceForAtomicSwapsEnabled(toBytes32('rUSD'));
			assert.bnEqual(resp1, false);
			await SystemSettings.connect(owner).setPureChainlinkPriceForAtomicSwapsEnabled(
				toBytes32('rUSD'),
				true
			);
			const resp2 = await SystemSettings.pureChainlinkPriceForAtomicSwapsEnabled(toBytes32('rUSD'));
			assert.bnEqual(resp2, true);
		});
	});
}

module.exports = {
	itCanExchange,
};
