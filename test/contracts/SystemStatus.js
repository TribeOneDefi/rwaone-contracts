'use strict';

const { artifacts, contract } = require('hardhat');

const { assert } = require('./common');

const SystemStatus = artifacts.require('SystemStatus');

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { toBytes32 } = require('../..');

contract('SystemStatus', async accounts => {
	const [SYSTEM, ISSUANCE, EXCHANGE, RWAONE_EXCHANGE, TRIBE, FUTURES] = [
		'System',
		'Issuance',
		'Exchange',
		'TribeExchange',
		'Tribe',
		'Futures',
	].map(toBytes32);

	const [, owner, account1, account2, account3] = accounts;

	let SUSPENSION_REASON_UPGRADE;
	let systemStatus;

	beforeEach(async () => {
		systemStatus = await SystemStatus.new(owner);
		SUSPENSION_REASON_UPGRADE = (await systemStatus.SUSPENSION_REASON_UPGRADE()).toString();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: systemStatus.abi,
			ignoreParents: ['Owned'],
			expected: [
				'resumeExchange',
				'resumeFutures',
				'resumeIssuance',
				'resumeTribe',
				'resumeTribes',
				'resumeTribeExchange',
				'resumeTribesExchange',
				'resumeFuturesMarket',
				'resumeFuturesMarkets',
				'resumeSystem',
				'suspendExchange',
				'suspendFutures',
				'suspendIssuance',
				'suspendTribe',
				'suspendTribes',
				'suspendTribeExchange',
				'suspendTribesExchange',
				'suspendFuturesMarket',
				'suspendFuturesMarkets',
				'suspendSystem',
				'updateAccessControl',
				'updateAccessControls',
			],
		});
	});

	it('not even the owner can suspend', async () => {
		await assert.revert(
			systemStatus.suspendSystem('1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendIssuance('1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendExchange('1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendFutures('1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendTribeExchange(toBytes32('rETH'), '1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendTribe(toBytes32('rETH'), '1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendFuturesMarket(toBytes32('rETH'), '1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendFuturesMarkets([toBytes32('rETH')], '1', { from: owner }),
			'Restricted to access control list'
		);
	});

	describe('when the owner is given access to suspend and resume everything', () => {
		beforeEach(async () => {
			await systemStatus.updateAccessControls(
				[SYSTEM, ISSUANCE, EXCHANGE, RWAONE_EXCHANGE, TRIBE, FUTURES],
				[owner, owner, owner, owner, owner, owner],
				[true, true, true, true, true, true],
				[true, true, true, true, true, true],
				{ from: owner }
			);
		});
		describe('suspendSystem()', () => {
			let txn;

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.systemSuspension();
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('and all the require checks succeed', async () => {
				await systemStatus.requireSystemActive();
				await systemStatus.requireIssuanceActive();
				await systemStatus.requireExchangeActive();
				await systemStatus.requireFuturesActive();
				await systemStatus.requireTribeActive(toBytes32('rETH'));
				await systemStatus.requireTribesActive(toBytes32('hBTC'), toBytes32('rETH'));
				await systemStatus.requireFuturesMarketActive(toBytes32('hBTC'));
			});

			it('and all the bool views are correct', async () => {
				assert.isFalse(await systemStatus.systemSuspended());
				assert.isFalse(await systemStatus.tribeSuspended(toBytes32('rETH')));
				assert.isFalse(await systemStatus.tribeSuspended(toBytes32('hBTC')));
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendSystem,
					accounts,
					address: owner,
					args: ['0'],
					reason: 'Restricted to access control list',
				});
			});
			it('by default isSystemUpgrading() is false', async () => {
				const isSystemUpgrading = await systemStatus.isSystemUpgrading();
				assert.equal(isSystemUpgrading, false);
			});

			describe('when the owner suspends', () => {
				let givenReason;
				beforeEach(async () => {
					givenReason = '3';
					txn = await systemStatus.suspendSystem(givenReason, { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.systemSuspension();
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
				});
				it('and isSystemUpgrading() is false', async () => {
					const isSystemUpgrading = await systemStatus.isSystemUpgrading();
					assert.equal(isSystemUpgrading, false);
				});
				it('and emits the expected event', async () => {
					assert.eventEqual(txn, 'SystemSuspended', [givenReason]);
				});
				it('and the require checks all revert as expected', async () => {
					const reason = 'Rwaone is suspended. Operation prohibited';
					await assert.revert(systemStatus.requireSystemActive(), reason);
					await assert.revert(systemStatus.requireIssuanceActive(), reason);
					await assert.revert(systemStatus.requireFuturesActive(), reason);
					await assert.revert(systemStatus.requireTribeActive(toBytes32('rETH')), reason);
					await assert.revert(systemStatus.requireFuturesMarketActive(toBytes32('rETH')), reason);
					await assert.revert(
						systemStatus.requireTribesActive(toBytes32('hBTC'), toBytes32('rETH')),
						reason
					);
				});

				it('and all the bool views are correct', async () => {
					assert.isTrue(await systemStatus.systemSuspended());
					assert.isTrue(await systemStatus.tribeSuspended(toBytes32('rETH')));
					assert.isTrue(await systemStatus.tribeSuspended(toBytes32('hBTC')));
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(SYSTEM, account1, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(systemStatus.suspendSystem('0', { from: account2 }));
					await assert.revert(
						systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account3 })
					);
				});

				describe('and that address invokes suspend with upgrading', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account1 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.systemSuspension();
						assert.equal(suspended, true);
						assert.equal(reason, SUSPENSION_REASON_UPGRADE);
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'SystemSuspended', [SUSPENSION_REASON_UPGRADE]);
					});
					it('and isSystemUpgrading() is true', async () => {
						const isSystemUpgrading = await systemStatus.isSystemUpgrading();
						assert.equal(isSystemUpgrading, true);
					});
					it('and the require checks all revert with system upgrading, as expected', async () => {
						const reason = 'Rwaone is suspended, upgrade in progress... please stand by';
						await assert.revert(systemStatus.requireSystemActive(), reason);
						await assert.revert(systemStatus.requireIssuanceActive(), reason);
						await assert.revert(systemStatus.requireFuturesActive(), reason);
						await assert.revert(systemStatus.requireTribeActive(toBytes32('rETH')), reason);
						await assert.revert(systemStatus.requireFuturesMarketActive(toBytes32('rETH')), reason);
						await assert.revert(
							systemStatus.requireTribesActive(toBytes32('hBTC'), toBytes32('rETH')),
							reason
						);
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeSystem({ from: account1 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account2, true, true, { from: account1 })
						);
						await assert.revert(systemStatus.suspendIssuance('0', { from: account1 }));
						await assert.revert(systemStatus.resumeIssuance({ from: account1 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '0', { from: account1 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '0', { from: account1 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarkets([toBytes32('rETH')], '0', { from: account1 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account1 }));
						await assert.revert(
							systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account1 })
						);
						await assert.revert(
							systemStatus.resumeFuturesMarkets([toBytes32('rETH')], { from: account1 })
						);
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeSystem({ from: owner });
					});
				});
			});
		});

		describe('resumeSystem()', () => {
			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeSystem,
					accounts,
					address: owner,
					args: [],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends within the upgrading flag', () => {
				beforeEach(async () => {
					await systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(SYSTEM, account1, false, true, { from: owner });
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeSystem({ from: account2 }),
							'Restricted to access control list'
						);
						await assert.revert(
							systemStatus.resumeSystem({ from: account3 }),
							'Restricted to access control list'
						);
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeSystem({ from: account1 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.systemSuspension();
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event with the upgrading flag', async () => {
							assert.eventEqual(txn, 'SystemResumed', [SUSPENSION_REASON_UPGRADE]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireTribeActive(toBytes32('rETH'));
							await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendSystem('0', { from: account1 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account2, false, true, { from: account1 })
							);
							await assert.revert(
								systemStatus.suspendIssuance(SUSPENSION_REASON_UPGRADE, { from: account1 })
							);
							await assert.revert(systemStatus.resumeIssuance({ from: account1 }));
							await assert.revert(
								systemStatus.suspendTribe(toBytes32('rETH'), '66', { from: account1 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '66', { from: account1 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarkets([toBytes32('rETH')], '66', { from: account1 })
							);
							await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account1 }));
							await assert.revert(
								systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account1 })
							);
							await assert.revert(
								systemStatus.resumeFuturesMarkets([toBytes32('rETH')], { from: account1 })
							);
						});
					});
				});
			});
		});

		describe('suspendIssuance()', () => {
			let txn;

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.issuanceSuspension();
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendIssuance,
					accounts,
					address: owner,
					args: ['0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendIssuance('5', { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.issuanceSuspension();
					assert.equal(suspended, true);
					assert.equal(reason, '5');
					assert.eventEqual(txn, 'IssuanceSuspended', ['5']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(ISSUANCE, account2, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendIssuance('1', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendIssuance('10', { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendIssuance('33', { from: account2 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.issuanceSuspension();
						assert.equal(suspended, true);
						assert.equal(reason, '33');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'IssuanceSuspended', ['33']);
					});
					it('and the issuance require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireIssuanceActive(),
							'Issuance is suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireTribeActive(toBytes32('rETH'));
						await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeIssuance({ from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account3, true, true, { from: account3 })
						);
						await assert.revert(
							systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account2 })
						);
						await assert.revert(systemStatus.resumeSystem({ from: account2 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
						await assert.revert(
							systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account2 })
						);
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeIssuance({ from: owner });
					});
				});
			});
		});

		describe('resumeIssuance()', () => {
			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeIssuance,
					accounts,
					address: owner,
					args: [],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '5';
				beforeEach(async () => {
					await systemStatus.suspendIssuance(givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(ISSUANCE, account2, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeIssuance({ from: account1 }));
						await assert.revert(systemStatus.resumeIssuance({ from: account3 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeIssuance({ from: account2 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.issuanceSuspension();
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'IssuanceResumed', [givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireTribeActive(toBytes32('rETH'));
							await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendIssuance('1', { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account3, false, true, { from: account2 })
							);
							await assert.revert(systemStatus.suspendSystem('8', { from: account2 }));
							await assert.revert(systemStatus.resumeSystem({ from: account2 }));
							await assert.revert(
								systemStatus.suspendTribe(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
							await assert.revert(
								systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account2 })
							);
						});
					});
				});
			});
		});

		describe('suspendExchange()', () => {
			let txn;

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.exchangeSuspension();
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendExchange,
					accounts,
					address: owner,
					args: ['0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendExchange('5', { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.exchangeSuspension();
					assert.equal(suspended, true);
					assert.equal(reason, '5');
					assert.eventEqual(txn, 'ExchangeSuspended', ['5']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(EXCHANGE, account2, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendExchange('1', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendExchange('10', { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendExchange('33', { from: account2 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.exchangeSuspension();
						assert.equal(suspended, true);
						assert.equal(reason, '33');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'ExchangeSuspended', ['33']);
					});
					it('and the exchange require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireExchangeActive(),
							'Exchange is suspended. Operation prohibited'
						);
					});
					it('and the futures require checks reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireFuturesActive(),
							'Exchange is suspended. Operation prohibited'
						);
						await assert.revert(
							systemStatus.requireFuturesMarketActive(toBytes32('rETH')),
							'Exchange is suspended. Operation prohibited'
						);
					});
					it('and requireExchangeBetweenTribesAllowed reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireExchangeBetweenTribesAllowed(
								toBytes32('rETH'),
								toBytes32('hBTC')
							),
							'Exchange is suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireTribeActive(toBytes32('rETH'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeExchange({ from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account3, true, true, { from: account3 })
						);
						await assert.revert(
							systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account2 })
						);
						await assert.revert(systemStatus.resumeSystem({ from: account2 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
						await assert.revert(
							systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account2 })
						);
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeExchange({ from: owner });
					});
				});
			});
		});

		describe('resumeExchange()', () => {
			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeExchange,
					accounts,
					address: owner,
					args: [],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '5';
				beforeEach(async () => {
					await systemStatus.suspendExchange(givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(EXCHANGE, account2, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeExchange({ from: account1 }));
						await assert.revert(systemStatus.resumeExchange({ from: account3 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeExchange({ from: account2 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.exchangeSuspension();
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'ExchangeResumed', [givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireExchangeActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireExchangeBetweenTribesAllowed(
								toBytes32('rETH'),
								toBytes32('hBTC')
							);
							await systemStatus.requireTribeActive(toBytes32('rETH'));
							await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendExchange('1', { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account3, false, true, { from: account2 })
							);
							await assert.revert(systemStatus.suspendSystem('8', { from: account2 }));
							await assert.revert(systemStatus.resumeSystem({ from: account2 }));
							await assert.revert(
								systemStatus.suspendTribe(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
							await assert.revert(
								systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account2 })
							);
						});
					});
				});
			});
		});

		describe('suspendTribeExchange()', () => {
			let txn;
			const hBTC = toBytes32('hBTC');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendTribeExchange,
					accounts,
					address: owner,
					args: [hBTC, '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getTribeExchangeSuspensions(rETH, hBTC, iBTC) is empty', async () => {
				const { exchangeSuspensions, reasons } = await systemStatus.getTribeExchangeSuspensions(
					['rETH', 'hBTC', 'iBTC'].map(toBytes32)
				);
				assert.deepEqual(exchangeSuspensions, [false, false, false]);
				assert.deepEqual(reasons, ['0', '0', '0']);
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendTribeExchange(hBTC, givenReason, { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn, 'TribeExchangeSuspended', [hBTC, reason]);
				});
				it('getTribeExchangeSuspensions(rETH, hBTC, iBTC) returns values for hBTC', async () => {
					const { exchangeSuspensions, reasons } = await systemStatus.getTribeExchangeSuspensions(
						['rETH', 'hBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(exchangeSuspensions, [false, true, false]);
					assert.deepEqual(reasons, ['0', givenReason, '0']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(RWAONE_EXCHANGE, account3, true, false, {
						from: owner,
					});
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendTribeExchange(hBTC, '4', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendTribeExchange(hBTC, '0', { from: account2 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendTribeExchange(hBTC, '3', { from: account3 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '3');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'TribeExchangeSuspended', [hBTC, '3']);
					});
					it('and the tribe require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireTribeExchangeActive(hBTC),
							'Tribe exchange suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireIssuanceActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireTribeActive(hBTC);
						await systemStatus.requireFuturesMarketActive(hBTC);
						await systemStatus.requireTribesActive(toBytes32('rETH'), hBTC);
					});
					it('and requireExchangeBetweenTribesAllowed() reverts if one is the given tribe', async () => {
						const reason = 'Tribe exchange suspended. Operation prohibited';
						await assert.revert(
							systemStatus.requireExchangeBetweenTribesAllowed(toBytes32('rETH'), hBTC),
							reason
						);
						await assert.revert(
							systemStatus.requireExchangeBetweenTribesAllowed(hBTC, toBytes32('sTRX')),
							reason
						);
						await systemStatus.requireExchangeBetweenTribesAllowed(
							toBytes32('rETH'),
							toBytes32('rUSD')
						); // no issues
						await systemStatus.requireExchangeBetweenTribesAllowed(
							toBytes32('iTRX'),
							toBytes32('iBTC')
						); // no issues
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeTribeExchange(hBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});

					it('yet the owner can still resume', async () => {
						await systemStatus.resumeTribeExchange(hBTC, { from: owner });
					});
				});
			});
		});

		describe('resumeTribeExchange()', () => {
			const hBTC = toBytes32('hBTC');

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeTribeExchange,
					accounts,
					address: owner,
					args: [hBTC],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendTribeExchange(hBTC, givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWAONE_EXCHANGE, account3, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeTribeExchange(hBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeTribeExchange(hBTC, { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeTribeExchange(hBTC, { from: account3 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'TribeExchangeResumed', [hBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireExchangeBetweenTribesAllowed(toBytes32('rETH'), hBTC);
							await systemStatus.requireTribeActive(hBTC);
							await systemStatus.requireFuturesMarketActive(hBTC);
							await systemStatus.requireTribesActive(hBTC, toBytes32('rETH'));
							await systemStatus.requireTribesActive(toBytes32('rETH'), hBTC);
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendTribeExchange(hBTC, givenReason, { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('getTribeExchangeSuspensions(rETH, hBTC, iBTC) is empty', async () => {
							const {
								exchangeSuspensions,
								reasons,
							} = await systemStatus.getTribeExchangeSuspensions(
								['rETH', 'hBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(exchangeSuspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('suspendTribesExchange()', () => {
			let txn;
			const [hBTC, rETH] = ['hBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendTribesExchange,
					accounts,
					address: owner,
					args: [[hBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendTribesExchange([hBTC, rETH], givenReason, {
						from: owner,
					});
				});
				it('it succeeds for BTC', async () => {
					const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[0], 'TribeExchangeSuspended', [hBTC, reason]);
				});
				it('and for ETH', async () => {
					const { suspended, reason } = await systemStatus.tribeExchangeSuspension(rETH);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[1], 'TribeExchangeSuspended', [rETH, reason]);
				});
				it('getTribeExchangeSuspensions(rETH, hBTC, iBTC) returns values for rETH and hBTC', async () => {
					const { exchangeSuspensions, reasons } = await systemStatus.getTribeExchangeSuspensions(
						['rETH', 'hBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(exchangeSuspensions, [true, true, false]);
					assert.deepEqual(reasons, [givenReason, givenReason, '0']);
				});
			});
		});

		describe('resumeTribesExchange()', () => {
			let txn;
			const [hBTC, rETH] = ['hBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeTribesExchange,
					accounts,
					address: owner,
					args: [[hBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendTribesExchange([hBTC, rETH], givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWAONE_EXCHANGE, account3, false, true, {
							from: owner,
						});
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeTribesExchange([hBTC, rETH], { from: account3 });
						});

						it('it succeeds for hBTC', async () => {
							const { suspended, reason } = await systemStatus.tribeExchangeSuspension(hBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[0], 'TribeExchangeResumed', [hBTC, givenReason]);
						});

						it('and for rETH', async () => {
							const { suspended, reason } = await systemStatus.tribeExchangeSuspension(rETH);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[1], 'TribeExchangeResumed', [rETH, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(hBTC);
							await systemStatus.requireExchangeBetweenTribesAllowed(rETH, hBTC);
							await systemStatus.requireTribesActive(hBTC, rETH);
						});
					});
				});
			});
		});

		describe('suspendFutures()', () => {
			let txn;

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.futuresSuspension();
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendFutures,
					accounts,
					address: owner,
					args: ['0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendFutures('5', { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.futuresSuspension();
					assert.equal(suspended, true);
					assert.equal(reason, '5');
					assert.eventEqual(txn, 'FuturesSuspended', ['5']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(FUTURES, account2, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendFutures('1', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendFutures('10', { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendFutures('33', { from: account2 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.futuresSuspension();
						assert.equal(suspended, true);
						assert.equal(reason, '33');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'FuturesSuspended', ['33']);
					});
					it('and the require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireFuturesActive(),
							'Futures markets are suspended. Operation prohibited'
						);
					});
					it('and the specific market require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireFuturesMarketActive(toBytes32('hBTC')),
							'Futures markets are suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireTribeActive(toBytes32('rETH'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeFutures({ from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account3, true, true, { from: account3 })
						);
						await assert.revert(
							systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account2 })
						);
						await assert.revert(systemStatus.resumeSystem({ from: account2 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeFutures({ from: owner });
					});
				});
			});
		});

		describe('resumeFutures()', () => {
			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeFutures,
					accounts,
					address: owner,
					args: [],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '5';
				beforeEach(async () => {
					await systemStatus.suspendFutures(givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(FUTURES, account2, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeFutures({ from: account1 }));
						await assert.revert(systemStatus.resumeFutures({ from: account3 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeFutures({ from: account2 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.futuresSuspension();
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'FuturesResumed', [givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(toBytes32('hBTC'));
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendFutures('1', { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account3, false, true, { from: account2 })
							);
							await assert.revert(systemStatus.suspendSystem('8', { from: account2 }));
							await assert.revert(systemStatus.resumeSystem({ from: account2 }));
							await assert.revert(
								systemStatus.suspendTribe(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
						});
					});
				});
			});
		});

		describe('suspendFuturesMarket(s)', () => {
			let txn;
			const hBTC = toBytes32('hBTC');
			const rETH = toBytes32('rETH');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.futuresMarketSuspension(hBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendFuturesMarket,
					accounts,
					address: owner,
					args: [hBTC, '0'],
					reason: 'Restricted to access control list',
				});
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendFuturesMarkets,
					accounts,
					address: owner,
					args: [[hBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getFuturesMarketSuspensions(rETH, hBTC) is empty', async () => {
				const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
					['rETH', 'hBTC'].map(toBytes32)
				);
				assert.deepEqual(suspensions, [false, false]);
				assert.deepEqual(reasons, ['0', '0']);
			});

			describe('when the owner suspends single market', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendFuturesMarket(hBTC, '5', { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.futuresMarketSuspension(hBTC);
					assert.equal(suspended, true);
					assert.equal(reason, '5');
					assert.eventEqual(txn, 'FuturesMarketSuspended', [hBTC, '5']);
				});
				it('getFuturesMarketSuspensions(rETH, hBTC) returns values for hBTC', async () => {
					const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
						['rETH', 'hBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [false, true]);
					assert.deepEqual(reasons, ['0', '5']);
				});
			});

			describe('when the owner suspends multiple markets', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendFuturesMarkets([hBTC, rETH], '5', { from: owner });
				});
				it('it succeeds', async () => {
					assert.equal((await systemStatus.futuresMarketSuspension(hBTC)).suspended, true);
					assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, true);
				});
				it('getFuturesMarketSuspensions(rETH, hBTC) returns values for both', async () => {
					const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
						['rETH', 'hBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [true, true]);
					assert.deepEqual(reasons, ['5', '5']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(FUTURES, account2, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendFuturesMarket(hBTC, '1', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendFuturesMarket(hBTC, '10', { from: account3 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendFuturesMarkets([hBTC], '10', { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend for single market', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendFuturesMarket(hBTC, '33', { from: account2 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.futuresMarketSuspension(hBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '33');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'FuturesMarketSuspended', [hBTC, '33']);
					});
					it('and the require check reverts as expected', async () => {
						await assert.revert(systemStatus.requireFuturesMarketActive(hBTC), 'Market suspended');
					});
					it('but not the other checks', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireTribeActive(toBytes32('rETH'));
					});
					it('and not other markets', async () => {
						await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeFuturesMarket(hBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account3, true, true, { from: account3 })
						);
						await assert.revert(
							systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account2 })
						);
						await assert.revert(systemStatus.resumeSystem({ from: account2 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeFutures({ from: owner });
					});
				});

				describe('and that address invokes suspend for multiple market', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendFuturesMarkets([hBTC, rETH], '33', { from: account2 });
					});
					it('it succeeds', async () => {
						assert.equal((await systemStatus.futuresMarketSuspension(hBTC)).suspended, true);
						assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, true);
					});
					it('and the require checks reverts as expected', async () => {
						await assert.revert(systemStatus.requireFuturesMarketActive(hBTC), 'Market suspended');
						await assert.revert(systemStatus.requireFuturesMarketActive(rETH), 'Market suspended');
					});
					it('but not the other checks', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireTribeActive(toBytes32('rETH'));
					});
					it('and not other markets', async () => {
						await systemStatus.requireFuturesMarketActive(toBytes32('sOTHER'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeFuturesMarket(hBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(SYSTEM, account3, true, true, { from: account3 })
						);
						await assert.revert(
							systemStatus.suspendSystem(SUSPENSION_REASON_UPGRADE, { from: account2 })
						);
						await assert.revert(systemStatus.resumeSystem({ from: account2 }));
						await assert.revert(
							systemStatus.suspendTribe(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeFutures({ from: owner });
					});
				});
			});
		});

		describe('resumeFuturesMarket(s)', () => {
			let txn;
			const hBTC = toBytes32('hBTC');
			const rETH = toBytes32('rETH');
			const sLINK = toBytes32('sLINK');

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeFuturesMarket,
					accounts,
					address: owner,
					args: [hBTC],
					reason: 'Restricted to access control list',
				});
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeFuturesMarkets,
					accounts,
					address: owner,
					args: [[hBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends multiple markets', () => {
				const givenReason = '5';
				beforeEach(async () => {
					await systemStatus.suspendFuturesMarkets([hBTC, rETH, sLINK], givenReason, {
						from: owner,
					});
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(FUTURES, account2, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeFuturesMarket(hBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeFuturesMarket(hBTC, { from: account3 }));
						await assert.revert(systemStatus.resumeFuturesMarkets([hBTC], { from: account3 }));
					});

					describe('and that address invokes resume for first market', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeFuturesMarket(hBTC, { from: account2 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.futuresMarketSuspension(hBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'FuturesMarketResumed', [hBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(hBTC);
						});

						it('but not for second market', async () => {
							await assert.revert(
								systemStatus.requireFuturesMarketActive(rETH),
								'Market suspended'
							);
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendFutures('1', { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account3, false, true, { from: account2 })
							);
							await assert.revert(systemStatus.suspendSystem('8', { from: account2 }));
							await assert.revert(systemStatus.resumeSystem({ from: account2 }));
							await assert.revert(
								systemStatus.suspendTribe(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeTribe(toBytes32('rETH'), { from: account2 }));
						});
					});

					describe('and that address invokes resume for two markets', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeFuturesMarkets([hBTC, rETH], { from: account2 });
						});

						it('it succeeds', async () => {
							assert.equal((await systemStatus.futuresMarketSuspension(hBTC)).suspended, false);
							assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, false);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(hBTC);
							await systemStatus.requireFuturesMarketActive(rETH);
						});

						it('but not for third market', async () => {
							await assert.revert(
								systemStatus.requireFuturesMarketActive(sLINK),
								'Market suspended'
							);
						});
					});
				});
			});
		});

		describe('suspendTribe()', () => {
			let txn;
			const hBTC = toBytes32('hBTC');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendTribe,
					accounts,
					address: owner,
					args: [hBTC, '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getTribeSuspensions(rETH, hBTC, iBTC) is empty', async () => {
				const { suspensions, reasons } = await systemStatus.getTribeSuspensions(
					['rETH', 'hBTC', 'iBTC'].map(toBytes32)
				);
				assert.deepEqual(suspensions, [false, false, false]);
				assert.deepEqual(reasons, ['0', '0', '0']);
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendTribe(hBTC, givenReason, { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn, 'TribeSuspended', [hBTC, reason]);
				});
				it('getTribeSuspensions(rETH, hBTC, iBTC) returns values for hBTC', async () => {
					const { suspensions, reasons } = await systemStatus.getTribeSuspensions(
						['rETH', 'hBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [false, true, false]);
					assert.deepEqual(reasons, ['0', givenReason, '0']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(TRIBE, account3, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendTribe(hBTC, '4', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendTribe(hBTC, '0', { from: account2 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendTribe(hBTC, '3', { from: account3 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '3');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'TribeSuspended', [hBTC, '3']);
					});
					it('and the tribe require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireTribeActive(hBTC),
							'Tribe is suspended. Operation prohibited'
						);
					});
					it('and the tribe bool view is as expected', async () => {
						assert.isTrue(await systemStatus.tribeSuspended(hBTC));
					});
					it('but not other tribe bool view', async () => {
						assert.isFalse(await systemStatus.tribeSuspended(toBytes32('rETH')));
					});
					it('but others do not revert', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireIssuanceActive();
					});
					it('and requireTribesActive() reverts if one is the given tribe', async () => {
						const reason = 'Tribe is suspended. Operation prohibited';
						await assert.revert(systemStatus.requireTribesActive(toBytes32('rETH'), hBTC), reason);
						await assert.revert(systemStatus.requireTribesActive(hBTC, toBytes32('sTRX')), reason);
						await systemStatus.requireTribesActive(toBytes32('rETH'), toBytes32('rUSD')); // no issues
						await systemStatus.requireTribesActive(toBytes32('iTRX'), toBytes32('iBTC')); // no issues
					});
					it('and requireExchangeBetweenTribesAllowed() reverts if one is the given tribe', async () => {
						const reason = 'Tribe is suspended. Operation prohibited';
						await assert.revert(
							systemStatus.requireExchangeBetweenTribesAllowed(toBytes32('rETH'), hBTC),
							reason
						);
						await assert.revert(
							systemStatus.requireExchangeBetweenTribesAllowed(hBTC, toBytes32('sTRX')),
							reason
						);
						await systemStatus.requireExchangeBetweenTribesAllowed(
							toBytes32('rETH'),
							toBytes32('rUSD')
						); // no issues
						await systemStatus.requireExchangeBetweenTribesAllowed(
							toBytes32('iTRX'),
							toBytes32('iBTC')
						); // no issues
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeTribe(hBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(TRIBE, account1, true, true, { from: account3 })
						);
						await assert.revert(systemStatus.suspendSystem('1', { from: account3 }));
						await assert.revert(systemStatus.resumeSystem({ from: account3 }));
						await assert.revert(systemStatus.suspendIssuance('1', { from: account3 }));
						await assert.revert(systemStatus.resumeIssuance({ from: account3 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeTribe(hBTC, { from: owner });
					});
				});
			});
		});

		describe('suspendTribes()', () => {
			let txn;
			const [hBTC, rETH] = ['hBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendTribes,
					accounts,
					address: owner,
					args: [[hBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendTribes([hBTC, rETH], givenReason, { from: owner });
				});
				it('it succeeds for hBTC', async () => {
					const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[0], 'TribeSuspended', [hBTC, reason]);
				});
				it('and for rETH', async () => {
					const { suspended, reason } = await systemStatus.tribeSuspension(rETH);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[1], 'TribeSuspended', [rETH, reason]);
				});
				it('getTribeSuspensions(rETH, hBTC, iBTC) returns values for both', async () => {
					const { suspensions, reasons } = await systemStatus.getTribeSuspensions(
						['rETH', 'hBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [true, true, false]);
					assert.deepEqual(reasons, [givenReason, givenReason, '0']);
				});
			});
		});

		describe('resumeTribe()', () => {
			const hBTC = toBytes32('hBTC');

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeTribe,
					accounts,
					address: owner,
					args: [hBTC],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendTribe(hBTC, givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(TRIBE, account3, false, true, { from: owner });
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeTribe(hBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeTribe(hBTC, { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeTribe(hBTC, { from: account3 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'TribeResumed', [hBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireTribeActive(hBTC);
							await systemStatus.requireTribesActive(hBTC, toBytes32('rETH'));
							await systemStatus.requireTribesActive(toBytes32('rETH'), hBTC);
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendTribe(hBTC, givenReason, { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('nor can it do any other restricted action', async () => {
							await assert.revert(
								systemStatus.updateAccessControl(SYSTEM, account1, false, true, { from: account3 })
							);
							await assert.revert(systemStatus.suspendSystem('0', { from: account3 }));
							await assert.revert(systemStatus.resumeSystem({ from: account3 }));
							await assert.revert(systemStatus.suspendIssuance('0', { from: account3 }));
							await assert.revert(systemStatus.resumeIssuance({ from: account3 }));
						});

						it('getTribeSuspensions(rETH, hBTC, iBTC) is empty', async () => {
							const { suspensions, reasons } = await systemStatus.getTribeSuspensions(
								['rETH', 'hBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(suspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('resumeTribes()', () => {
			const [hBTC, rETH] = ['hBTC', 'rETH'].map(toBytes32);

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeTribes,
					accounts,
					address: owner,
					args: [[hBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendTribes([hBTC, rETH], givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(TRIBE, account3, false, true, { from: owner });
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeTribes([hBTC], { from: account1 }));
						await assert.revert(systemStatus.resumeTribes([hBTC], { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeTribes([hBTC, rETH], { from: account3 });
						});

						it('it succeeds for hBTC', async () => {
							const { suspended, reason } = await systemStatus.tribeSuspension(hBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[0], 'TribeResumed', [hBTC, givenReason]);
						});

						it('and for rETH', async () => {
							const { suspended, reason } = await systemStatus.tribeSuspension(rETH);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[1], 'TribeResumed', [rETH, givenReason]);
						});

						it('getTribeSuspensions(rETH, hBTC, iBTC) is empty', async () => {
							const { suspensions, reasons } = await systemStatus.getTribeSuspensions(
								['rETH', 'hBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(suspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('updateAccessControl()', () => {
			const tribe = toBytes32('rETH');

			it('can only be invoked by the owner', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.updateAccessControl,
					accounts,
					address: owner,
					args: [SYSTEM, account1, true, false],
					reason: 'Only the contract owner may perform this action',
				});
			});

			it('when invoked with an invalid section, it reverts', async () => {
				await assert.revert(
					systemStatus.updateAccessControl(toBytes32('test'), account1, false, true, {
						from: owner,
					}),
					'Invalid section supplied'
				);
			});

			describe('when invoked by the owner', () => {
				let txn;
				beforeEach(async () => {
					txn = await systemStatus.updateAccessControl(TRIBE, account3, true, false, {
						from: owner,
					});
				});

				it('then it emits the expected event', () => {
					assert.eventEqual(txn, 'AccessControlUpdated', [TRIBE, account3, true, false]);
				});

				it('and the user can perform the action', async () => {
					await systemStatus.suspendTribe(tribe, '1', { from: account3 }); // succeeds without revert
				});

				it('but not the other', async () => {
					await assert.revert(
						systemStatus.resumeTribe(tribe, { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('when overridden for the same user', () => {
					beforeEach(async () => {
						txn = await systemStatus.updateAccessControl(TRIBE, account3, false, false, {
							from: owner,
						});
					});

					it('then it emits the expected event', () => {
						assert.eventEqual(txn, 'AccessControlUpdated', [TRIBE, account3, false, false]);
					});

					it('and the user cannot perform the action', async () => {
						await assert.revert(
							systemStatus.suspendTribe(tribe, '1', { from: account3 }),
							'Restricted to access control list'
						);
					});
				});
			});
		});

		describe('updateAccessControls()', () => {
			it('can only be invoked by the owner', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.updateAccessControls,
					accounts,
					address: owner,
					args: [[SYSTEM], [account1], [true], [true]],
					reason: 'Only the contract owner may perform this action',
				});
			});

			it('when invoked with an invalid section, it reverts', async () => {
				await assert.revert(
					systemStatus.updateAccessControls(
						[TRIBE, toBytes32('test')],
						[account1, account2],
						[true, true],
						[false, true],
						{
							from: owner,
						}
					),
					'Invalid section supplied'
				);
			});

			it('when invoked with invalid lengths, it reverts', async () => {
				await assert.revert(
					systemStatus.updateAccessControls([TRIBE], [account1, account2], [true], [false, true], {
						from: owner,
					}),
					'Input array lengths must match'
				);
			});

			describe('when invoked by the owner', () => {
				let txn;
				const tribe = toBytes32('rETH');
				beforeEach(async () => {
					txn = await systemStatus.updateAccessControls(
						[SYSTEM, RWAONE_EXCHANGE, TRIBE],
						[account1, account2, account3],
						[true, false, true],
						[false, true, true],
						{ from: owner }
					);
				});

				it('then it emits the expected events', () => {
					assert.eventEqual(txn.logs[0], 'AccessControlUpdated', [SYSTEM, account1, true, false]);
					assert.eventEqual(txn.logs[1], 'AccessControlUpdated', [
						RWAONE_EXCHANGE,
						account2,
						false,
						true,
					]);
					assert.eventEqual(txn.logs[2], 'AccessControlUpdated', [TRIBE, account3, true, true]);
				});

				it('and the users can perform the actions given', async () => {
					await systemStatus.suspendSystem('3', { from: account1 }); // succeeds without revert
					await systemStatus.resumeTribeExchange(tribe, { from: account2 }); // succeeds without revert
					await systemStatus.suspendTribe(tribe, '100', { from: account3 }); // succeeds without revert
					await systemStatus.resumeTribe(tribe, { from: account3 }); // succeeds without revert
				});

				it('but not the others', async () => {
					await assert.revert(
						systemStatus.resumeSystem({ from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.resumeSystem({ from: account2 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendTribeExchange(tribe, '9', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendTribeExchange(tribe, '9', { from: account2 }),
						'Restricted to access control list'
					);
				});
			});
		});
	});
});
