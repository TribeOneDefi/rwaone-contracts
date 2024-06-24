const { contract, web3 } = require('hardhat');
const { assert } = require('./common');
const { setupAllContracts } = require('./setup');
const { toWei } = web3.utils;
const { toBytes32 } = require('../..');
const BN = require('bn.js');

const RWAONEETIX_TOTAL_SUPPLY = toWei('100000000');

contract('MintableRwaone (spec tests)', accounts => {
	const [, owner, tribeetixBridgeToBase, account1] = accounts;

	let mintableRwaone;
	let addressResolver;
	let rewardsDistribution;
	let rewardEscrow;
	describe('when system is setup', () => {
		before('deploy a new instance', async () => {
			({
				Rwaone: mintableRwaone, // we request Rwaone instead of MintableRwaone because it is renamed in setup.js
				AddressResolver: addressResolver,
				RewardsDistribution: rewardsDistribution,
				RewardEscrowV2: rewardEscrow,
			} = await setupAllContracts({
				accounts,
				contracts: [
					'AddressResolver',
					'MintableRwaone',
					'RewardsDistribution',
					'RewardEscrowV2',
				],
			}));
			// update resolver
			await addressResolver.importAddresses(
				[toBytes32('RwaoneBridgeToBase')],
				[tribeetixBridgeToBase],
				{
					from: owner,
				}
			);
			// sync cache
			await mintableRwaone.rebuildCache();
		});

		describe('mintSecondary()', async () => {
			let mintSecondaryTx;
			const amount = 100;
			before('when RwaoneBridgeToBase calls mintSecondary()', async () => {
				mintSecondaryTx = await mintableRwaone.mintSecondary(account1, amount, {
					from: tribeetixBridgeToBase,
				});
			});

			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableRwaone.balanceOf(account1), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = new BN(RWAONEETIX_TOTAL_SUPPLY).add(new BN(amount));
				assert.bnEqual(await mintableRwaone.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryTx, 'Transfer', {
					from: mintableRwaone.address,
					to: account1,
					value: amount,
				});
			});
		});

		describe('mintSecondaryRewards()', async () => {
			let mintSecondaryRewardsTx;
			const amount = 100;
			let currentSupply;
			before('record current supply', async () => {
				currentSupply = await mintableRwaone.totalSupply();
			});

			before('when RwaoneBridgeToBase calls mintSecondaryRewards()', async () => {
				mintSecondaryRewardsTx = await mintableRwaone.mintSecondaryRewards(amount, {
					from: tribeetixBridgeToBase,
				});
			});

			it('should tranfer the tokens initially to RewardsDistribution which  transfers them to RewardEscrowV2 (no distributions)', async () => {
				assert.equal(await mintableRwaone.balanceOf(rewardsDistribution.address), 0);
				assert.equal(await mintableRwaone.balanceOf(rewardEscrow.address), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = currentSupply.add(new BN(amount));
				assert.bnEqual(await mintableRwaone.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryRewardsTx, 'Transfer', {
					from: mintableRwaone.address,
					to: rewardsDistribution.address,
					value: amount,
				});
			});
		});

		describe('burnSecondary()', async () => {
			let burnSecondaryTx;
			const amount = 100;
			let currentSupply;
			before('record current supply', async () => {
				currentSupply = await mintableRwaone.totalSupply();
			});

			before('when RwaoneBridgeToBase calls burnSecondary()', async () => {
				burnSecondaryTx = await mintableRwaone.burnSecondary(account1, amount, {
					from: tribeetixBridgeToBase,
				});
			});
			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableRwaone.balanceOf(account1), 0);
			});

			it('should decrease the total supply', async () => {
				const newSupply = currentSupply.sub(new BN(amount));
				assert.bnEqual(await mintableRwaone.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(burnSecondaryTx, 'Transfer', {
					from: account1,
					to: '0x0000000000000000000000000000000000000000',
					value: amount,
				});
			});
		});
	});
});
