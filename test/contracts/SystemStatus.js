'use strict';

const { artifacts, contract } = require('hardhat');

const { assert } = require('./common');

const SystemStatus = artifacts.require('SystemStatus');

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { toBytes32 } = require('../..');

contract('SystemStatus', async accounts => {
	const [SYSTEM, ISSUANCE, EXCHANGE, RWAONE_EXCHANGE, RWA, FUTURES] = [
		'System',
		'Issuance',
		'Exchange',
		'RwaExchange',
		'Rwa',
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
				'resumeRwa',
				'resumeRwas',
				'resumeRwaExchange',
				'resumeRwasExchange',
				'resumeFuturesMarket',
				'resumeFuturesMarkets',
				'resumeSystem',
				'suspendExchange',
				'suspendFutures',
				'suspendIssuance',
				'suspendRwa',
				'suspendRwas',
				'suspendRwaExchange',
				'suspendRwasExchange',
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
			systemStatus.suspendRwaExchange(toBytes32('rETH'), '1', { from: owner }),
			'Restricted to access control list'
		);
		await assert.revert(
			systemStatus.suspendRwa(toBytes32('rETH'), '1', { from: owner }),
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
				[SYSTEM, ISSUANCE, EXCHANGE, RWAONE_EXCHANGE, RWA, FUTURES],
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
				await systemStatus.requireRwaActive(toBytes32('rETH'));
				await systemStatus.requireRwasActive(toBytes32('rBTC'), toBytes32('rETH'));
				await systemStatus.requireFuturesMarketActive(toBytes32('rBTC'));
			});

			it('and all the bool views are correct', async () => {
				assert.isFalse(await systemStatus.systemSuspended());
				assert.isFalse(await systemStatus.rwaSuspended(toBytes32('rETH')));
				assert.isFalse(await systemStatus.rwaSuspended(toBytes32('rBTC')));
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
					await assert.revert(systemStatus.requireRwaActive(toBytes32('rETH')), reason);
					await assert.revert(systemStatus.requireFuturesMarketActive(toBytes32('rETH')), reason);
					await assert.revert(
						systemStatus.requireRwasActive(toBytes32('rBTC'), toBytes32('rETH')),
						reason
					);
				});

				it('and all the bool views are correct', async () => {
					assert.isTrue(await systemStatus.systemSuspended());
					assert.isTrue(await systemStatus.rwaSuspended(toBytes32('rETH')));
					assert.isTrue(await systemStatus.rwaSuspended(toBytes32('rBTC')));
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
						await assert.revert(systemStatus.requireRwaActive(toBytes32('rETH')), reason);
						await assert.revert(systemStatus.requireFuturesMarketActive(toBytes32('rETH')), reason);
						await assert.revert(
							systemStatus.requireRwasActive(toBytes32('rBTC'), toBytes32('rETH')),
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
							systemStatus.suspendRwa(toBytes32('rETH'), '0', { from: account1 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '0', { from: account1 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarkets([toBytes32('rETH')], '0', { from: account1 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account1 }));
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
							await systemStatus.requireRwaActive(toBytes32('rETH'));
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
								systemStatus.suspendRwa(toBytes32('rETH'), '66', { from: account1 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '66', { from: account1 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarkets([toBytes32('rETH')], '66', { from: account1 })
							);
							await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account1 }));
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
						await systemStatus.requireRwaActive(toBytes32('rETH'));
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
							systemStatus.suspendRwa(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
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
							await systemStatus.requireRwaActive(toBytes32('rETH'));
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
								systemStatus.suspendRwa(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
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
					it('and requireExchangeBetweenRwasAllowed reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireExchangeBetweenRwasAllowed(
								toBytes32('rETH'),
								toBytes32('rBTC')
							),
							'Exchange is suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireRwaActive(toBytes32('rETH'));
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
							systemStatus.suspendRwa(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(
							systemStatus.suspendFuturesMarket(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
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
							await systemStatus.requireExchangeBetweenRwasAllowed(
								toBytes32('rETH'),
								toBytes32('rBTC')
							);
							await systemStatus.requireRwaActive(toBytes32('rETH'));
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
								systemStatus.suspendRwa(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(
								systemStatus.suspendFuturesMarket(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
							await assert.revert(
								systemStatus.resumeFuturesMarket(toBytes32('rETH'), { from: account2 })
							);
						});
					});
				});
			});
		});

		describe('suspendRwaExchange()', () => {
			let txn;
			const rBTC = toBytes32('rBTC');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendRwaExchange,
					accounts,
					address: owner,
					args: [rBTC, '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getRwaExchangeSuspensions(rETH, rBTC, iBTC) is empty', async () => {
				const { exchangeSuspensions, reasons } = await systemStatus.getRwaExchangeSuspensions(
					['rETH', 'rBTC', 'iBTC'].map(toBytes32)
				);
				assert.deepEqual(exchangeSuspensions, [false, false, false]);
				assert.deepEqual(reasons, ['0', '0', '0']);
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendRwaExchange(rBTC, givenReason, { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn, 'RwaExchangeSuspended', [rBTC, reason]);
				});
				it('getRwaExchangeSuspensions(rETH, rBTC, iBTC) returns values for rBTC', async () => {
					const { exchangeSuspensions, reasons } = await systemStatus.getRwaExchangeSuspensions(
						['rETH', 'rBTC', 'iBTC'].map(toBytes32)
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
						systemStatus.suspendRwaExchange(rBTC, '4', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendRwaExchange(rBTC, '0', { from: account2 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendRwaExchange(rBTC, '3', { from: account3 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '3');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'RwaExchangeSuspended', [rBTC, '3']);
					});
					it('and the rwa require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireRwaExchangeActive(rBTC),
							'Rwa exchange suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireIssuanceActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireRwaActive(rBTC);
						await systemStatus.requireFuturesMarketActive(rBTC);
						await systemStatus.requireRwasActive(toBytes32('rETH'), rBTC);
					});
					it('and requireExchangeBetweenRwasAllowed() reverts if one is the given rwa', async () => {
						const reason = 'Rwa exchange suspended. Operation prohibited';
						await assert.revert(
							systemStatus.requireExchangeBetweenRwasAllowed(toBytes32('rETH'), rBTC),
							reason
						);
						await assert.revert(
							systemStatus.requireExchangeBetweenRwasAllowed(rBTC, toBytes32('sTRX')),
							reason
						);
						await systemStatus.requireExchangeBetweenRwasAllowed(
							toBytes32('rETH'),
							toBytes32('rUSD')
						); // no issues
						await systemStatus.requireExchangeBetweenRwasAllowed(
							toBytes32('iTRX'),
							toBytes32('iBTC')
						); // no issues
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeRwaExchange(rBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});

					it('yet the owner can still resume', async () => {
						await systemStatus.resumeRwaExchange(rBTC, { from: owner });
					});
				});
			});
		});

		describe('resumeRwaExchange()', () => {
			const rBTC = toBytes32('rBTC');

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeRwaExchange,
					accounts,
					address: owner,
					args: [rBTC],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendRwaExchange(rBTC, givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWAONE_EXCHANGE, account3, false, true, {
							from: owner,
						});
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeRwaExchange(rBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeRwaExchange(rBTC, { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeRwaExchange(rBTC, { from: account3 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'RwaExchangeResumed', [rBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireExchangeBetweenRwasAllowed(toBytes32('rETH'), rBTC);
							await systemStatus.requireRwaActive(rBTC);
							await systemStatus.requireFuturesMarketActive(rBTC);
							await systemStatus.requireRwasActive(rBTC, toBytes32('rETH'));
							await systemStatus.requireRwasActive(toBytes32('rETH'), rBTC);
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendRwaExchange(rBTC, givenReason, { from: account2 }),
								'Restricted to access control list'
							);
						});

						it('getRwaExchangeSuspensions(rETH, rBTC, iBTC) is empty', async () => {
							const {
								exchangeSuspensions,
								reasons,
							} = await systemStatus.getRwaExchangeSuspensions(
								['rETH', 'rBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(exchangeSuspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('suspendRwasExchange()', () => {
			let txn;
			const [rBTC, rETH] = ['rBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendRwasExchange,
					accounts,
					address: owner,
					args: [[rBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendRwasExchange([rBTC, rETH], givenReason, {
						from: owner,
					});
				});
				it('it succeeds for BTC', async () => {
					const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[0], 'RwaExchangeSuspended', [rBTC, reason]);
				});
				it('and for ETH', async () => {
					const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rETH);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[1], 'RwaExchangeSuspended', [rETH, reason]);
				});
				it('getRwaExchangeSuspensions(rETH, rBTC, iBTC) returns values for rETH and rBTC', async () => {
					const { exchangeSuspensions, reasons } = await systemStatus.getRwaExchangeSuspensions(
						['rETH', 'rBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(exchangeSuspensions, [true, true, false]);
					assert.deepEqual(reasons, [givenReason, givenReason, '0']);
				});
			});
		});

		describe('resumeRwasExchange()', () => {
			let txn;
			const [rBTC, rETH] = ['rBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeRwasExchange,
					accounts,
					address: owner,
					args: [[rBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendRwasExchange([rBTC, rETH], givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWAONE_EXCHANGE, account3, false, true, {
							from: owner,
						});
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeRwasExchange([rBTC, rETH], { from: account3 });
						});

						it('it succeeds for rBTC', async () => {
							const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[0], 'RwaExchangeResumed', [rBTC, givenReason]);
						});

						it('and for rETH', async () => {
							const { suspended, reason } = await systemStatus.rwaExchangeSuspension(rETH);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[1], 'RwaExchangeResumed', [rETH, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(rBTC);
							await systemStatus.requireExchangeBetweenRwasAllowed(rETH, rBTC);
							await systemStatus.requireRwasActive(rBTC, rETH);
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
							systemStatus.requireFuturesMarketActive(toBytes32('rBTC')),
							'Futures markets are suspended. Operation prohibited'
						);
					});
					it('but not the others', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireRwaActive(toBytes32('rETH'));
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
							systemStatus.suspendRwa(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
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
							await systemStatus.requireFuturesMarketActive(toBytes32('rBTC'));
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
								systemStatus.suspendRwa(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
						});
					});
				});
			});
		});

		describe('suspendFuturesMarket(s)', () => {
			let txn;
			const rBTC = toBytes32('rBTC');
			const rETH = toBytes32('rETH');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.futuresMarketSuspension(rBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendFuturesMarket,
					accounts,
					address: owner,
					args: [rBTC, '0'],
					reason: 'Restricted to access control list',
				});
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendFuturesMarkets,
					accounts,
					address: owner,
					args: [[rBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getFuturesMarketSuspensions(rETH, rBTC) is empty', async () => {
				const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
					['rETH', 'rBTC'].map(toBytes32)
				);
				assert.deepEqual(suspensions, [false, false]);
				assert.deepEqual(reasons, ['0', '0']);
			});

			describe('when the owner suspends single market', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendFuturesMarket(rBTC, '5', { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.futuresMarketSuspension(rBTC);
					assert.equal(suspended, true);
					assert.equal(reason, '5');
					assert.eventEqual(txn, 'FuturesMarketSuspended', [rBTC, '5']);
				});
				it('getFuturesMarketSuspensions(rETH, rBTC) returns values for rBTC', async () => {
					const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
						['rETH', 'rBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [false, true]);
					assert.deepEqual(reasons, ['0', '5']);
				});
			});

			describe('when the owner suspends multiple markets', () => {
				beforeEach(async () => {
					txn = await systemStatus.suspendFuturesMarkets([rBTC, rETH], '5', { from: owner });
				});
				it('it succeeds', async () => {
					assert.equal((await systemStatus.futuresMarketSuspension(rBTC)).suspended, true);
					assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, true);
				});
				it('getFuturesMarketSuspensions(rETH, rBTC) returns values for both', async () => {
					const { suspensions, reasons } = await systemStatus.getFuturesMarketSuspensions(
						['rETH', 'rBTC'].map(toBytes32)
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
						systemStatus.suspendFuturesMarket(rBTC, '1', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendFuturesMarket(rBTC, '10', { from: account3 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendFuturesMarkets([rBTC], '10', { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend for single market', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendFuturesMarket(rBTC, '33', { from: account2 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.futuresMarketSuspension(rBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '33');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'FuturesMarketSuspended', [rBTC, '33']);
					});
					it('and the require check reverts as expected', async () => {
						await assert.revert(systemStatus.requireFuturesMarketActive(rBTC), 'Market suspended');
					});
					it('but not the other checks', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireRwaActive(toBytes32('rETH'));
					});
					it('and not other markets', async () => {
						await systemStatus.requireFuturesMarketActive(toBytes32('rETH'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeFuturesMarket(rBTC, { from: account2 }),
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
							systemStatus.suspendRwa(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeFutures({ from: owner });
					});
				});

				describe('and that address invokes suspend for multiple market', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendFuturesMarkets([rBTC, rETH], '33', { from: account2 });
					});
					it('it succeeds', async () => {
						assert.equal((await systemStatus.futuresMarketSuspension(rBTC)).suspended, true);
						assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, true);
					});
					it('and the require checks reverts as expected', async () => {
						await assert.revert(systemStatus.requireFuturesMarketActive(rBTC), 'Market suspended');
						await assert.revert(systemStatus.requireFuturesMarketActive(rETH), 'Market suspended');
					});
					it('but not the other checks', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireExchangeActive();
						await systemStatus.requireFuturesActive();
						await systemStatus.requireRwaActive(toBytes32('rETH'));
					});
					it('and not other markets', async () => {
						await systemStatus.requireFuturesMarketActive(toBytes32('sOTHER'));
					});

					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeFuturesMarket(rBTC, { from: account2 }),
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
							systemStatus.suspendRwa(toBytes32('rETH'), '55', { from: account2 })
						);
						await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeFutures({ from: owner });
					});
				});
			});
		});

		describe('resumeFuturesMarket(s)', () => {
			let txn;
			const rBTC = toBytes32('rBTC');
			const rETH = toBytes32('rETH');
			const sLINK = toBytes32('sLINK');

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeFuturesMarket,
					accounts,
					address: owner,
					args: [rBTC],
					reason: 'Restricted to access control list',
				});
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeFuturesMarkets,
					accounts,
					address: owner,
					args: [[rBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends multiple markets', () => {
				const givenReason = '5';
				beforeEach(async () => {
					await systemStatus.suspendFuturesMarkets([rBTC, rETH, sLINK], givenReason, {
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
						await assert.revert(systemStatus.resumeFuturesMarket(rBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeFuturesMarket(rBTC, { from: account3 }));
						await assert.revert(systemStatus.resumeFuturesMarkets([rBTC], { from: account3 }));
					});

					describe('and that address invokes resume for first market', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeFuturesMarket(rBTC, { from: account2 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.futuresMarketSuspension(rBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'FuturesMarketResumed', [rBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(rBTC);
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
								systemStatus.suspendRwa(toBytes32('rETH'), '5', { from: account2 })
							);
							await assert.revert(systemStatus.resumeRwa(toBytes32('rETH'), { from: account2 }));
						});
					});

					describe('and that address invokes resume for two markets', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeFuturesMarkets([rBTC, rETH], { from: account2 });
						});

						it('it succeeds', async () => {
							assert.equal((await systemStatus.futuresMarketSuspension(rBTC)).suspended, false);
							assert.equal((await systemStatus.futuresMarketSuspension(rETH)).suspended, false);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireFuturesActive();
							await systemStatus.requireFuturesMarketActive(rBTC);
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

		describe('suspendRwa()', () => {
			let txn;
			const rBTC = toBytes32('rBTC');

			it('is not suspended initially', async () => {
				const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
				assert.equal(suspended, false);
				assert.equal(reason, '0');
			});

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendRwa,
					accounts,
					address: owner,
					args: [rBTC, '0'],
					reason: 'Restricted to access control list',
				});
			});

			it('getRwaSuspensions(rETH, rBTC, iBTC) is empty', async () => {
				const { suspensions, reasons } = await systemStatus.getRwaSuspensions(
					['rETH', 'rBTC', 'iBTC'].map(toBytes32)
				);
				assert.deepEqual(suspensions, [false, false, false]);
				assert.deepEqual(reasons, ['0', '0', '0']);
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendRwa(rBTC, givenReason, { from: owner });
				});
				it('it succeeds', async () => {
					const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn, 'RwaSuspended', [rBTC, reason]);
				});
				it('getRwaSuspensions(rETH, rBTC, iBTC) returns values for rBTC', async () => {
					const { suspensions, reasons } = await systemStatus.getRwaSuspensions(
						['rETH', 'rBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [false, true, false]);
					assert.deepEqual(reasons, ['0', givenReason, '0']);
				});
			});

			describe('when the owner adds an address to suspend only', () => {
				beforeEach(async () => {
					await systemStatus.updateAccessControl(RWA, account3, true, false, { from: owner });
				});

				it('other addresses still cannot suspend', async () => {
					await assert.revert(
						systemStatus.suspendRwa(rBTC, '4', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendRwa(rBTC, '0', { from: account2 }),
						'Restricted to access control list'
					);
				});

				describe('and that address invokes suspend', () => {
					beforeEach(async () => {
						txn = await systemStatus.suspendRwa(rBTC, '3', { from: account3 });
					});
					it('it succeeds', async () => {
						const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
						assert.equal(suspended, true);
						assert.equal(reason, '3');
					});
					it('and emits the expected event', async () => {
						assert.eventEqual(txn, 'RwaSuspended', [rBTC, '3']);
					});
					it('and the rwa require check reverts as expected', async () => {
						await assert.revert(
							systemStatus.requireRwaActive(rBTC),
							'Rwa is suspended. Operation prohibited'
						);
					});
					it('and the rwa bool view is as expected', async () => {
						assert.isTrue(await systemStatus.rwaSuspended(rBTC));
					});
					it('but not other rwa bool view', async () => {
						assert.isFalse(await systemStatus.rwaSuspended(toBytes32('rETH')));
					});
					it('but others do not revert', async () => {
						await systemStatus.requireSystemActive();
						await systemStatus.requireIssuanceActive();
					});
					it('and requireRwasActive() reverts if one is the given rwa', async () => {
						const reason = 'Rwa is suspended. Operation prohibited';
						await assert.revert(systemStatus.requireRwasActive(toBytes32('rETH'), rBTC), reason);
						await assert.revert(systemStatus.requireRwasActive(rBTC, toBytes32('sTRX')), reason);
						await systemStatus.requireRwasActive(toBytes32('rETH'), toBytes32('rUSD')); // no issues
						await systemStatus.requireRwasActive(toBytes32('iTRX'), toBytes32('iBTC')); // no issues
					});
					it('and requireExchangeBetweenRwasAllowed() reverts if one is the given rwa', async () => {
						const reason = 'Rwa is suspended. Operation prohibited';
						await assert.revert(
							systemStatus.requireExchangeBetweenRwasAllowed(toBytes32('rETH'), rBTC),
							reason
						);
						await assert.revert(
							systemStatus.requireExchangeBetweenRwasAllowed(rBTC, toBytes32('sTRX')),
							reason
						);
						await systemStatus.requireExchangeBetweenRwasAllowed(
							toBytes32('rETH'),
							toBytes32('rUSD')
						); // no issues
						await systemStatus.requireExchangeBetweenRwasAllowed(
							toBytes32('iTRX'),
							toBytes32('iBTC')
						); // no issues
					});
					it('yet that address cannot resume', async () => {
						await assert.revert(
							systemStatus.resumeRwa(rBTC, { from: account2 }),
							'Restricted to access control list'
						);
					});
					it('nor can it do any other restricted action', async () => {
						await assert.revert(
							systemStatus.updateAccessControl(RWA, account1, true, true, { from: account3 })
						);
						await assert.revert(systemStatus.suspendSystem('1', { from: account3 }));
						await assert.revert(systemStatus.resumeSystem({ from: account3 }));
						await assert.revert(systemStatus.suspendIssuance('1', { from: account3 }));
						await assert.revert(systemStatus.resumeIssuance({ from: account3 }));
					});
					it('yet the owner can still resume', async () => {
						await systemStatus.resumeRwa(rBTC, { from: owner });
					});
				});
			});
		});

		describe('suspendRwas()', () => {
			let txn;
			const [rBTC, rETH] = ['rBTC', 'rETH'].map(toBytes32);

			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.suspendRwas,
					accounts,
					address: owner,
					args: [[rBTC, rETH], '0'],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '150';
				beforeEach(async () => {
					txn = await systemStatus.suspendRwas([rBTC, rETH], givenReason, { from: owner });
				});
				it('it succeeds for rBTC', async () => {
					const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[0], 'RwaSuspended', [rBTC, reason]);
				});
				it('and for rETH', async () => {
					const { suspended, reason } = await systemStatus.rwaSuspension(rETH);
					assert.equal(suspended, true);
					assert.equal(reason, givenReason);
					assert.eventEqual(txn.logs[1], 'RwaSuspended', [rETH, reason]);
				});
				it('getRwaSuspensions(rETH, rBTC, iBTC) returns values for both', async () => {
					const { suspensions, reasons } = await systemStatus.getRwaSuspensions(
						['rETH', 'rBTC', 'iBTC'].map(toBytes32)
					);
					assert.deepEqual(suspensions, [true, true, false]);
					assert.deepEqual(reasons, [givenReason, givenReason, '0']);
				});
			});
		});

		describe('resumeRwa()', () => {
			const rBTC = toBytes32('rBTC');

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeRwa,
					accounts,
					address: owner,
					args: [rBTC],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendRwa(rBTC, givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWA, account3, false, true, { from: owner });
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeRwa(rBTC, { from: account1 }));
						await assert.revert(systemStatus.resumeRwa(rBTC, { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeRwa(rBTC, { from: account3 });
						});

						it('it succeeds', async () => {
							const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
						});

						it('and emits the expected event', async () => {
							assert.eventEqual(txn, 'RwaResumed', [rBTC, givenReason]);
						});

						it('and all the require checks succeed', async () => {
							await systemStatus.requireSystemActive();
							await systemStatus.requireIssuanceActive();
							await systemStatus.requireRwaActive(rBTC);
							await systemStatus.requireRwasActive(rBTC, toBytes32('rETH'));
							await systemStatus.requireRwasActive(toBytes32('rETH'), rBTC);
						});

						it('yet that address cannot suspend', async () => {
							await assert.revert(
								systemStatus.suspendRwa(rBTC, givenReason, { from: account2 }),
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

						it('getRwaSuspensions(rETH, rBTC, iBTC) is empty', async () => {
							const { suspensions, reasons } = await systemStatus.getRwaSuspensions(
								['rETH', 'rBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(suspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('resumeRwas()', () => {
			const [rBTC, rETH] = ['rBTC', 'rETH'].map(toBytes32);

			let txn;
			it('can only be invoked by the owner initially', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: systemStatus.resumeRwas,
					accounts,
					address: owner,
					args: [[rBTC, rETH]],
					reason: 'Restricted to access control list',
				});
			});

			describe('when the owner suspends', () => {
				const givenReason = '55';
				beforeEach(async () => {
					await systemStatus.suspendRwas([rBTC, rETH], givenReason, { from: owner });
				});

				describe('when the owner adds an address to resume only', () => {
					beforeEach(async () => {
						await systemStatus.updateAccessControl(RWA, account3, false, true, { from: owner });
					});

					it('other addresses still cannot resume', async () => {
						await assert.revert(systemStatus.resumeRwas([rBTC], { from: account1 }));
						await assert.revert(systemStatus.resumeRwas([rBTC], { from: account2 }));
					});

					describe('and that address invokes resume', () => {
						beforeEach(async () => {
							txn = await systemStatus.resumeRwas([rBTC, rETH], { from: account3 });
						});

						it('it succeeds for rBTC', async () => {
							const { suspended, reason } = await systemStatus.rwaSuspension(rBTC);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[0], 'RwaResumed', [rBTC, givenReason]);
						});

						it('and for rETH', async () => {
							const { suspended, reason } = await systemStatus.rwaSuspension(rETH);
							assert.equal(suspended, false);
							assert.equal(reason, '0');
							assert.eventEqual(txn.logs[1], 'RwaResumed', [rETH, givenReason]);
						});

						it('getRwaSuspensions(rETH, rBTC, iBTC) is empty', async () => {
							const { suspensions, reasons } = await systemStatus.getRwaSuspensions(
								['rETH', 'rBTC', 'iBTC'].map(toBytes32)
							);
							assert.deepEqual(suspensions, [false, false, false]);
							assert.deepEqual(reasons, ['0', '0', '0']);
						});
					});
				});
			});
		});

		describe('updateAccessControl()', () => {
			const rwa = toBytes32('rETH');

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
					txn = await systemStatus.updateAccessControl(RWA, account3, true, false, {
						from: owner,
					});
				});

				it('then it emits the expected event', () => {
					assert.eventEqual(txn, 'AccessControlUpdated', [RWA, account3, true, false]);
				});

				it('and the user can perform the action', async () => {
					await systemStatus.suspendRwa(rwa, '1', { from: account3 }); // succeeds without revert
				});

				it('but not the other', async () => {
					await assert.revert(
						systemStatus.resumeRwa(rwa, { from: account3 }),
						'Restricted to access control list'
					);
				});

				describe('when overridden for the same user', () => {
					beforeEach(async () => {
						txn = await systemStatus.updateAccessControl(RWA, account3, false, false, {
							from: owner,
						});
					});

					it('then it emits the expected event', () => {
						assert.eventEqual(txn, 'AccessControlUpdated', [RWA, account3, false, false]);
					});

					it('and the user cannot perform the action', async () => {
						await assert.revert(
							systemStatus.suspendRwa(rwa, '1', { from: account3 }),
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
						[RWA, toBytes32('test')],
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
					systemStatus.updateAccessControls([RWA], [account1, account2], [true], [false, true], {
						from: owner,
					}),
					'Input array lengths must match'
				);
			});

			describe('when invoked by the owner', () => {
				let txn;
				const rwa = toBytes32('rETH');
				beforeEach(async () => {
					txn = await systemStatus.updateAccessControls(
						[SYSTEM, RWAONE_EXCHANGE, RWA],
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
					assert.eventEqual(txn.logs[2], 'AccessControlUpdated', [RWA, account3, true, true]);
				});

				it('and the users can perform the actions given', async () => {
					await systemStatus.suspendSystem('3', { from: account1 }); // succeeds without revert
					await systemStatus.resumeRwaExchange(rwa, { from: account2 }); // succeeds without revert
					await systemStatus.suspendRwa(rwa, '100', { from: account3 }); // succeeds without revert
					await systemStatus.resumeRwa(rwa, { from: account3 }); // succeeds without revert
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
						systemStatus.suspendRwaExchange(rwa, '9', { from: account1 }),
						'Restricted to access control list'
					);
					await assert.revert(
						systemStatus.suspendRwaExchange(rwa, '9', { from: account2 }),
						'Restricted to access control list'
					);
				});
			});
		});
	});
});
