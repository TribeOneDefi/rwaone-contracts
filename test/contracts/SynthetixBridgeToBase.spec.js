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

contract('RwaoneBridgeToBase (spec tests) @ovm-skip', accounts => {
	const [, owner, user, randomAddress] = accounts;

	let mintableRwaone, tribeetixBridgeToBase, systemSettings;

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				Rwaone: mintableRwaone, // we request Rwaone instead of MintableRwaone because it is renamed in setup.js
				RwaoneBridgeToBase: tribeetixBridgeToBase,
				SystemSettings: systemSettings,
			} = await setupAllContracts({
				accounts,
				contracts: ['MintableRwaone', 'RwaoneBridgeToBase', 'SystemSettings'],
			}));
		});

		describe('when a user does not have the required balance', () => {
			it('withdraw() should fail', async () => {
				await assert.revert(
					tribeetixBridgeToBase.withdraw('1', { from: user }),
					'Not enough transferable wRWAX'
				);
			});

			it('withdrawTo() should fail', async () => {
				await assert.revert(
					tribeetixBridgeToBase.withdrawTo(randomAddress, '1', { from: user }),
					'Not enough transferable wRWAX'
				);
			});
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

		describe('when a user has the required balance', () => {
			const amountToWithdraw = 1;
			let userBalanceBefore;
			let initialSupply;

			describe('when requesting a withdrawal', () => {
				before('record user balance and initial total supply', async () => {
					userBalanceBefore = await mintableRwaone.balanceOf(owner);
					initialSupply = await mintableRwaone.totalSupply();
				});

				before('initiate a withdrawal', async () => {
					await tribeetixBridgeToBase.withdraw(amountToWithdraw, {
						from: owner,
					});
				});

				it('reduces the user balance', async () => {
					const userBalanceAfter = await mintableRwaone.balanceOf(owner);
					assert.bnEqual(userBalanceBefore.sub(toBN(amountToWithdraw)), userBalanceAfter);
				});

				it('reduces the total supply', async () => {
					const supplyAfter = await mintableRwaone.totalSupply();
					assert.bnEqual(initialSupply.sub(toBN(amountToWithdraw)), supplyAfter);
				});
			});

			describe('when requesting a withdrawal to a different address', () => {
				before('record user balance and initial total supply', async () => {
					userBalanceBefore = await mintableRwaone.balanceOf(owner);
					initialSupply = await mintableRwaone.totalSupply();
				});

				before('initiate a withdrawal', async () => {
					await tribeetixBridgeToBase.withdrawTo(randomAddress, amountToWithdraw, {
						from: owner,
					});
				});

				it('reduces the user balance', async () => {
					const userBalanceAfter = await mintableRwaone.balanceOf(owner);
					assert.bnEqual(userBalanceBefore.sub(toBN(amountToWithdraw)), userBalanceAfter);
				});

				it('reduces the total supply', async () => {
					const supplyAfter = await mintableRwaone.totalSupply();
					assert.bnEqual(initialSupply.sub(toBN(amountToWithdraw)), supplyAfter);
				});
			});
		});
	});
});
