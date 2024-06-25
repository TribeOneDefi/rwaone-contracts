const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../../../index');
const { ensureBalance } = require('../utils/balances');
const { skipWaitingPeriod } = require('../utils/skip');
const { increaseStalePeriodAndCheckRatesAndCache } = require('../utils/rates');

function itCanRedeem({ ctx }) {
	describe('redemption of deprecated rwas', () => {
		let owner;
		let someUser;
		let Rwaone, Issuer, RwaToRedeem, RwarUSD, RwaToRedeemProxy, RwaRedeemer;
		let totalDebtBeforeRemoval;
		let rwa;

		before('target contracts and users', () => {
			// rETH and rBTC can't be removed because the debt may be too large for removeRwa to not underflow
			// during debt update, so rETHBTC is used here
			rwa = 'rETHBTC';

			({
				Rwaone,
				Issuer,
				[`Rwa${rwa}`]: RwaToRedeem,
				[`Proxy${rwa}`]: RwaToRedeemProxy,
				RwarUSD,
				RwaRedeemer,
			} = ctx.contracts);

			({ owner, someUser } = ctx.users);
		});

		before('ensure the user has rUSD', async () => {
			await ensureBalance({
				ctx,
				symbol: 'rUSD',
				user: someUser,
				balance: ethers.utils.parseEther('100'),
			});
		});

		before(`ensure the user has some of the target rwa`, async () => {
			await ensureBalance({
				ctx,
				symbol: rwa,
				user: someUser,
				balance: ethers.utils.parseEther('100'),
			});
		});

		before('skip waiting period', async () => {
			await skipWaitingPeriod({ ctx });
		});

		before('update rates and take snapshot if needed', async () => {
			await increaseStalePeriodAndCheckRatesAndCache({ ctx });
		});

		before('record total system debt', async () => {
			totalDebtBeforeRemoval = await Issuer.totalIssuedRwas(toBytes32('rUSD'), true);
		});

		describe(`deprecating the rwa`, () => {
			before(`when the owner removes the rwa`, async () => {
				Issuer = Issuer.connect(owner);
				// note: this sets the rwa as redeemed and cannot be undone without
				// redeploying locally or restarting a fork
				const tx = await Issuer.removeRwa(toBytes32(rwa));
				await tx.wait();
			});

			it('then the total system debt is unchanged', async () => {
				assert.bnEqual(
					await Issuer.totalIssuedRwas(toBytes32('rUSD'), true),
					totalDebtBeforeRemoval
				);
			});
			it(`and the rwa is removed from the system`, async () => {
				assert.equal(await Rwaone.rwas(toBytes32(rwa)), ZERO_ADDRESS);
			});
			describe('user redemption', () => {
				let rUSDBeforeRedemption;
				before(async () => {
					rUSDBeforeRedemption = await RwarUSD.balanceOf(someUser.address);
				});

				before(`when the user redeems their rwa`, async () => {
					RwaRedeemer = RwaRedeemer.connect(someUser);
					const tx = await RwaRedeemer.redeem(RwaToRedeemProxy.address);
					await tx.wait();
				});

				it(`then the user has no more rwa`, async () => {
					assert.equal(await RwaToRedeem.balanceOf(someUser.address), '0');
				});

				it('and they have more rUSD again', async () => {
					assert.bnGt(await RwarUSD.balanceOf(someUser.address), rUSDBeforeRedemption);
				});
			});
		});
	});
}

module.exports = {
	itCanRedeem,
};
