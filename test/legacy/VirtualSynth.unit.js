'use strict';

const { artifacts, contract } = require('hardhat');

const { assert } = require('../contracts/common');

const { expect } = require('chai');

const {
	ensureOnlyExpectedMutativeFunctions,
	trimUtf8EscapeChars,
} = require('../contracts/helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const { divideDecimal } = require('../utils')();

const VirtualRwa = artifacts.require('VirtualRwa');

contract('VirtualRwa (unit tests)', async accounts => {
	const [, owner, alice] = accounts;

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: VirtualRwa.abi,
			ignoreParents: ['ERC20'],
			expected: ['initialize', 'settle'],
		});
	});

	describe('with common setup', () => {
		// ensure all of the behaviors are bound to "this" for sharing test state
		const behaviors = require('./VirtualRwa.behaviors').call(this, { accounts });
		describe('initialize', () => {
			const amount = '1001';
			behaviors.whenInstantiated({ amount, user: owner, rwa: 'rBTC' }, () => {
				it('is initialized', async () => {
					assert.isTrue(await this.instance.initialized());
				});

				it('and each initialize arg is set correctly', async () => {
					assert.equal(trimUtf8EscapeChars(await this.instance.name()), 'Virtual Rwa rBTC');
					assert.equal(trimUtf8EscapeChars(await this.instance.symbol()), 'vrBTC');
					assert.equal(await this.instance.decimals(), '18');
				});

				it('and the user is minted the total supply', async () => {
					assert.equal(await this.instance.totalSupply(), amount);
					assert.equal(await this.instance.balanceOf(owner), amount);
				});

				it('and a transfer event was emitted to the user', async () => {
					const [evt] = await this.instance.getPastEvents();

					assert.equal(evt.event, 'Transfer');
					assert.equal(evt.args.from, ZERO_ADDRESS);
					assert.equal(evt.args.to, owner);
					assert.equal(evt.args.value.toString(), amount);
				});

				it('and it cannot be initialized again', async () => {
					await assert.revert(
						this.instance.initialize(
							this.mocks.Rwa.address,
							this.resolver.address,
							owner,
							amount,
							toBytes32('rUSD')
						),
						'vRwa already initialized'
					);
				});
			});
		});

		describe('balanceOfUnderlying()', () => {
			const amount = '1200';
			behaviors.whenInstantiated({ amount, user: owner }, () => {
				// when nothing to be settled
				behaviors.whenMockedSettlementOwing({}, () => {
					behaviors.whenMockedRwaBalance({ balanceOf: amount }, () => {
						it('then balance underlying must match the balance', async () => {
							assert.equal(await this.instance.balanceOfUnderlying(owner), amount);
						});
					});
					behaviors.whenMockedRwaBalance({ balanceOf: amount / 2 }, () => {
						it('then balance underlying must be half the balance', async () => {
							assert.equal((await this.instance.balanceOfUnderlying(owner)).toString(), amount / 2);
						});
						behaviors.whenUserTransfersAwayTokens({ amount: amount / 2, from: owner }, () => {
							it('then balance underlying must be quarter the balance', async () => {
								assert.equal(
									(await this.instance.balanceOfUnderlying(owner)).toString(),
									amount / 4
								);
							});
							behaviors.whenUserTransfersAwayTokens({ amount: amount / 3, from: owner }, () => {
								it('then balance underlying must be a twelth of the balance', async () => {
									assert.equal(
										(await this.instance.balanceOfUnderlying(owner)).toString(),
										amount / 12
									);
								});
							});
						});
						behaviors.whenUserTransfersAwayTokens({ amount: amount / 3, from: owner }, () => {
							it('then balance underlying must be a third of the balance', async () => {
								assert.equal(
									(await this.instance.balanceOfUnderlying(owner)).toString(),
									amount / 3
								);
							});
						});
					});
				});

				behaviors.whenMockedRwaBalance({ balanceOf: amount }, () => {
					behaviors.whenMockedSettlementOwing({ reclaim: 200 }, () => {
						it('then balance underlying must match the balance after the reclaim', async () => {
							assert.equal(await this.instance.balanceOfUnderlying(owner), +amount - 200);
						});
						behaviors.whenUserTransfersAwayTokens({ amount: amount / 2, from: owner }, () => {
							it('then balance underlying must match the balance after the reclaim, in proportion to their share', async () => {
								assert.equal(await this.instance.balanceOfUnderlying(owner), (+amount - 200) / 2);
							});
						});
						behaviors.whenSettlementCalled({ user: owner }, () => {
							it('then balance underlying is 0 as user supply is burned', async () => {
								assert.equal(await this.instance.balanceOfUnderlying(owner), '0');
							});
						});
					});
					behaviors.whenMockedSettlementOwing({ rebate: 300 }, () => {
						it('then balance underlying must match the balance after the rebate', async () => {
							assert.equal(await this.instance.balanceOfUnderlying(owner), +amount + 300);
						});
						behaviors.whenUserTransfersAwayTokens(
							{ amount: amount / 2, from: owner, to: alice },
							() => {
								it('then balance underlying must match the balance after the reclaim, in proportion to their share', async () => {
									assert.equal(await this.instance.balanceOfUnderlying(owner), (+amount + 300) / 2);
								});
								it('whereas the other user has the other half', async () => {
									assert.equal(await this.instance.balanceOfUnderlying(alice), (+amount + 300) / 2);
								});
								behaviors.whenSettlementCalled({ user: owner }, () => {
									it('then balance underlying is 0 as user supply is burned', async () => {
										assert.equal(await this.instance.balanceOfUnderlying(owner), '0');
									});
									it('whereas the other user still has the other half', async () => {
										assert.equal(
											await this.instance.balanceOfUnderlying(alice),
											(+amount + 300) / 2
										);
									});
								});
							}
						);
						behaviors.whenSettlementCalled({ user: owner }, () => {
							it('then balance underlying is 0 as user supply is burned', async () => {
								assert.equal(await this.instance.balanceOfUnderlying(owner), '0');
							});
						});
					});
				});
			});
		});

		describe('rate()', () => {
			const amount = '1200';
			behaviors.whenInstantiated({ amount: '0', user: owner }, () => {
				it('then the rate must be 0', async () => {
					assert.equal(await this.instance.rate(), '0');
				});
			});
			behaviors.whenInstantiated({ amount, user: owner }, () => {
				behaviors.whenMockedRwaBalance({ balanceOf: amount }, () => {
					describe('pre-settlement', () => {
						behaviors.whenMockedSettlementOwing({}, () => {
							it('then the rate must be even', async () => {
								assert.equal(await this.instance.rate(), (1e18).toString());
							});
						});
						behaviors.whenMockedSettlementOwing({ reclaim: 200 }, () => {
							it('then the rate must be 10/12 (with 18 decimals)', async () => {
								assert.bnEqual(await this.instance.rate(), divideDecimal(10, 12));
							});
						});
						behaviors.whenMockedSettlementOwing({ rebate: 300 }, () => {
							it('then the rate must be 15/12 (with 18 decimals)', async () => {
								assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
							});
							behaviors.whenUserTransfersAwayTokens({ amount: '300', from: owner }, () => {
								it('then the rate must still be 15/12 (with 18 decimals)', async () => {
									assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
								});
								behaviors.whenSettlementCalled({ user: owner }, () => {
									it('then the rate must still be 15/12 (with 18 decimals)', async () => {
										assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
									});
								});
							});
						});
					});

					describe('post-settlement', () => {
						behaviors.whenMockedSettlementOwing({}, () => {
							behaviors.whenSettlementCalled({ user: owner }, () => {
								it('then the rate must be even', async () => {
									assert.equal(await this.instance.rate(), (1e18).toString());
								});
							});
							behaviors.whenMockedSettlementOwing({ reclaim: 200 }, () => {
								behaviors.whenSettlementCalled({ user: owner }, () => {
									it('then the rate must be 10/12 (with 18 decimals)', async () => {
										assert.bnEqual(await this.instance.rate(), divideDecimal(10, 12));
									});
								});
							});
							behaviors.whenMockedSettlementOwing({ rebate: 300 }, () => {
								it('then the rate must be 15/12 (with 18 decimals)', async () => {
									assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
								});
								behaviors.whenUserTransfersAwayTokens({ amount: '300', from: owner }, () => {
									it('then the rate must still be 15/12 (with 18 decimals)', async () => {
										assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
									});
									behaviors.whenSettlementCalled({ user: owner }, () => {
										it('then the rate must still be 15/12 (with 18 decimals) ', async () => {
											assert.bnEqual(await this.instance.rate(), divideDecimal(15, 12));
										});
									});
								});
							});
						});
					});
				});
			});
		});

		describe('secsLeftInWaitingPeriod()', () => {
			behaviors.whenInstantiated({ amount: '1000', user: owner, rwa: 'rBTC' }, () => {
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 100 }, () => {
					it('then secs left in waiting period returns 100', async () => {
						assert.equal(await this.instance.secsLeftInWaitingPeriod(), '100');
					});
				});
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 1 }, () => {
					it('then secs left in waiting period returns 1', async () => {
						assert.equal(await this.instance.secsLeftInWaitingPeriod(), '1');
					});
				});
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 0 }, () => {
					it('then secs left in waiting period returns 0', async () => {
						assert.equal(await this.instance.secsLeftInWaitingPeriod(), '0');
					});
				});
			});
		});

		describe('readyToSettle()', () => {
			behaviors.whenInstantiated({ amount: '999', user: owner, rwa: 'rBTC' }, () => {
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 100 }, () => {
					it('then ready to settle is false', async () => {
						assert.equal(await this.instance.readyToSettle(), false);
					});
				});
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 1 }, () => {
					it('then ready to settle is false', async () => {
						assert.equal(await this.instance.readyToSettle(), false);
					});
				});
				behaviors.whenMockedWithMaxSecsLeft({ maxSecsLeft: 0 }, () => {
					it('then ready to settle is false', async () => {
						assert.equal(await this.instance.readyToSettle(), true);
					});
				});
			});
		});

		describe('settlement', () => {
			const amount = '999';
			behaviors.whenInstantiated({ amount, user: owner, rwa: 'rBTC' }, () => {
				behaviors.whenMockedRwaBalance({ balanceOf: amount }, () => {
					describe('settled()', () => {
						it('is false by default', async () => {
							assert.equal(await this.instance.settled(), false);
						});
						behaviors.whenSettlementCalled({ user: owner }, () => {
							it('is true', async () => {
								assert.equal(await this.instance.settled(), true);
							});
						});
					});
					describe('settle()', () => {
						behaviors.whenSettlementCalled({ user: owner }, () => {
							it('then Exchanger.settle() is invoked with the correct params', async () => {
								expect(this.mocks.Exchanger.settle).to.have.length(0);
								this.mocks.Exchanger.settle.returnsAtCall(0, this.instance.address);
								this.mocks.Exchanger.settle.returndAtCall(1, toBytes32('rBTC'));
							});
							it('then Exchanger.settle() emits a Settled event with the supply and balance params', () => {
								assert.eventEqual(this.txn, 'Settled', [amount, amount]);
							});
							it('then the balance of the users vRwa is 0', async () => {
								assert.equal(await this.instance.balanceOf(owner), '0');
							});
							it('then the user is transferred the balance of the rwa', async () => {
								expect(this.mocks.Rwa.transfer).to.have.length(0);
								await this.mocks.Rwa.transfer.returnsAtCall(0, owner);
								await this.mocks.Rwa.transfer.returnsAtCall(1, amount);
							});
							behaviors.whenSettlementCalled({ user: owner }, () => {
								it('then Exchanger.settle() does not emit another settlement', () => {
									assert.equal(
										this.txn.receipt.logs.find(({ event }) => event === 'Settled'),
										undefined
									);
								});
							});
						});

						behaviors.whenMockedSettlementOwing({ reclaim: 333 }, () => {
							behaviors.whenSettlementCalled({ user: owner }, () => {
								it('then the user is transferred the remaining balance of the rwas', async () => {
									expect(this.mocks.Rwa.transfer).to.have.length(0);
									await this.mocks.Rwa.transfer.returnsAtCall(0, owner);
									await this.mocks.Rwa.transfer.returnsAtCall(1, '666');
								});
							});
						});

						behaviors.whenMockedSettlementOwing({ rebate: 1 }, () => {
							behaviors.whenSettlementCalled({ user: owner }, () => {
								it('then the user is transferred the entire balance of the rwas', async () => {
									expect(this.mocks.Rwa.transfer).to.have.length(0);
									await this.mocks.Rwa.transfer.returnsAtCall(0, owner);
									await this.mocks.Rwa.transfer.returnsAtCall(1, '1000');
								});
							});
						});

						behaviors.whenUserTransfersAwayTokens({ amount: '666', from: owner }, () => {
							behaviors.whenSettlementCalled({ user: owner }, () => {
								it('then the user is transferred their portion balance of the rwas', async () => {
									expect(this.mocks.Rwa.transfer).to.have.length(0);
									await this.mocks.Rwa.transfer.returnsAtCall(0, owner);
									await this.mocks.Rwa.transfer.returnsAtCall(1, '333');
								});
							});

							behaviors.whenMockedSettlementOwing({ reclaim: 300 }, () => {
								// total rwas is 999 - 300 = 699. User has 1/3 of the vRwa supply
								behaviors.whenSettlementCalled({ user: owner }, () => {
									it('then the user is transferred their portion balance of the rwas', async () => {
										expect(this.mocks.Rwa.transfer).to.have.length(0);
										await this.mocks.Rwa.transfer.returnsAtCall(0, owner);
										await this.mocks.Rwa.transfer.returnsAtCall(1, '233');
									});
								});
							});
						});
					});
				});
			});
		});
	});
});
