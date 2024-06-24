const ethers = require('ethers');
const chalk = require('chalk');
const hre = require('hardhat');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { ensureBalance } = require('../utils/balances');
const { addAggregatorAndSetRate, updateCache } = require('../utils/rates');
const { finalizationOnL2, finalizationOnL1 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');
const { skipWaitingPeriod } = require('../utils/skip');
const { toBytes32 } = require('../../..');

describe('initiateTribeTransfer() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const ETH_RATE = '0.5';

	const amountToDeposit = ethers.utils.parseEther('10');

	const [rUSD, hETH] = [toBytes32('rUSD'), toBytes32('hETH')];

	let owner, ownerL2, user, userL2;
	let TriberUSD, TribehETH, RwaoneBridgeToOptimism, SystemSettings;

	let TriberUSDL2, TribehETHL2, RwaoneBridgeToBase, SystemSettingsL2, SystemStatusL2;

	let userBalance, userL2Balance;

	let depositReceipt;

	describe('when the owner sends rUSD and hETH', () => {
		before('target contracts and users', () => {
			({ TriberUSD, TribehETH, RwaoneBridgeToOptimism, SystemSettings } = ctx.l1.contracts);
			({
				TriberUSD: TriberUSDL2,
				TribehETH: TribehETHL2,
				RwaoneBridgeToBase,
				SystemSettings: SystemSettingsL2,
				SystemStatus: SystemStatusL2,
			} = ctx.l2.contracts);

			owner = ctx.l1.users.owner;
			ownerL2 = ctx.l2.users.owner;
			user = ctx.l1.users.user9;
			userL2 = ctx.l2.users.user9;
		});

		before('set system settings', async () => {
			let tx;
			tx = await SystemSettings.connect(owner).setCrossChainTribeTransferEnabled(rUSD, 1);
			await tx.wait();
			tx = await SystemSettings.connect(owner).setCrossChainTribeTransferEnabled(hETH, 1);
			await tx.wait();
			tx = await SystemSettingsL2.connect(ownerL2).setCrossChainTribeTransferEnabled(rUSD, 1);
			await tx.wait();
			tx = await SystemSettingsL2.connect(ownerL2).setCrossChainTribeTransferEnabled(hETH, 1);
			await tx.wait();
		});

		before('set rates', async () => {
			await addAggregatorAndSetRate({
				ctx: ctx.l1,
				currencyKey: hETH,
				rate: ethers.utils.parseEther(ETH_RATE),
			});

			await addAggregatorAndSetRate({
				ctx: ctx.l2,
				currencyKey: hETH,
				rate: ethers.utils.parseEther(ETH_RATE),
			});
		});

		before('suspend stuff on L2, transfer should still succeed', async () => {
			// suspending the system is a good way to simulate that no suspensions will stop a transfer from finalizing
			const tx = await SystemStatusL2.connect(ownerL2).suspendSystem(1);
			await tx.wait();
		});

		before('ensure balance', async () => {
			await ensureBalance({
				ctx: ctx.l1,
				symbol: 'hETH',
				user: user,
				balance: amountToDeposit.mul(2),
			});

			await ensureBalance({
				ctx: ctx.l1,
				symbol: 'rUSD',
				user: user,
				balance: amountToDeposit.mul(2),
			});

			await ensureBalance({
				ctx: ctx.l2,
				symbol: 'ETH',
				user: user,
				balance: ethers.utils.parseEther('0.1'),
			});

			await updateCache({ ctx: ctx.l1 });
		});

		before('record balances', async () => {
			userBalance = await TriberUSD.balanceOf(user.address);
			userL2Balance = await TriberUSDL2.balanceOf(user.address);
		});

		before('approve if needed', async () => {
			await approveIfNeeded({
				token: TribehETH,
				owner: user,
				beneficiary: RwaoneBridgeToOptimism,
				amount: amountToDeposit,
			});

			await approveIfNeeded({
				token: TriberUSD,
				owner: user,
				beneficiary: RwaoneBridgeToOptimism,
				amount: amountToDeposit,
			});
		});

		before('fast forward for settle', async () => {
			await skipWaitingPeriod({ ctx: ctx.l1 });
		});

		before('make 2 deposits', async () => {
			RwaoneBridgeToOptimism = RwaoneBridgeToOptimism.connect(user);

			const tx = await RwaoneBridgeToOptimism.initiateTribeTransfer(
				rUSD,
				user.address,
				amountToDeposit
			);
			await tx.wait();

			const tx2 = await RwaoneBridgeToOptimism.initiateTribeTransfer(
				hETH,
				user.address,
				amountToDeposit
			);
			depositReceipt = await tx2.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await TriberUSD.balanceOf(user.address);

			assert.bnEqual(newOwnerBalance, userBalance.sub(amountToDeposit));
		});

		it('records amount sent', async () => {
			// 1 ETH = 1000 USD and we sent equal amount of each. so `amountToDeposit * 1001`
			assert.bnEqual(
				await RwaoneBridgeToOptimism.tribeTransferSent(),
				amountToDeposit.add(amountToDeposit.div(2))
			);
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
					await TriberUSDL2.balanceOf(user.address),
					userL2Balance.add(amountToDeposit)
				);

				assert.bnEqual(
					await TribehETHL2.balanceOf(user.address),
					userL2Balance.add(amountToDeposit)
				);
			});

			it('records amount received', async () => {
				assert.bnEqual(
					await RwaoneBridgeToBase.tribeTransferReceived(),
					amountToDeposit.add(amountToDeposit.div(2))
				);
			});

			describe('send back to L1', () => {
				let withdrawReceipt;

				before('resume L2', async () => {
					const tx = await SystemStatusL2.connect(ownerL2).resumeSystem();
					await tx.wait();
				});

				before('transfer tribes', async () => {
					RwaoneBridgeToBase = RwaoneBridgeToBase.connect(userL2);

					const tx = await RwaoneBridgeToBase.initiateTribeTransfer(
						rUSD,
						user.address,
						amountToDeposit
					);
					withdrawReceipt = await tx.wait();
				});

				it('decreases the owner balance', async () => {
					const newBalance = await TriberUSDL2.balanceOf(user.address);

					assert.bnEqual(newBalance, userL2Balance);
				});

				describe('picked up on L1', () => {
					before('wait for deposit finalization', async function () {
						if (!hre.config.debugOptimism) {
							console.log(
								chalk.yellow.bold(
									'WARNING: Skipping until ops tool relayer is stable for L1>L2 finalizations'
								)
							);
							this.skip();
						}

						await finalizationOnL1({ ctx, transactionHash: withdrawReceipt.transactionHash });
					});

					it('increases the owner balance', async () => {
						assert.bnEqual(await TriberUSD.balanceOf(user.address), userBalance);
					});
				});
			});
		});
	});
});
