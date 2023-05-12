const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { appendEscrows, retrieveEscrowParameters } = require('../utils/escrow');
const { finalizationOnL2 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');

describe('depositAndMigrateEscrow() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	let user;
	let Tribeone, RewardEscrowV2, TribeoneBridgeToOptimism;

	let initialParametersL1, initialParametersL2, initialUserL1Balance;
	const hakaAmount = ethers.utils.parseEther('100');

	before('record initial escrow state', async () => {
		initialParametersL1 = await retrieveEscrowParameters({ ctx: ctx.l1 });
		initialParametersL2 = await retrieveEscrowParameters({ ctx: ctx.l2 });

		({ Tribeone } = ctx.l1.contracts);
		user = ctx.l1.users.owner;
		initialUserL1Balance = await Tribeone.balanceOf(user.address);
	});

	before('approve reward escrow if needed', async () => {
		({ Tribeone, RewardEscrowV2 } = ctx.l1.contracts);
		user = ctx.l1.users.owner;

		await approveIfNeeded({
			token: Tribeone,
			owner: user,
			beneficiary: RewardEscrowV2,
			amount: hakaAmount,
		});
	});

	const escrowNum = 26;
	const escrowBatches = 2;
	const numExtraEntries = 0;
	const totalEntriesCreated = escrowNum * escrowBatches + numExtraEntries;
	describe(`when the user creates ${totalEntriesCreated} escrow entries`, () => {
		let postParametersL1 = {};
		let escrowEntriesData = {};

		before('create and append escrow entries', async () => {
			user = ctx.l1.users.owner;

			escrowEntriesData = await appendEscrows({
				ctx: ctx.l1,
				user,
				escrowBatches,
				numExtraEntries,
				escrowNum,
				escrowEntryAmount: ethers.constants.One,
			});
		});

		before('grab new states on L1', async () => {
			postParametersL1 = await retrieveEscrowParameters({ ctx: ctx.l1 });
		});

		it('should update the L1 escrow state', () => {
			assert.bnEqual(
				postParametersL1.escrowedBalance,
				initialParametersL1.escrowedBalance.add(escrowEntriesData.totalEscrowed)
			);
			assert.bnEqual(
				postParametersL1.userNumVestingEntries,
				initialParametersL1.userNumVestingEntries.add(totalEntriesCreated)
			);
			assert.bnEqual(
				postParametersL1.userEscrowedBalance,
				initialParametersL1.userEscrowedBalance.add(escrowEntriesData.totalEscrowed)
			);
			assert.bnEqual(
				postParametersL1.userVestedAccountBalance,
				initialParametersL1.userVestedAccountBalance
			);
		});

		describe('when the user migrates their escrow and deposit HAKA', () => {
			let depositAndMigrateEscrowReceipt;
			let userBalanceL2;
			let totalSupplyL2;
			let rewardEscrowBalanceL2;
			const depositAmount = ethers.utils.parseEther('20');

			before('approve L1 bridge if needed', async () => {
				({ Tribeone, TribeoneBridgeToOptimism } = ctx.l1.contracts);
				user = ctx.l1.users.owner;

				await approveIfNeeded({
					token: Tribeone,
					owner: user,
					beneficiary: TribeoneBridgeToOptimism,
					amount: depositAmount,
				});
			});

			before('target contracts and users', () => {
				({ Tribeone, RewardEscrowV2 } = ctx.l2.contracts);

				user = ctx.l2.users.owner;
			});

			before('record current values', async () => {
				userBalanceL2 = await Tribeone.balanceOf(user.address);
				totalSupplyL2 = await Tribeone.totalSupply();
				rewardEscrowBalanceL2 = await Tribeone.balanceOf(RewardEscrowV2.address);
			});

			before('depositAndMigrateEscrow', async () => {
				({ TribeoneBridgeToOptimism } = ctx.l1.contracts);

				TribeoneBridgeToOptimism = TribeoneBridgeToOptimism.connect(ctx.l1.users.owner);
				// first test migrating a few entries using random extra invalid Ids!
				const tx = await TribeoneBridgeToOptimism.depositAndMigrateEscrow(
					depositAmount,
					escrowEntriesData.userEntryBatch
				);
				depositAndMigrateEscrowReceipt = await tx.wait();
			});

			it('should update the L1 escrow state', async () => {
				postParametersL1 = await retrieveEscrowParameters({ ctx: ctx.l1 });

				assert.bnEqual(postParametersL1.escrowedBalance, initialParametersL1.escrowedBalance);

				assert.bnEqual(
					postParametersL1.userNumVestingEntries,
					initialParametersL1.userNumVestingEntries.add(totalEntriesCreated)
				);

				assert.bnEqual(postParametersL1.escrowedBalance, initialParametersL1.escrowedBalance);
				assert.bnEqual(
					postParametersL1.userEscrowedBalance,
					initialParametersL1.userEscrowedBalance
				);

				assert.bnEqual(
					postParametersL1.userVestedAccountBalance,
					initialParametersL1.userVestedAccountBalance
				);
			});

			it('should update the L1 Tribeone state', async () => {
				({ Tribeone } = ctx.l1.contracts);
				user = ctx.l1.users.owner;

				assert.bnEqual(
					await Tribeone.balanceOf(user.address),
					initialUserL1Balance.sub(depositAmount).sub(escrowEntriesData.totalEscrowed)
				);
			});

			// --------------------------
			// Wait...
			// --------------------------

			describe('when the escrow gets picked up in L2', () => {
				before('listen for completion', async () => {
					await finalizationOnL2({
						ctx,
						transactionHash: depositAndMigrateEscrowReceipt.transactionHash,
					});
				});

				it('should update the L2 escrow state', async () => {
					const postParametersL2 = await retrieveEscrowParameters({ ctx: ctx.l2 });
					assert.bnEqual(
						postParametersL2.escrowedBalance,
						initialParametersL2.escrowedBalance.add(escrowEntriesData.totalEscrowed)
					);
					assert.bnEqual(
						postParametersL2.userNumVestingEntries,
						initialParametersL2.userNumVestingEntries.add(totalEntriesCreated)
					);
					assert.bnEqual(
						postParametersL2.userEscrowedBalance,
						initialParametersL2.userEscrowedBalance.add(escrowEntriesData.totalEscrowed)
					);
					assert.bnEqual(
						postParametersL2.userVestedAccountBalance,
						initialParametersL2.userVestedAccountBalance
					);
				});

				it('should update the L2 Tribeone state', async () => {
					({ Tribeone, RewardEscrowV2 } = ctx.l2.contracts);

					user = ctx.l2.users.owner;

					assert.bnEqual(await Tribeone.balanceOf(user.address), userBalanceL2.add(depositAmount));

					assert.bnEqual(
						await Tribeone.balanceOf(RewardEscrowV2.address),
						rewardEscrowBalanceL2.add(escrowEntriesData.totalEscrowed)
					);
					assert.bnEqual(
						await Tribeone.totalSupply(),
						totalSupplyL2.add(escrowEntriesData.totalEscrowed).add(depositAmount)
					);
				});
			});
		});
	});
});
