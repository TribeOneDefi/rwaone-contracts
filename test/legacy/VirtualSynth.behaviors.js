'use strict';

const { artifacts } = require('hardhat');

const { toBytes32 } = require('../..');

const { prepareSmocks } = require('../contracts/helpers');

const VirtualTribe = artifacts.require('VirtualTribe');

// note: cannot use fat-arrow here otherwise this function will be bound to this outer context
module.exports = function ({ accounts }) {
	beforeEach(async () => {
		({ mocks: this.mocks, resolver: this.resolver } = await prepareSmocks({
			owner: accounts[1],
			contracts: ['Tribe', 'Exchanger'],
			accounts: accounts.slice(10), // mock using accounts after the first few
		}));
	});

	return {
		// note: use fat-arrow to persist context rather
		whenInstantiated: ({ amount, user, tribe = 'rETH' }, cb) => {
			describe(`when instantiated for user ${user.slice(0, 7)}`, () => {
				beforeEach(async () => {
					this.instance = await VirtualTribe.new();
					await this.instance.initialize(
						this.mocks.Tribe.address,
						this.resolver.address,
						user,
						amount,
						toBytes32(tribe)
					);
				});
				cb();
			});
		},
		whenMockedTribeBalance: ({ balanceOf }, cb) => {
			describe(`when the tribe has been mocked to show balance for the vTribe as ${balanceOf}`, () => {
				beforeEach(async () => {
					this.mocks.Tribe.balanceOf.returns(acc =>
						acc === this.instance.address ? balanceOf : '0'
					);
				});
				cb();
			});
		},
		whenUserTransfersAwayTokens: ({ amount, from, to }, cb) => {
			describe(`when the user transfers away ${amount} of their vTribes`, () => {
				beforeEach(async () => {
					await this.instance.transfer(to || this.instance.address, amount.toString(), {
						from,
					});
				});
				cb();
			});
		},
		whenMockedSettlementOwing: ({ reclaim = 0, rebate = 0, numEntries = 1 }, cb) => {
			describe(`when settlement owing shows a ${reclaim} reclaim, ${rebate} rebate and ${numEntries} numEntries`, () => {
				beforeEach(async () => {
					this.mocks.Exchanger.settlementOwing.returns([reclaim, rebate, numEntries]);
				});
				cb();
			});
		},
		whenSettlementCalled: ({ user }, cb) => {
			describe(`when settlement is invoked for user ${user.slice(0, 7)}`, () => {
				beforeEach(async () => {
					// here we simulate how a settlement works with respect to a user's balance
					// Note: this does not account for multiple users - it settles for any account given the exact same way

					const [reclaim, rebate, numEntries] = this.mocks.Exchanger.settlementOwing.returns
						.returnValue || [0, 0, 1];

					// now show the balanceOf the vTribe shows the amount after settlement
					let balanceOf = +this.mocks.Tribe.balanceOf.returns(this.instance.address);

					this.mocks.Exchanger.settle.returns(() => {
						// update the balanceOf the underlying tribe due to settlement
						balanceOf = reclaim > 0 ? balanceOf - reclaim : balanceOf + rebate;
						// ensure settlementOwing now shows nothing
						this.mocks.Exchanger.settlementOwing.returns([0, 0, 0]);
						// return what was settled
						return [reclaim, rebate, numEntries];
					});

					this.mocks.Tribe.transfer.returns((to, amount) => {
						// ensure the vTribes settlement reduces how much balance
						balanceOf = balanceOf - amount;
						return true;
					});

					// use a closure to ensure the balance returned at time of request is the updated one
					this.mocks.Tribe.balanceOf.returns(() => balanceOf);

					this.txn = await this.instance.settle(user);
				});
				cb();
			});
		},
		whenMockedWithMaxSecsLeft: ({ maxSecsLeft = '0' }, cb) => {
			describe(`when mocked with ${maxSecsLeft} for settlement `, () => {
				beforeEach(async () => {
					this.mocks.Exchanger.maxSecsLeftInWaitingPeriod.returns(maxSecsLeft.toString());
				});
				cb();
			});
		},
	};
};
