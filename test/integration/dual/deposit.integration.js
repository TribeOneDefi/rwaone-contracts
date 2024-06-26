const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { finalizationOnL2 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');

describe('deposit() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const amountToDeposit = ethers.utils.parseEther('10');

	let owner;
	let Rwaone, RwaoneL2, RwaoneBridgeToOptimism, RwaoneBridgeEscrow;

	let ownerBalance, ownerL2Balance, escrowBalance;

	let depositReceipt;

	describe('when the owner deposits wRWAX', () => {
		before('target contracts and users', () => {
			({ Rwaone, RwaoneBridgeToOptimism, RwaoneBridgeEscrow } = ctx.l1.contracts);
			({ Rwaone: RwaoneL2 } = ctx.l2.contracts);

			owner = ctx.l1.users.owner;
		});

		before('record balances', async () => {
			ownerBalance = await Rwaone.balanceOf(owner.address);
			ownerL2Balance = await RwaoneL2.balanceOf(owner.address);
			escrowBalance = await Rwaone.balanceOf(RwaoneBridgeEscrow.address);
		});

		before('approve if needed', async () => {
			await approveIfNeeded({
				token: Rwaone,
				owner,
				beneficiary: RwaoneBridgeToOptimism,
				amount: amountToDeposit,
			});
		});

		before('make the deposit', async () => {
			RwaoneBridgeToOptimism = RwaoneBridgeToOptimism.connect(owner);

			const tx = await RwaoneBridgeToOptimism.deposit(amountToDeposit);
			depositReceipt = await tx.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await Rwaone.balanceOf(owner.address);

			assert.bnEqual(newOwnerBalance, ownerBalance.sub(amountToDeposit));
		});

		it('increases the escrow balance', async () => {
			const newEscrowBalance = await Rwaone.balanceOf(RwaoneBridgeEscrow.address);

			assert.bnEqual(newEscrowBalance, escrowBalance.add(amountToDeposit));
		});

		describe('when the deposit gets picked up in L2', () => {
			before('target contracts and users', () => {
				owner = ctx.l2.users.owner;
			});

			before('wait for deposit finalization', async () => {
				await finalizationOnL2({ ctx, transactionHash: depositReceipt.transactionHash });
			});

			it('increases the owner balance', async () => {
				assert.bnEqual(
					await RwaoneL2.balanceOf(owner.address),
					ownerL2Balance.add(amountToDeposit)
				);
			});
		});
	});
});
