'use strict';

const { artifacts, contract } = require('hardhat');
const { smock } = require('@defi-wonderland/smock');
const {
	utils: { parseEther },
} = require('ethers');
const { assert } = require('../contracts/common');

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	prepareSmocks,
} = require('../contracts/helpers');

const {
	constants: { ZERO_ADDRESS },
} = require('../..');

let RwaRedeemer;

contract('RwaRedeemer (unit tests)', async accounts => {
	const [account1] = accounts;

	before(async () => {
		RwaRedeemer = artifacts.require('RwaRedeemer');
	});
	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: RwaRedeemer.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: ['deprecate', 'redeem', 'redeemAll', 'redeemPartial'],
		});
	});

	describe('when a contract is instantiated', () => {
		let instance;
		let rwa, otherRwa;
		beforeEach(async () => {
			({ mocks: this.mocks, resolver: this.resolver } = await prepareSmocks({
				contracts: ['Issuer', 'Rwa:RwarUSD'],
				accounts: accounts.slice(10), // mock using accounts after the first few
			}));
		});
		beforeEach(async () => {
			rwa = await smock.fake('ERC20');
			otherRwa = await smock.fake('ERC20');
		});
		beforeEach(async () => {
			instance = await RwaRedeemer.new(this.resolver.address);
			await instance.rebuildCache();
		});
		it('by default there are no obvious redemptions', async () => {
			assert.equal(await instance.redemptions(ZERO_ADDRESS), '0');
		});
		describe('deprecate()', () => {
			it('may only be called by the Issuer', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: instance.deprecate,
					args: [rwa.address, parseEther('100')],
					address: this.mocks['Issuer'].address,
					accounts,
					reason: 'Restricted to Issuer contract',
				});
			});

			describe('when the rwa has some supply', () => {
				beforeEach(async () => {
					rwa.totalSupply.returns(parseEther('999'));
				});

				describe('when there is sufficient rUSD for the rwa to be deprecated', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('10000'));
					});

					describe('when successfully executed', () => {
						let txn;

						beforeEach(async () => {
							txn = await instance.deprecate(rwa.address, parseEther('10'), {
								from: this.mocks['Issuer'].address,
							});
						});
						it('updates the redemption with the supplied rate', async () => {
							assert.bnEqual(await instance.redemptions(rwa.address), parseEther('10'));
						});

						it('emits the correct event', async () => {
							assert.eventEqual(txn, 'RwaDeprecated', {
								rwa: rwa.address,
								rateToRedeem: parseEther('10'),
								totalRwaSupply: parseEther('999'),
								supplyInrUSD: parseEther('9990'),
							});
						});
					});
				});
			});

			it('reverts when the rate is 0', async () => {
				await assert.revert(
					instance.deprecate(rwa.address, '0', {
						from: this.mocks['Issuer'].address,
					}),
					'No rate for rwa to redeem'
				);
			});

			describe('when the rwa has some supply', () => {
				beforeEach(async () => {
					rwa.totalSupply.returns(parseEther('1000'));
				});

				it('deprecation fails when insufficient rUSD supply', async () => {
					await assert.revert(
						instance.deprecate(rwa.address, parseEther('1000'), {
							from: this.mocks['Issuer'].address,
						}),
						'rUSD must first be supplied'
					);
				});

				describe('when there is sufficient rUSD for the rwa to be deprecated', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
					});
					it('then deprecation succeeds', async () => {
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
				});
			});

			describe('when a rwa is deprecated', () => {
				beforeEach(async () => {
					await instance.deprecate(rwa.address, parseEther('100'), {
						from: this.mocks['Issuer'].address,
					});
				});
				it('then it cannot be deprecated again', async () => {
					await assert.revert(
						instance.deprecate(rwa.address, parseEther('5'), {
							from: this.mocks['Issuer'].address,
						}),
						'Rwa is already deprecated'
					);
				});
			});
		});
		describe('totalSupply()', () => {
			it('is 0 when no total supply of the underlying rwa', async () => {
				assert.equal(await instance.totalSupply(rwa.address), '0');
			});

			describe('when a rwa is deprecated', () => {
				beforeEach(async () => {
					await instance.deprecate(rwa.address, parseEther('100'), {
						from: this.mocks['Issuer'].address,
					});
				});
				it('total supply is still 0 as no total supply of the underlying rwa', async () => {
					assert.equal(await instance.totalSupply(rwa.address), '0');
				});
			});

			describe('when the rwa has some supply', () => {
				beforeEach(async () => {
					rwa.totalSupply.returns(parseEther('1000'));
				});
				it('then totalSupply returns 0 as there is no redemption rate', async () => {
					assert.equal(await instance.totalSupply(rwa.address), '0');
				});
				describe('when a rwa is deprecated', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
					it('total supply will be the rwa supply multiplied by the redemption rate', async () => {
						assert.bnEqual(await instance.totalSupply(rwa.address), parseEther('2000'));
					});
				});
			});
		});
		describe('balanceOf()', () => {
			it('is 0 when no balance of the underlying rwa', async () => {
				assert.equal(await instance.balanceOf(rwa.address, account1), '0');
			});

			describe('when a rwa is deprecated', () => {
				beforeEach(async () => {
					await instance.deprecate(rwa.address, parseEther('100'), {
						from: this.mocks['Issuer'].address,
					});
				});
				it('balance of is still 0 as no total supply of the underlying rwa', async () => {
					assert.equal(await instance.balanceOf(rwa.address, account1), '0');
				});
			});

			describe('when the rwa has some balance', () => {
				beforeEach(async () => {
					rwa.balanceOf.returns(parseEther('5'));
				});
				it('then balance of still returns 0 as there is no redemption rate', async () => {
					assert.equal(await instance.balanceOf(rwa.address, account1), '0');
				});
				describe('when a rwa is deprecated', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
					it('balance of will be the rwa supply multiplied by the redemption rate', async () => {
						assert.bnEqual(await instance.balanceOf(rwa.address, account1), parseEther('10'));
					});
				});
			});
		});
		describe('redemption', () => {
			describe('redeem()', () => {
				it('reverts when rwa not redeemable', async () => {
					await assert.revert(
						instance.redeem(rwa.address, {
							from: account1,
						}),
						'Rwa not redeemable'
					);
				});

				describe('when rwa marked for redemption', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
					it('redemption reverts when user has no balance', async () => {
						await assert.revert(
							instance.redeem(rwa.address, {
								from: account1,
							}),
							'No balance of rwa to redeem'
						);
					});
					describe('when the user has a rwa balance', () => {
						let userBalance;
						beforeEach(async () => {
							userBalance = parseEther('5');
							rwa.balanceOf.returns(userBalance);
						});
						describe('when redemption is called by the user', () => {
							let txn;
							beforeEach(async () => {
								txn = await instance.redeem(rwa.address, { from: account1 });
							});
							it('then Issuer.burnForRedemption is called with the correct arguments', async () => {
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls.length, 1);
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls[0][0], rwa.address);
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls[0][1], account1);
								assert.bnEqual(this.mocks['Issuer'].burnForRedemption.calls[0][2], userBalance);
							});
							it('transfers the correct amount of rUSD to the user', async () => {
								assert.equal(this.mocks['RwarUSD'].transfer.calls.length, 1);
								assert.equal(this.mocks['RwarUSD'].transfer.calls[0][0], account1);
								assert.bnEqual(
									this.mocks['RwarUSD'].transfer.calls[0][1],
									parseEther('10') // 5 units deprecated at price 2 is 10
								);
							});
							it('emitting a RwaRedeemed event', async () => {
								assert.eventEqual(txn, 'RwaRedeemed', {
									rwa: rwa.address,
									account: account1,
									amountOfRwa: userBalance,
									amountInrUSD: parseEther('10'),
								});
							});
						});
					});
				});
			});
			describe('redeemAll()', () => {
				it('reverts when neither rwas are redeemable', async () => {
					await assert.revert(
						instance.redeemAll([rwa.address, otherRwa.address], {
							from: account1,
						}),
						'Rwa not redeemable'
					);
				});

				describe('when a rwa marked for redemption', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
					});
					beforeEach(async () => {
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
					describe('when the user has a rwa balance for both rwas', () => {
						let userBalance;
						beforeEach(async () => {
							userBalance = parseEther('5');
							// both mocked with 5 units of balance each for the user
							rwa.balanceOf.returns(userBalance);
							otherRwa.balanceOf.returns(userBalance);
						});
						describe('when redeemAll is called by the user for both rwas', () => {
							it('reverts when one rwa not redeemable', async () => {
								await assert.revert(
									instance.redeemAll([rwa.address, otherRwa.address], {
										from: account1,
									}),
									'Rwa not redeemable'
								);
							});
							describe('when the other rwa is also deprecated', () => {
								beforeEach(async () => {
									await instance.deprecate(otherRwa.address, parseEther('2'), {
										from: this.mocks['Issuer'].address,
									});
								});

								describe('when redemption is called by the user', () => {
									beforeEach(async () => {
										await instance.redeemAll([rwa.address, otherRwa.address], {
											from: account1,
										});
									});
									[0, 1].forEach(i => {
										describe(`For rwa ${i}`, () => {
											it('then Issuer.burnForRedemption is called with the correct arguments', async () => {
												assert.equal(this.mocks['Issuer'].burnForRedemption.calls.length, 2);
												assert.equal(
													this.mocks['Issuer'].burnForRedemption.calls[i][0],
													[rwa.address, otherRwa.address][i]
												);
												assert.equal(this.mocks['Issuer'].burnForRedemption.calls[i][1], account1);
												assert.bnEqual(
													this.mocks['Issuer'].burnForRedemption.calls[i][2],
													userBalance
												);
											});
											it('transfers the correct amount of rUSD to the user', async () => {
												assert.equal(this.mocks['RwarUSD'].transfer.calls.length, 2);
												assert.equal(this.mocks['RwarUSD'].transfer.calls[i][0], account1);
												assert.bnEqual(
													this.mocks['RwarUSD'].transfer.calls[i][1],
													parseEther('10') // 5 units deprecated at price 2 is 10
												);
											});
										});
									});
								});
							});
						});
					});
				});
			});
			describe('redeemPartial()', () => {
				describe('when the user has a rwa balance', () => {
					beforeEach(async () => {
						rwa.balanceOf.returns(parseEther('1'));
					});
					it('reverts when rwa not redeemable', async () => {
						await assert.revert(
							instance.redeemPartial(rwa.address, parseEther('1'), {
								from: account1,
							}),
							'Rwa not redeemable'
						);
					});
				});

				describe('when rwa marked for redemption', () => {
					beforeEach(async () => {
						// smock rUSD balance to prevent the deprecation failing
						this.mocks['RwarUSD'].balanceOf.returns(parseEther('2000'));
						await instance.deprecate(rwa.address, parseEther('2'), {
							from: this.mocks['Issuer'].address,
						});
					});
					it('partial redemption reverts when user has no balance', async () => {
						await assert.revert(
							instance.redeemPartial(rwa.address, parseEther('1'), {
								from: account1,
							}),
							'Insufficient balance'
						);
					});
					describe('when the user has a rwa balance', () => {
						let userBalance;
						beforeEach(async () => {
							userBalance = parseEther('5');
							rwa.balanceOf.returns(userBalance);
						});
						describe('when partial redemption is called by the user', () => {
							let txn;
							beforeEach(async () => {
								txn = await instance.redeemPartial(rwa.address, parseEther('1'), {
									from: account1,
								});
							});
							it('then Issuer.burnForRedemption is called with the correct arguments', async () => {
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls.length, 1);
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls[0][0], rwa.address);
								assert.equal(this.mocks['Issuer'].burnForRedemption.calls[0][1], account1);
								assert.bnEqual(this.mocks['Issuer'].burnForRedemption.calls[0][2], parseEther('1'));
							});
							it('transfers the correct amount of rUSD to the user', async () => {
								assert.equal(this.mocks['RwarUSD'].transfer.calls.length, 1);
								assert.equal(this.mocks['RwarUSD'].transfer.calls[0][0], account1);
								assert.bnEqual(
									this.mocks['RwarUSD'].transfer.calls[0][1],
									parseEther('2') // 1 units deprecated at price 2 is 2
								);
							});
							it('emitting a RwaRedeemed event', async () => {
								assert.eventEqual(txn, 'RwaRedeemed', {
									rwa: rwa.address,
									account: account1,
									amountOfRwa: parseEther('1'),
									amountInrUSD: parseEther('2'),
								});
							});
						});
					});
				});
			});
		});
	});
});
