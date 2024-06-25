const { artifacts, contract, web3 } = require('hardhat');
const { assert } = require('./common');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { toWei } = web3.utils;
const { toBytes32 } = require('../..');
const BN = require('bn.js');
const { smock } = require('@defi-wonderland/smock');

const MintableRwaone = artifacts.require('MintableRwaone');

contract('MintableRwaone (unit tests)', accounts => {
	const [owner, rwaoneBridgeToBase, user1, mockAddress] = accounts;

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: MintableRwaone.abi,
			ignoreParents: ['BaseRwaone'],
			expected: [],
		});
	});

	describe('initial setup, smock all deps', () => {
		let resolver;
		let tokenState;
		let proxy;
		let rewardsDistribution;
		let systemStatus;
		let rewardEscrowV2;
		const RWAONE_TOTAL_SUPPLY = toWei('100000000');

		beforeEach(async () => {
			tokenState = await smock.fake('TokenState');
			proxy = await smock.fake('Proxy');
			rewardsDistribution = await smock.fake('IRewardsDistribution');
			resolver = await artifacts.require('AddressResolver').new(owner);
			systemStatus = await artifacts.require('SystemStatus').new(owner);
			rewardEscrowV2 = await smock.fake('IRewardEscrowV2');
			await resolver.importAddresses(
				[
					'RwaoneBridgeToBase',
					'SystemStatus',
					'Exchanger',
					'Issuer',
					'SupplySchedule',
					'Liquidator',
					'LiquidatorRewards',
					'RewardsDistribution',
					'RewardEscrowV2',
				].map(toBytes32),
				[
					rwaoneBridgeToBase,
					systemStatus.address,
					mockAddress,
					mockAddress,
					mockAddress,
					mockAddress,
					mockAddress,
					rewardsDistribution.address,
					rewardEscrowV2.address,
				],
				{ from: owner }
			);
		});

		beforeEach(async () => {
			// stubs
			tokenState.setBalanceOf.returns(() => { });
			tokenState.balanceOf.returns(() => web3.utils.toWei('1'));
			proxy._emit.returns(() => { });
			rewardsDistribution.distributeRewards.returns(() => true);
		});

		describe('when the target is deployed', () => {
			let instance;
			beforeEach(async () => {
				instance = await artifacts
					.require('MintableRwaone')
					.new(proxy.address, tokenState.address, owner, RWAONE_TOTAL_SUPPLY, resolver.address);
				await instance.rebuildCache();
			});

			it('should set constructor params on deployment', async () => {
				assert.equal(await instance.proxy(), proxy.address);
				assert.equal(await instance.tokenState(), tokenState.address);
				assert.equal(await instance.owner(), owner);
				assert.equal(await instance.totalSupply(), RWAONE_TOTAL_SUPPLY);
				assert.equal(await instance.resolver(), resolver.address);
			});

			describe('mintSecondary()', async () => {
				describe('failure modes', () => {
					it('should only allow RwaoneBridgeToBase to call mintSecondary()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.mintSecondary,
							args: [user1, 100],
							address: rwaoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});

				describe('when invoked by the bridge', () => {
					const amount = 100;
					beforeEach(async () => {
						await instance.mintSecondary(user1, amount, {
							from: rwaoneBridgeToBase,
						});
					});

					it('should increase the total supply', async () => {
						const newSupply = new BN(RWAONE_TOTAL_SUPPLY).add(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});

			describe('mintSecondaryRewards()', async () => {
				const amount = 100;
				describe('failure modes', () => {
					it('should only allow RwaoneBridgeToBase to call mintSecondaryRewards()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.mintSecondaryRewards,
							args: [amount],
							address: rwaoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});

				describe('when invoked by the bridge', () => {
					beforeEach(async () => {
						await instance.mintSecondaryRewards(amount, {
							from: rwaoneBridgeToBase,
						});
					});

					it('should increase the total supply', async () => {
						const newSupply = new BN(RWAONE_TOTAL_SUPPLY).add(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});

			describe('burnSecondary()', async () => {
				const amount = 100;
				describe('failure modes', () => {
					it('should only allow RwaoneBridgeToBase to call burnSecondary()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.burnSecondary,
							args: [user1, amount],
							address: rwaoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});
				describe('when invoked by the bridge', () => {
					beforeEach(async () => {
						await instance.burnSecondary(user1, amount, {
							from: rwaoneBridgeToBase,
						});
					});

					it('should decrease the total supply', async () => {
						const newSupply = new BN(RWAONE_TOTAL_SUPPLY).sub(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});
		});
	});
});
