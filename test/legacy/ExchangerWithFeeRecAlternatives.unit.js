'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert } = require('../contracts/common');

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	getEventByName,
	buildMinimalProxyCode,
} = require('../contracts/helpers');

const { divideDecimal, multiplyDecimal, toUnit } = require('../utils')();

const { getUsers, toBytes32 } = require('../..');
const { toDecimal } = require('web3-utils');

const { toBN } = web3.utils;

let ExchangerWithFeeRecAlternatives;

contract('ExchangerWithFeeRecAlternatives (unit tests)', async accounts => {
	const [, owner] = accounts;
	const [rUSD, rETH, iETH] = ['rUSD', 'rETH', 'iETH'].map(toBytes32);
	const maxAtomicValuePerBlock = toUnit('1000000');
	const baseFeeRate = toUnit('0.003'); // 30bps
	const overrideFeeRate = toUnit('0.01'); // 100bps
	const amountIn = toUnit('100');

	// ensure all of the behaviors are bound to "this" for sharing test state
	const behaviors = require('./ExchangerWithFeeRecAlternatives.behaviors').call(this, {
		accounts,
	});

	const callAsRwaone = args => [...args, { from: this.mocks.Rwaone.address }];

	before(async () => {
		ExchangerWithFeeRecAlternatives = artifacts.require('ExchangerWithFeeRecAlternatives');
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: ExchangerWithFeeRecAlternatives.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: ['exchange', 'exchangeAtomically', 'settle'],
		});
	});

	describe('when a contract is instantiated', () => {
		behaviors.whenInstantiated({ owner }, () => {
			describe('atomicMaxVolumePerBlock()', () => {
				// Mimic setting not being configured
				behaviors.whenMockedWithUintSystemSetting(
					{ setting: 'atomicMaxVolumePerBlock', value: '0' },
					() => {
						it('is set to 0', async () => {
							assert.bnEqual(await this.instance.atomicMaxVolumePerBlock(), '0');
						});
					}
				);

				// With configured value
				behaviors.whenMockedWithUintSystemSetting(
					{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
					() => {
						it('is set to the configured value', async () => {
							assert.bnEqual(await this.instance.atomicMaxVolumePerBlock(), maxAtomicValuePerBlock);
						});
					}
				);
			});

			behaviors.whenMockedWithUintSystemSetting(
				{ setting: 'exchangeMaxDynamicFee', value: toUnit('1') },
				() => {
					describe('feeRateForAtomicExchange()', () => {
						// Mimic settings not being configured
						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'exchangeFeeRate', rwa: rETH, value: '0' },
							() => {
								it('is set to 0', async () => {
									assert.bnEqual(await this.instance.feeRateForAtomicExchange(rUSD, rETH), '0');
								});
							}
						);

						// With configured override value
						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', rwa: rETH, value: overrideFeeRate },
							() => {
								it('is set to the configured atomic override value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(rUSD, rETH),
										overrideFeeRate
									);
								});
							}
						);

						// With configured base and override values
						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'exchangeFeeRate', rwa: rETH, value: baseFeeRate },
							() => {
								it('is set to the configured base value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(rUSD, rETH),
										baseFeeRate
									);
								});

								behaviors.whenMockedWithRwaUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', rwa: rETH, value: overrideFeeRate },
									() => {
										it('is set to the configured atomic override value', async () => {
											assert.bnEqual(
												await this.instance.feeRateForAtomicExchange(rUSD, rETH),
												overrideFeeRate
											);
										});
									}
								);
							}
						);
					});
				}
			);

			describe('getAmountsForAtomicExchange()', () => {
				const atomicRate = toUnit('0.01');

				async function assertAmountsReported({ instance, amountIn, atomicRate, feeRate }) {
					const {
						amountReceived,
						fee,
						exchangeFeeRate,
					} = await instance.getAmountsForAtomicExchange(amountIn, rUSD, rETH);
					const expectedAmountReceivedWithoutFees = multiplyDecimal(amountIn, atomicRate);

					assert.bnEqual(amountReceived, expectedAmountReceivedWithoutFees.sub(fee));
					assert.bnEqual(exchangeFeeRate, feeRate);
					assert.bnEqual(multiplyDecimal(amountReceived.add(fee), exchangeFeeRate), fee);
				}

				behaviors.whenMockedEffectiveAtomicRateWithValue(
					{
						atomicRate,
						sourceCurrency: rUSD,
						// These system rates need to be supplied but are ignored in calculating the amount recieved
						systemSourceRate: toUnit('1'),
						systemDestinationRate: toUnit('1'),
					},
					() => {
						// No fees
						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'exchangeFeeRate', rwa: rETH, value: '0' },
							() => {
								it('gives exact amounts when no fees are configured', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: '0',
										instance: this.instance,
									});
								});
							}
						);

						// With fees
						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'exchangeFeeRate', rwa: rETH, value: baseFeeRate },
							() => {
								it('gives amounts with base fee', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: baseFeeRate,
										instance: this.instance,
									});
								});

								behaviors.whenMockedWithRwaUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', rwa: rETH, value: overrideFeeRate },
									() => {
										it('gives amounts with atomic override fee', async () => {
											await assertAmountsReported({
												amountIn,
												atomicRate,
												feeRate: overrideFeeRate,
												instance: this.instance,
											});
										});
									}
								);
							}
						);

						behaviors.whenMockedWithRwaUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', rwa: rETH, value: overrideFeeRate },
							() => {
								it('gives amounts with atomic override fee', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: overrideFeeRate,
										instance: this.instance,
									});
								});
							}
						);
					}
				);
			});

			describe('exchanging', () => {
				describe('exchange with virtual rwas', () => {
					const sourceCurrency = rUSD;
					const destinationCurrency = rETH;

					const getExchangeArgs = ({
						from = owner,
						sourceCurrencyKey = sourceCurrency,
						sourceAmount = amountIn,
						destinationCurrencyKey = destinationCurrency,
						destinationAddress = owner,
						trackingCode = toBytes32(),
						asRwaone = true,
					} = {}) => {
						const args = [
							from, // exchangeForAddress
							from, // from
							sourceCurrencyKey,
							sourceAmount,
							destinationCurrencyKey,
							destinationAddress,
							true, // virtualRwa
							from, // rewardAddress
							trackingCode,
						];

						return asRwaone ? callAsRwaone(args) : args;
					};

					describe('failure modes', () => {
						behaviors.whenMockedWithExchangeRatesValidityAtRound({ valid: false }, () => {
							it('reverts when either rate is invalid', async () => {
								await assert.revert(
									this.instance.exchange(...getExchangeArgs()),
									'rate stale or flagged'
								);
							});
						});

						behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
							behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
								behaviors.whenMockedWithUintSystemSetting(
									{ setting: 'waitingPeriodSecs', value: '0' },
									() => {
										behaviors.whenMockedEffectiveRateAsEqualAtRound(() => {
											behaviors.whenMockedLastNRates(() => {
												behaviors.whenMockedASingleRwaToIssueAndBurn(() => {
													behaviors.whenMockedExchangeStatePersistance(() => {
														it('it reverts trying to create a virtual rwa with no supply', async () => {
															await assert.revert(
																this.instance.exchange(...getExchangeArgs({ sourceAmount: '0' })),
																'Zero amount'
															);
														});
														it('it reverts trying to virtualize into an inverse rwa', async () => {
															await assert.revert(
																this.instance.exchange(
																	...getExchangeArgs({
																		sourceCurrencyKey: rUSD,
																		destinationCurrencyKey: iETH,
																	})
																),
																'Cannot virtualize this rwa'
															);
														});
													});
												});
											});
										});
									}
								);
							});
						});
					});

					behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
						behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
							behaviors.whenMockedWithUintSystemSetting(
								{ setting: 'waitingPeriodSecs', value: '0' },
								() => {
									behaviors.whenMockedEffectiveRateAsEqualAtRound(() => {
										behaviors.whenMockedLastNRates(() => {
											behaviors.whenMockedASingleRwaToIssueAndBurn(() => {
												behaviors.whenMockedExchangeStatePersistance(() => {
													describe('when invoked', () => {
														let txn;
														beforeEach(async () => {
															txn = await this.instance.exchange(...getExchangeArgs());
														});
														it('emits a VirtualRwaCreated event with the correct underlying rwa and amount', async () => {
															assert.eventEqual(txn, 'VirtualRwaCreated', {
																rwa: this.mocks.rwa.proxy.will.returnValue,
																currencyKey: rETH,
																amount: amountIn,
																recipient: owner,
															});
														});
														describe('when interrogating the Virtual Rwas', () => {
															let vRwa;
															beforeEach(async () => {
																const VirtualRwa = artifacts.require('VirtualRwa');
																vRwa = await VirtualRwa.at(
																	getEventByName({ tx: txn, name: 'VirtualRwaCreated' }).args
																		.vRwa
																);
															});
															it('the vRwa has the correct rwa', async () => {
																assert.equal(
																	await vRwa.rwa(),
																	this.mocks.rwa.proxy.will.returnValue
																);
															});
															it('the vRwa has the correct resolver', async () => {
																assert.equal(await vRwa.resolver(), this.resolver.address);
															});
															it('the vRwa has minted the correct amount to the user', async () => {
																assert.bnEqual(await vRwa.totalSupply(), amountIn);
																assert.bnEqual(await vRwa.balanceOf(owner), amountIn);
															});
															it('and the rwa has been issued to the vRwa', async () => {
																assert.equal(this.mocks.rwa.issue.calls[0][0], vRwa.address);
																assert.bnEqual(this.mocks.rwa.issue.calls[0][1], amountIn);
															});
															it('the vRwa is an ERC-1167 minimal proxy instead of a full Virtual Rwa', async () => {
																const vRwaCode = await web3.eth.getCode(vRwa.address);
																assert.equal(
																	vRwaCode,
																	buildMinimalProxyCode(this.mocks.VirtualRwaMastercopy.address)
																);
															});
														});
													});
												});
											});
										});
									});
								}
							);
						});
					});
				});

				describe('exchange atomically', () => {
					const sourceCurrency = rUSD;
					const destinationCurrency = rETH;

					const getExchangeArgs = ({
						from = owner,
						sourceCurrencyKey = sourceCurrency,
						sourceAmount = amountIn,
						destinationCurrencyKey = destinationCurrency,
						destinationAddress = owner,
						trackingCode = toBytes32(),
						asRwaone = true,
						minAmount = toDecimal(0),
					} = {}) => {
						const args = [
							from,
							sourceCurrencyKey,
							sourceAmount,
							destinationCurrencyKey,
							destinationAddress,
							trackingCode,
							minAmount,
						];

						return asRwaone ? callAsRwaone(args) : args;
					};

					describe('when called by unauthorized', async () => {
						behaviors.whenMockedToAllowExchangeInvocationChecks(() => {
							it('it reverts when called by regular accounts', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: this.instance.exchangeAtomically,
									args: getExchangeArgs({ asRwaone: false }),
									accounts: accounts.filter(a => a !== this.mocks.Rwaone.address),
									reason: 'Exchanger: Only rwaone or a rwa contract can perform this action',
									// address: this.mocks.Rwaone.address (doesnt work as this reverts due to lack of mocking setup)
								});
							});
						});
					});

					describe('when not exchangeable', () => {
						it('reverts when src and dest are the same', async () => {
							const args = getExchangeArgs({
								sourceCurrencyKey: rUSD,
								destinationCurrencyKey: rUSD,
							});
							await assert.revert(this.instance.exchangeAtomically(...args), "Can't be same rwa");
						});

						it('reverts when input amount is zero', async () => {
							const args = getExchangeArgs({ sourceAmount: '0' });
							await assert.revert(this.instance.exchangeAtomically(...args), 'Zero amount');
						});

						// Invalid system rates
						behaviors.whenMockedWithExchangeRatesValidity({ valid: false }, () => {
							it('reverts when either rate is invalid', async () => {
								await assert.revert(
									this.instance.exchangeAtomically(...getExchangeArgs()),
									'rate stale or flagged'
								);
							});
						});

						behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
							behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
								const lastRate = toUnit('1');
								behaviors.whenMockedEntireExchangeRateConfiguration(
									{
										sourceCurrency,
										atomicRate: lastRate,
										systemSourceRate: lastRate,
										systemDestinationRate: lastRate,
									},
									() => {
										behaviors.whenMockedWithVolatileRwa({ rwa: rETH, volatile: true }, () => {
											describe('when rwa pricing is deemed volatile', () => {
												it('reverts due to src volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: rETH,
														destinationCurrencyKey: rUSD,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Src rwa too volatile'
													);
												});
												it('reverts due to dest volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: rUSD,
														destinationCurrencyKey: rETH,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Dest rwa too volatile'
													);
												});
											});
										});

										describe('when max volume limit (0) is surpassed', () => {
											it('reverts due to surpassed volume limit', async () => {
												const args = getExchangeArgs({ sourceAmount: toUnit('1') });
												await assert.revert(
													this.instance.exchangeAtomically(...args),
													'Surpassed volume limit'
												);
											});
										});

										behaviors.whenMockedWithUintSystemSetting(
											{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
											() => {
												describe(`when max volume limit (>0) is surpassed`, () => {
													const aboveVolumeLimit = maxAtomicValuePerBlock.add(toBN('1'));
													it('reverts due to surpassed volume limit', async () => {
														const args = getExchangeArgs({ sourceAmount: aboveVolumeLimit });
														await assert.revert(
															this.instance.exchangeAtomically(...args),
															'Surpassed volume limit'
														);
													});
												});
											}
										);
									}
								);
							});
						});
					});

					describe('when exchange rates hit circuit breakers', () => {
						behaviors.whenMockedRusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
								behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
									behaviors.whenMockedWithRwaUintSystemSetting(
										{ setting: 'exchangeFeeRate', rwa: rETH, value: '0' },
										() => {
											const lastRate = toUnit('10');
											const badRate = lastRate.mul(toBN(10)); // should hit deviation factor of 5x

											// Source rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency: rUSD,
													atomicRate: lastRate,
													systemSourceRate: badRate,
													systemDestinationRate: lastRate,
												},
												() => {
													behaviors.whenMockedWithUintSystemSetting(
														{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
														() => {
															beforeEach('attempt exchange', async () => {
																this.mocks.ExchangeRates.rateWithSafetyChecks.returns(currencyKey =>
																	currencyKey === rETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: rUSD,
																		destinationCurrency: rETH,
																	})
																);
															});
															it('did not issue or burn rwas', async () => {
																assert.equal(this.mocks.rUSD.issue.calls.length, 0);
																assert.equal(this.mocks.rETH.issue.calls.length, 0);
																assert.equal(this.mocks.rUSD.burn.calls.length, 0);
																assert.equal(this.mocks.rETH.burn.calls.length, 0);
															});
														}
													);
												}
											);

											// Dest rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency: rETH,
													atomicRate: lastRate,
													systemSourceRate: lastRate,
													systemDestinationRate: badRate,
												},
												() => {
													behaviors.whenMockedWithUintSystemSetting(
														{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
														() => {
															beforeEach('attempt exchange', async () => {
																this.mocks.ExchangeRates.rateWithSafetyChecks.returns(currencyKey =>
																	currencyKey === rETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: rETH,
																		destinationCurrency: rUSD,
																	})
																);
															});
															it('did not issue or burn rwas', async () => {
																assert.equal(this.mocks.rUSD.issue.calls.length, 0);
																assert.equal(this.mocks.rETH.issue.calls.length, 0);
																assert.equal(this.mocks.rUSD.burn.calls.length, 0);
																assert.equal(this.mocks.rETH.burn.calls.length, 0);
															});
														}
													);
												}
											);

											// Atomic rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency,
													atomicRate: badRate,
													systemSourceRate: lastRate,
													systemDestinationRate: lastRate,
												},
												() => {
													it('reverts exchange', async () => {
														this.flexibleStorageMock.mockSystemSetting({
															setting: 'atomicMaxVolumePerBlock',
															value: maxAtomicValuePerBlock,
															type: 'uint',
														});
														this.mocks.CircuitBreaker.isDeviationAboveThreshold.returns(true);
														await assert.revert(
															this.instance.exchangeAtomically(...getExchangeArgs()),
															'Atomic rate deviates too much'
														);
													});
												}
											);
										}
									);
								});
							});
						});
					});

					describe('when atomic exchange occurs (rUSD -> rETH)', () => {
						const unit = toUnit('1');
						const lastUsdRate = unit;
						const lastEthRate = toUnit('100'); // 1 ETH -> 100 USD

						behaviors.whenMockedRusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedFeePool(() => {
								behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
									behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
										behaviors.whenMockedEntireExchangeRateConfiguration(
											{
												sourceCurrency,

												// we are always trading rUSD -> rETH
												atomicRate: lastEthRate,
												systemSourceRate: unit,
												systemDestinationRate: lastEthRate,
											},
											() => {
												behaviors.whenMockedWithUintSystemSetting(
													{ setting: 'exchangeMaxDynamicFee', value: toUnit('1') },
													() => {
														behaviors.whenMockedWithUintSystemSetting(
															{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
															() => {
																const itExchangesCorrectly = ({
																	exchangeFeeRate,
																	setAsOverrideRate,
																	tradingRewardsEnabled,
																	trackingCode,
																}) => {
																	behaviors.whenMockedWithBoolSystemSetting(
																		{
																			setting: 'tradingRewardsEnabled',
																			value: !!tradingRewardsEnabled,
																		},
																		() => {
																			behaviors.whenMockedWithRwaUintSystemSetting(
																				{
																					setting: setAsOverrideRate
																						? 'atomicExchangeFeeRate'
																						: 'exchangeFeeRate',
																					rwa: rETH,
																					value: exchangeFeeRate,
																				},
																				() => {
																					let expectedAmountReceived;
																					let expectedFee;
																					beforeEach('attempt exchange', async () => {
																						expectedFee = multiplyDecimal(
																							amountIn,
																							exchangeFeeRate
																						);
																						expectedAmountReceived = divideDecimal(
																							amountIn.sub(expectedFee),
																							lastEthRate
																						);

																						await this.instance.exchangeAtomically(
																							...getExchangeArgs({
																								trackingCode,
																							})
																						);
																					});
																					it('burned correct amount of rUSD', () => {
																						assert.equal(this.mocks.rUSD.burn.calls[0][0], owner);
																						assert.bnEqual(
																							this.mocks.rUSD.burn.calls[0][1],
																							amountIn
																						);
																					});
																					it('issued correct amount of rETH', () => {
																						assert.equal(this.mocks.rETH.issue.calls[0][0], owner);
																						assert.bnEqual(
																							this.mocks.rETH.issue.calls[0][1],
																							expectedAmountReceived
																						);
																					});
																					it('tracked atomic volume', async () => {
																						assert.bnEqual(
																							(await this.instance.lastAtomicVolume()).volume,
																							amountIn
																						);
																					});
																					it('updated debt cache', () => {
																						const debtCacheUpdateCall = this.mocks.DebtCache
																							.updateCachedRwaDebtsWithRates;
																						assert.deepEqual(debtCacheUpdateCall.calls[0][0], [
																							rUSD,
																							rETH,
																						]);
																						assert.deepEqual(debtCacheUpdateCall.calls[0][1], [
																							lastUsdRate,
																							lastEthRate,
																						]);
																					});
																					it('asked Rwaone to emit an exchange event', () => {
																						const rwaoneEmitExchangeCall = this.mocks.Rwaone
																							.emitRwaExchange;
																						assert.equal(
																							rwaoneEmitExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							rwaoneEmitExchangeCall.calls[0][1],
																							rUSD
																						);
																						assert.bnEqual(
																							rwaoneEmitExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							rwaoneEmitExchangeCall.calls[0][3],
																							rETH
																						);
																						assert.bnEqual(
																							rwaoneEmitExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							rwaoneEmitExchangeCall.calls[0][5],
																							owner
																						);
																					});
																					it('asked Rwaone to emit an atomic exchange event', () => {
																						const rwaoneEmitAtomicExchangeCall = this.mocks
																							.Rwaone.emitAtomicRwaExchange;
																						assert.equal(
																							rwaoneEmitAtomicExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							rwaoneEmitAtomicExchangeCall.calls[0][1],
																							rUSD
																						);
																						assert.bnEqual(
																							rwaoneEmitAtomicExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							rwaoneEmitAtomicExchangeCall.calls[0][3],
																							rETH
																						);
																						assert.bnEqual(
																							rwaoneEmitAtomicExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							rwaoneEmitAtomicExchangeCall.calls[0][5],
																							owner
																						);
																					});
																					it('did not add any fee reclamation entries to exchange state', () => {
																						assert.equal(
																							this.mocks.ExchangeState.appendExchangeEntry.calls
																								.length,
																							0
																						);
																					});

																					// Conditional based on test settings
																					if (toBN(exchangeFeeRate).isZero()) {
																						it('did not report a fee', () => {
																							assert.equal(
																								this.mocks.FeePool.recordFeePaid.calls.length,
																								0
																							);
																						});
																					} else {
																						it('remitted correct fee to fee pool', () => {
																							assert.equal(
																								this.mocks.rUSD.issue.calls[0][0],
																								getUsers({ network: 'mainnet', user: 'fee' })
																									.address
																							);
																							assert.bnEqual(
																								this.mocks.rUSD.issue.calls[0][1],
																								expectedFee
																							);
																							assert.bnEqual(
																								this.mocks.FeePool.recordFeePaid.calls[0],
																								expectedFee
																							);
																						});
																					}
																					if (!tradingRewardsEnabled) {
																						it('did not report trading rewards', () => {
																							assert.equal(
																								this.mocks.TradingRewards
																									.recordExchangeFeeForAccount.calls.length,
																								0
																							);
																						});
																					} else {
																						it('reported trading rewards', () => {
																							const trRecordCall = this.mocks.TradingRewards
																								.recordExchangeFeeForAccount;
																							assert.bnEqual(trRecordCall.calls[0][0], expectedFee);
																							assert.equal(trRecordCall.calls[0][1], owner);
																						});
																					}
																					if (!trackingCode) {
																						it('did not ask Rwaone to emit tracking event', () => {
																							assert.equal(
																								this.mocks.Rwaone.emitExchangeTracking.calls
																									.length,
																								0
																							);
																						});
																					} else {
																						it('asked Rwaone to emit tracking event', () => {
																							const rwaoneEmitTrackingCall = this.mocks.Rwaone
																								.emitExchangeTracking;
																							assert.equal(
																								rwaoneEmitTrackingCall.calls[0][0],
																								trackingCode
																							);
																						});
																					}
																				}
																			);
																		}
																	);
																};

																describe('when no exchange fees are configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: '0',
																	});
																});

																describe('with tracking code', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: '0',
																		trackingCode: toBytes32('TRACKING'),
																	});
																});

																describe('when an exchange fee is configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: baseFeeRate,
																		tradingRewardsEnabled: true,
																	});
																});
																describe('when an exchange fee override for atomic exchanges is configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: overrideFeeRate,
																		setAsOverrideRate: true,
																		tradingRewardsEnabled: true,
																	});
																});
															}
														);
													}
												);
											}
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
});
