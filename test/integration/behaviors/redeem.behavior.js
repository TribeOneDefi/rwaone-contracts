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
	describe('redemption of deprecated tribes', () => {
		let owner;
		let someUser;
		let Rwaone, Issuer, TribeToRedeem, TriberUSD, TribeToRedeemProxy, TribeRedeemer;
		let totalDebtBeforeRemoval;
		let tribe;

		before('target contracts and users', () => {
			// rETH and hBTC can't be removed because the debt may be too large for removeTribe to not underflow
			// during debt update, so rETHBTC is used here
			tribe = 'rETHBTC';

			({
				Rwaone,
				Issuer,
				[`Tribe${tribe}`]: TribeToRedeem,
				[`Proxy${tribe}`]: TribeToRedeemProxy,
				TriberUSD,
				TribeRedeemer,
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

		before(`ensure the user has some of the target tribe`, async () => {
			await ensureBalance({
				ctx,
				symbol: tribe,
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
			totalDebtBeforeRemoval = await Issuer.totalIssuedTribes(toBytes32('rUSD'), true);
		});

		describe(`deprecating the tribe`, () => {
			before(`when the owner removes the tribe`, async () => {
				Issuer = Issuer.connect(owner);
				// note: this sets the tribe as redeemed and cannot be undone without
				// redeploying locally or restarting a fork
				const tx = await Issuer.removeTribe(toBytes32(tribe));
				await tx.wait();
			});

			it('then the total system debt is unchanged', async () => {
				assert.bnEqual(
					await Issuer.totalIssuedTribes(toBytes32('rUSD'), true),
					totalDebtBeforeRemoval
				);
			});
			it(`and the tribe is removed from the system`, async () => {
				assert.equal(await Rwaone.tribes(toBytes32(tribe)), ZERO_ADDRESS);
			});
			describe('user redemption', () => {
				let rUSDBeforeRedemption;
				before(async () => {
					rUSDBeforeRedemption = await TriberUSD.balanceOf(someUser.address);
				});

				before(`when the user redeems their tribe`, async () => {
					TribeRedeemer = TribeRedeemer.connect(someUser);
					const tx = await TribeRedeemer.redeem(TribeToRedeemProxy.address);
					await tx.wait();
				});

				it(`then the user has no more tribe`, async () => {
					assert.equal(await TribeToRedeem.balanceOf(someUser.address), '0');
				});

				it('and they have more rUSD again', async () => {
					assert.bnGt(await TriberUSD.balanceOf(someUser.address), rUSDBeforeRedemption);
				});
			});
		});
	});
}

module.exports = {
	itCanRedeem,
};
