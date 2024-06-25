'use strict';

const { contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupContract } = require('./setup');

const { toUnit } = require('../utils')();

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const ethers = require('ethers');

contract('RwaoneDebtShare', async accounts => {
	const [owner, issuer, account1, account2] = accounts;

	let addressResolver, rwaoneDebtShare;

	before(async () => {
		addressResolver = await setupContract({
			accounts,
			args: [owner],
			contract: 'AddressResolver',
		});

		rwaoneDebtShare = await setupContract({
			accounts,
			args: [owner, addressResolver.address],
			contract: 'RwaoneDebtShare',
		});

		await addressResolver.importAddresses([toBytes32('Issuer')], [issuer], { from: owner });
		await rwaoneDebtShare.rebuildCache();
		await rwaoneDebtShare.addAuthorizedBroker(owner);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: rwaoneDebtShare.abi,
			ignoreParents: ['Owned'],
			expected: [
				'mintShare',
				'burnShare',
				'transferFrom',
				'importAddresses',
				'takeSnapshot',
				'addAuthorizedBroker',
				'removeAuthorizedBroker',
				'addAuthorizedToSnapshot',
				'removeAuthorizedToSnapshot',
				'finishSetup',
				'rebuildCache',
			],
		});
	});
	it('should set constructor params on deployment', async () => {
		const instance = await setupContract({
			accounts,
			contract: 'RwaoneDebtShare',
			args: [owner, addressResolver.address],
		});

		assert.equal(await instance.owner(), owner);
	});

	describe('mintShare()', () => {
		it('should disallow another from minting', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.mintShare,
				args: [account2, toUnit('0.1')],
				accounts,
				address: issuer,
				skipPassCheck: true,
				reason: 'RwaoneDebtShare: only issuer can mint/burn',
			});
		});

		it('mints', async () => {
			await rwaoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('10'));
		});

		it('mints twice on the same period', async () => {
			await rwaoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('10'));

			await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('30'));
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('30'));
		});

		it('more than one person can mint', async () => {
			await rwaoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('10'));

			await rwaoneDebtShare.mintShare(account2, toUnit('20'), { from: issuer });

			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('30'));
		});

		describe('on new period', async () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });
				await rwaoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
			});

			it('mints', async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('30'));
				assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('30'));
			});

			describe('on another new period', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
					await rwaoneDebtShare.takeSnapshot(toUnit('50'), { from: issuer });
				});

				it('previous period is preserved', async () => {
					assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('30'));

					await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

					assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('50'));

					assert.bnEqual(
						await rwaoneDebtShare.balanceOfOnPeriod(account1, toUnit('10')),
						toUnit('30')
					);
					assert.bnEqual(await rwaoneDebtShare.totalSupplyOnPeriod(toUnit('10')), toUnit('30'));
				});
			});
		});
	});

	describe('burnShare()', () => {
		it('should disallow another from burning', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.mintShare,
				args: [account2, toUnit('0.1')],
				address: issuer,
				accounts,
				reason: 'RwaoneDebtShare: only issuer can mint/burn',
			});
		});

		describe('when account already has shares minted', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('50'), { from: issuer });
				await rwaoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
			});

			it('cannot burn more shares than the account has', async () => {
				await assert.revert(
					rwaoneDebtShare.burnShare(account1, toUnit('60'), { from: issuer }),
					'SafeMath: subtraction overflow'
				);
			});

			it('burns', async () => {
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('50'));
				await rwaoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });

				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('30'));
				assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('30'));
			});

			describe('on another new period', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });
					await rwaoneDebtShare.takeSnapshot(toUnit('50'), { from: issuer });
				});

				it('previous period is preserved', async () => {
					await rwaoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });

					assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('10'));

					assert.bnEqual(
						await rwaoneDebtShare.balanceOfOnPeriod(account1, toUnit('10')),
						toUnit('30')
					);
					assert.bnEqual(await rwaoneDebtShare.totalSupplyOnPeriod(toUnit('10')), toUnit('30'));
				});
			});
		});
	});

	describe('takeSnapshot()', () => {
		it('is only invokable by issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.takeSnapshot,
				args: [toUnit('10')],
				address: issuer,
				accounts,
				reason: 'RwaoneDebtShare: not authorized to snapshot',
			});
		});

		describe('when authorized to snapshot address is set', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.addAuthorizedToSnapshot(account1);
			});

			it('becomes invokable by authorized snapshotter', async () => {
				await rwaoneDebtShare.takeSnapshot(toUnit('10'), { from: account1 });
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
				await rwaoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
				await rwaoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
			});

			it('sets current period id', async () => {
				assert.bnEqual(await rwaoneDebtShare.currentPeriodId(), toUnit('10'));
			});

			it('rolls totalSupply', async () => {
				assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('2'));
				assert.bnEqual(await rwaoneDebtShare.totalSupplyOnPeriod(1), toUnit('1'));
			});

			it('prohibits lower period IDs in the future', async () => {
				await assert.revert(rwaoneDebtShare.takeSnapshot(toUnit('5')));
				await assert.revert(rwaoneDebtShare.takeSnapshot(toUnit('10')));
			});
		});
	});

	describe('authorized broker functions', () => {
		it('only owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.addAuthorizedBroker,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.removeAuthorizedBroker,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.addAuthorizedBroker(account1, { from: owner });
			});

			it('sets broker', async () => {
				assert.bnEqual(await rwaoneDebtShare.authorizedBrokers(account1), true);
			});

			describe('when broker is removed', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.removeAuthorizedBroker(account1, { from: owner });
				});

				it('sets broker', async () => {
					assert.bnEqual(await rwaoneDebtShare.authorizedBrokers(account1), false);
				});
			});
		});
	});

	describe('authorized to snapshot functions', () => {
		it('only owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.addAuthorizedToSnapshot,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.removeAuthorizedToSnapshot,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.addAuthorizedToSnapshot(account1, { from: owner });
			});

			it('sets authorization', async () => {
				assert.bnEqual(await rwaoneDebtShare.authorizedToSnapshot(account1), true);
			});

			describe('when broker is removed', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.removeAuthorizedToSnapshot(account1, { from: owner });
				});

				it('sets authorization', async () => {
					assert.bnEqual(await rwaoneDebtShare.authorizedToSnapshot(account1), false);
				});
			});
		});
	});

	describe('transfer()', () => {
		it('should always fail', async () => {
			await assert.revert(
				rwaoneDebtShare.transfer(account2, toUnit('0.1')),
				'debt shares are not transferrable'
			);
		});
	});

	describe('approve()', () => {
		it('should always fail', async () => {
			await assert.revert(
				rwaoneDebtShare.approve(account2, toUnit('0.1')),
				'debt shares are not transferrable'
			);
		});
	});

	describe('transferFrom()', () => {
		describe('when account has some debt shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('100'), { from: issuer });
			});

			it('only allows authorized brokers to transferFrom', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: rwaoneDebtShare.transferFrom,
					address: owner,
					args: [account1, account2, toUnit('0.1')],
					accounts,
					reason: 'RwaoneDebtShare: only brokers can transferFrom',
				});
			});

			it('fails transfer if exceeds balance', async () => {
				await assert.revert(rwaoneDebtShare.transferFrom(account1, account2, toUnit('200')), '');
			});

			it('transfers', async () => {
				await rwaoneDebtShare.transferFrom(account1, account2, toUnit('100'));

				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('0'));
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account2), toUnit('100'));
			});
		});
	});

	describe('allowance()', () => {
		it('returns 0 for non-brokers', async () => {
			assert.bnEqual(await rwaoneDebtShare.allowance(account1, account1), toUnit('0'));
		});

		it('returns MAX_UINT for brokers', async () => {
			assert.bnNotEqual(await rwaoneDebtShare.allowance(owner, owner), toUnit('0'));
		});
	});

	describe('balanceOf()', () => {
		it('returns 0 balance initially', async () => {
			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await rwaoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct balances', async () => {
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('20'));
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account2), toUnit('80'));
			});
		});
	});

	describe('totalSupply()', () => {
		it('returns 0 balance initially', async () => {
			assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await rwaoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct totalSupply', async () => {
				assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('100'));
			});
		});
	});

	describe('balanceOfOnPeriod()', () => {
		addSnapshotBeforeRestoreAfterEach();

		it('returns 0 balance initially', async () => {
			assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await rwaoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages for current period', async () => {
				assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
				assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
			});

			describe('when period changes', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.takeSnapshot(toUnit('100'), { from: issuer });
				});

				it('returns correct percentages for last period', async () => {
					assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
					assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
				});

				it('returns correct percentages for current period', async () => {
					assert.bnEqual(
						await rwaoneDebtShare.balanceOfOnPeriod(account1, toUnit('100')),
						toUnit('20')
					);
					assert.bnEqual(
						await rwaoneDebtShare.balanceOfOnPeriod(account2, toUnit('100')),
						toUnit('80')
					);
				});

				describe('when balance changes on new period', () => {
					beforeEach(async () => {
						await rwaoneDebtShare.mintShare(account1, toUnit('40'), { from: issuer });
					});

					it('returns correct percentages for last period', async () => {
						assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
						assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
					});

					it('returns correct percentages for current period', async () => {
						assert.bnEqual(
							await rwaoneDebtShare.balanceOfOnPeriod(account1, toUnit('100')),
							toUnit('60')
						);
						assert.bnEqual(
							await rwaoneDebtShare.balanceOfOnPeriod(account2, toUnit('100')),
							toUnit('80')
						);
					});

					it('still remembers 0 balance before first mint', async () => {
						assert.bnEqual(await rwaoneDebtShare.balanceOfOnPeriod(account2, 0), 0);
					});
				});
			});
		});

		describe('when there is long period history', () => {
			beforeEach(async () => {
				// one account changes balance every period
				for (let i = 1; i < 100; i++) {
					await rwaoneDebtShare.takeSnapshot(toUnit(i.toString()), { from: issuer });
					await rwaoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
				}
			});

			it('has correct latest balance', async () => {
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('99'));
			});

			it('has balance from a couple periods ago', async () => {
				assert.bnEqual(
					await rwaoneDebtShare.balanceOfOnPeriod(account1, toUnit('95')),
					toUnit('95')
				);
			});

			it('reverts on oldest period', async () => {
				await assert.revert(
					rwaoneDebtShare.balanceOfOnPeriod(account1, 10),
					'RwaoneDebtShare: not found in recent history'
				);
			});
		});
	});

	describe('sharePercent()', () => {
		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await rwaoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages', async () => {
				assert.bnEqual(await rwaoneDebtShare.sharePercent(account1), toUnit('0.2'));
				assert.bnEqual(await rwaoneDebtShare.sharePercent(account2), toUnit('0.8'));
			});
		});
	});

	describe('sharePercentOnPeriod()', () => {
		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await rwaoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages for current period', async () => {
				assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
				assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
			});

			describe('when period changes', () => {
				beforeEach(async () => {
					await rwaoneDebtShare.takeSnapshot(toUnit('100'), { from: issuer });
				});

				it('returns correct percentages for last period', async () => {
					assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
					assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
				});

				it('returns correct percentages for current period', async () => {
					assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
					assert.bnEqual(await rwaoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
				});

				describe('when balance changes on new period', () => {
					beforeEach(async () => {
						await rwaoneDebtShare.mintShare(account1, toUnit('100'), { from: issuer });
					});

					it('returns correct percentages for last period', async () => {
						assert.bnEqual(
							await rwaoneDebtShare.sharePercentOnPeriod(account1, 1),
							toUnit('0.2')
						);
						assert.bnEqual(
							await rwaoneDebtShare.sharePercentOnPeriod(account2, 1),
							toUnit('0.8')
						);
					});

					it('returns correct percentages for current period', async () => {
						assert.bnEqual(
							await rwaoneDebtShare.sharePercentOnPeriod(account1, toUnit('100')),
							toUnit('0.6')
						);
						assert.bnEqual(
							await rwaoneDebtShare.sharePercentOnPeriod(account2, toUnit('100')),
							toUnit('0.4')
						);
					});
				});
			});
		});
	});

	describe('importAddresses()', () => {
		it('should disallow import outside of owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.importAddresses,
				args: [[account2], [toUnit('0.1')]],
				accounts,
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when invoked by owner', () => {
			let txn1, txn2;

			beforeEach(async () => {
				txn1 = await rwaoneDebtShare.importAddresses([account1], [toUnit('20')], {
					from: owner,
				});
				await rwaoneDebtShare.importAddresses([account2, issuer], [toUnit('10'), toUnit('10')], {
					from: owner,
				});
				await rwaoneDebtShare.importAddresses([account2], [toUnit('50')], { from: owner });
				txn2 = await rwaoneDebtShare.importAddresses([account2], [toUnit('30')], {
					from: owner,
				});
			});

			it('sets total supply', async () => {
				assert.bnEqual(await rwaoneDebtShare.totalSupply(), toUnit('60'));
			});

			it('sets balances balances', async () => {
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account1), toUnit('20'));
				assert.bnEqual(await rwaoneDebtShare.balanceOf(account2), toUnit('30'));
				assert.bnEqual(await rwaoneDebtShare.balanceOf(issuer), toUnit('10'));
			});

			it('emits events', async () => {
				assert.eventEqual(txn1.logs[0], 'Mint', [account1, toUnit('20')]);
				assert.eventEqual(txn1.logs[1], 'Transfer', [
					ethers.constants.AddressZero,
					account1,
					toUnit('20'),
				]);

				assert.eventEqual(txn2.logs[0], 'Burn', [account2, toUnit('20')]);
			});
		});
	});

	describe('finishSetup()', () => {
		it('should disallow another from minting', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: rwaoneDebtShare.finishSetup,
				args: [],
				accounts,
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when invoked by owner', () => {
			beforeEach(async () => {
				await rwaoneDebtShare.finishSetup({ from: owner });
			});

			it('becomes initialized', async () => {
				assert.isTrue(await rwaoneDebtShare.isInitialized());
			});
		});
	});
});
