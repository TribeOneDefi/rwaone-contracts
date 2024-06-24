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
	const [rUSD, hETH, iETH] = ['rUSD', 'hETH', 'iETH'].map(toBytes32);
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
						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'exchangeFeeRate', tribe: hETH, value: '0' },
							() => {
								it('is set to 0', async () => {
									assert.bnEqual(await this.instance.feeRateForAtomicExchange(rUSD, hETH), '0');
								});
							}
						);

						// With configured override value
						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', tribe: hETH, value: overrideFeeRate },
							() => {
								it('is set to the configured atomic override value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(rUSD, hETH),
										overrideFeeRate
									);
								});
							}
						);

						// With configured base and override values
						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'exchangeFeeRate', tribe: hETH, value: baseFeeRate },
							() => {
								it('is set to the configured base value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(rUSD, hETH),
										baseFeeRate
									);
								});

								behaviors.whenMockedWithTribeUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', tribe: hETH, value: overrideFeeRate },
									() => {
										it('is set to the configured atomic override value', async () => {
											assert.bnEqual(
												await this.instance.feeRateForAtomicExchange(rUSD, hETH),
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
					} = await instance.getAmountsForAtomicExchange(amountIn, rUSD, hETH);
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
						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'exchangeFeeRate', tribe: hETH, value: '0' },
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
						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'exchangeFeeRate', tribe: hETH, value: baseFeeRate },
							() => {
								it('gives amounts with base fee', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: baseFeeRate,
										instance: this.instance,
									});
								});

								behaviors.whenMockedWithTribeUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', tribe: hETH, value: overrideFeeRate },
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

						behaviors.whenMockedWithTribeUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', tribe: hETH, value: overrideFeeRate },
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
				describe('exchange with virtual tribes', () => {
					const sourceCurrency = rUSD;
					const destinationCurrency = hETH;

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
							true, // virtualTribe
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
												behaviors.whenMockedASingleTribeToIssueAndBurn(() => {
													behaviors.whenMockedExchangeStatePersistance(() => {
														it('it reverts trying to create a virtual tribe with no supply', async () => {
															await assert.revert(
																this.instance.exchange(...getExchangeArgs({ sourceAmount: '0' })),
																'Zero amount'
															);
														});
														it('it reverts trying to virtualize into an inverse tribe', async () => {
															await assert.revert(
																this.instance.exchange(
																	...getExchangeArgs({
																		sourceCurrencyKey: rUSD,
																		destinationCurrencyKey: iETH,
																	})
																),
																'Cannot virtualize this tribe'
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
											behaviors.whenMockedASingleTribeToIssueAndBurn(() => {
												behaviors.whenMockedExchangeStatePersistance(() => {
													describe('when invoked', () => {
														let txn;
														beforeEach(async () => {
															txn = await this.instance.exchange(...getExchangeArgs());
														});
														it('emits a VirtualTribeCreated event with the correct underlying tribe and amount', async () => {
															assert.eventEqual(txn, 'VirtualTribeCreated', {
																tribe: this.mocks.tribe.proxy.will.returnValue,
																currencyKey: hETH,
																amount: amountIn,
																recipient: owner,
															});
														});
														describe('when interrogating the Virtual Tribes', () => {
															let vTribe;
															beforeEach(async () => {
																const VirtualTribe = artifacts.require('VirtualTribe');
																vTribe = await VirtualTribe.at(
																	getEventByName({ tx: txn, name: 'VirtualTribeCreated' }).args
																		.vTribe
																);
															});
															it('the vTribe has the correct tribe', async () => {
																assert.equal(
																	await vTribe.tribe(),
																	this.mocks.tribe.proxy.will.returnValue
																);
															});
															it('the vTribe has the correct resolver', async () => {
																assert.equal(await vTribe.resolver(), this.resolver.address);
															});
															it('the vTribe has minted the correct amount to the user', async () => {
																assert.bnEqual(await vTribe.totalSupply(), amountIn);
																assert.bnEqual(await vTribe.balanceOf(owner), amountIn);
															});
															it('and the tribe has been issued to the vTribe', async () => {
																assert.equal(this.mocks.tribe.issue.calls[0][0], vTribe.address);
																assert.bnEqual(this.mocks.tribe.issue.calls[0][1], amountIn);
															});
															it('the vTribe is an ERC-1167 minimal proxy instead of a full Virtual Tribe', async () => {
																const vTribeCode = await web3.eth.getCode(vTribe.address);
																assert.equal(
																	vTribeCode,
																	buildMinimalProxyCode(this.mocks.VirtualTribeMastercopy.address)
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
					const destinationCurrency = hETH;

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
									reason: 'Exchanger: Only rwaone or a tribe contract can perform this action',
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
							await assert.revert(this.instance.exchangeAtomically(...args), "Can't be same tribe");
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
										behaviors.whenMockedWithVolatileTribe({ tribe: hETH, volatile: true }, () => {
											describe('when tribe pricing is deemed volatile', () => {
												it('reverts due to src volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: hETH,
														destinationCurrencyKey: rUSD,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Src tribe too volatile'
													);
												});
												it('reverts due to dest volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: rUSD,
														destinationCurrencyKey: hETH,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Dest tribe too volatile'
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
						behaviors.whenMockedSusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
								behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
									behaviors.whenMockedWithTribeUintSystemSetting(
										{ setting: 'exchangeFeeRate', tribe: hETH, value: '0' },
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
																	currencyKey === hETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: rUSD,
																		destinationCurrency: hETH,
																	})
																);
															});
															it('did not issue or burn tribes', async () => {
																assert.equal(this.mocks.rUSD.issue.calls.length, 0);
																assert.equal(this.mocks.hETH.issue.calls.length, 0);
																assert.equal(this.mocks.rUSD.burn.calls.length, 0);
																assert.equal(this.mocks.hETH.burn.calls.length, 0);
															});
														}
													);
												}
											);

											// Dest rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency: hETH,
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
																	currencyKey === hETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: hETH,
																		destinationCurrency: rUSD,
																	})
																);
															});
															it('did not issue or burn tribes', async () => {
																assert.equal(this.mocks.rUSD.issue.calls.length, 0);
																assert.equal(this.mocks.hETH.issue.calls.length, 0);
																assert.equal(this.mocks.rUSD.burn.calls.length, 0);
																assert.equal(this.mocks.hETH.burn.calls.length, 0);
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

					describe('when atomic exchange occurs (rUSD -> hETH)', () => {
						const unit = toUnit('1');
						const lastUsdRate = unit;
						const lastEthRate = toUnit('100'); // 1 ETH -> 100 USD

						behaviors.whenMockedSusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedFeePool(() => {
								behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
									behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
										behaviors.whenMockedEntireExchangeRateConfiguration(
											{
												sourceCurrency,

												// we are always trading rUSD -> hETH
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
																			behaviors.whenMockedWithTribeUintSystemSetting(
																				{
																					setting: setAsOverrideRate
																						? 'atomicExchangeFeeRate'
																						: 'exchangeFeeRate',
																					tribe: hETH,
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
																					it('issued correct amount of hETH', () => {
																						assert.equal(this.mocks.hETH.issue.calls[0][0], owner);
																						assert.bnEqual(
																							this.mocks.hETH.issue.calls[0][1],
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
																							.updateCachedTribeDebtsWithRates;
																						assert.deepEqual(debtCacheUpdateCall.calls[0][0], [
																							rUSD,
																							hETH,
																						]);
																						assert.deepEqual(debtCacheUpdateCall.calls[0][1], [
																							lastUsdRate,
																							lastEthRate,
																						]);
																					});
																					it('asked Rwaone to emit an exchange event', () => {
																						const tribeetixEmitExchangeCall = this.mocks.Rwaone
																							.emitTribeExchange;
																						assert.equal(
																							tribeetixEmitExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							tribeetixEmitExchangeCall.calls[0][1],
																							rUSD
																						);
																						assert.bnEqual(
																							tribeetixEmitExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							tribeetixEmitExchangeCall.calls[0][3],
																							hETH
																						);
																						assert.bnEqual(
																							tribeetixEmitExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							tribeetixEmitExchangeCall.calls[0][5],
																							owner
																						);
																					});
																					it('asked Rwaone to emit an atomic exchange event', () => {
																						const tribeetixEmitAtomicExchangeCall = this.mocks
																							.Rwaone.emitAtomicTribeExchange;
																						assert.equal(
																							tribeetixEmitAtomicExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							tribeetixEmitAtomicExchangeCall.calls[0][1],
																							rUSD
																						);
																						assert.bnEqual(
																							tribeetixEmitAtomicExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							tribeetixEmitAtomicExchangeCall.calls[0][3],
																							hETH
																						);
																						assert.bnEqual(
																							tribeetixEmitAtomicExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							tribeetixEmitAtomicExchangeCall.calls[0][5],
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
																							const tribeetixEmitTrackingCall = this.mocks.Rwaone
																								.emitExchangeTracking;
																							assert.equal(
																								tribeetixEmitTrackingCall.calls[0][0],
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
