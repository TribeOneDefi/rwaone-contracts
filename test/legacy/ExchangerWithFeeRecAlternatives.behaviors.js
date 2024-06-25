'use strict';

const { artifacts, web3 } = require('hardhat');
const { smock } = require('@defi-wonderland/smock');
const { prepareSmocks, prepareFlexibleStorageSmock } = require('../contracts/helpers');
const { divideDecimal, multiplyDecimal } = require('../utils')();
const {
	getUsers,
	fromBytes32,
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const [rUSD, rETH] = ['rUSD', 'rETH'].map(toBytes32);

let ExchangerWithFeeRecAlternatives;
let DirectIntegrationManager;

module.exports = function ({ accounts }) {
	before(async () => {
		ExchangerWithFeeRecAlternatives = artifacts.require('ExchangerWithFeeRecAlternatives');
		DirectIntegrationManager = artifacts.require('DirectIntegrationManager');
	});

	before(async () => {
		const safeDecimalMath = await artifacts.require('SafeDecimalMath').new();
		const ExchangeSettlementLib = artifacts.require('ExchangeSettlementLib');
		ExchangeSettlementLib.link(safeDecimalMath);

		ExchangerWithFeeRecAlternatives.link(safeDecimalMath);
		ExchangerWithFeeRecAlternatives.link(await ExchangeSettlementLib.new());
	});

	beforeEach(async () => {
		const VirtualRwaMastercopy = artifacts.require('VirtualRwaMastercopy');

		({ mocks: this.mocks, resolver: this.resolver } = await prepareSmocks({
			contracts: [
				'CircuitBreaker',
				'DebtCache',
				'DelegateApprovals',
				'ExchangeRates',
				'ExchangeCircuitBreaker',
				'ExchangeState',
				'FeePool',
				'FlexibleStorage',
				'Issuer',
				'Rwaone',
				'SystemStatus',
				'TradingRewards',
			],
			mocks: {
				// Use a real VirtualRwaMastercopy so the unit tests can interrogate deployed vRwas
				VirtualRwaMastercopy: await VirtualRwaMastercopy.new(),
			},
			accounts: accounts.slice(10), // mock using accounts after the first few
		}));

		this.flexibleStorageMock = prepareFlexibleStorageSmock(this.mocks.FlexibleStorage);
	});

	const mockEffectiveAtomicRate = ({
		sourceCurrency,
		atomicRate,
		systemSourceRate,
		systemDestinationRate,
	}) => {
		this.mocks.ExchangeRates[
			'effectiveAtomicValueAndRates((bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256,(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),(bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))'
		].returns((srcKey, amount, destKey) => {
			amount = amount.toString(); // seems to be passed to smock as a number

			// For ease of comparison when mocking, atomicRate is specified in the
			// same direction as systemDestinationRate
			const atomicValue =
				srcKey[0] === sourceCurrency
					? divideDecimal(amount, atomicRate)
					: multiplyDecimal(amount, atomicRate);

			const [sourceRate, destinationRate] =
				srcKey[0] === sourceCurrency
					? [systemSourceRate, systemDestinationRate]
					: [systemDestinationRate, systemSourceRate];
			const systemValue = divideDecimal(multiplyDecimal(amount, sourceRate), destinationRate);

			return [
				atomicValue, // value
				systemValue, // systemValue
				systemSourceRate, // systemSourceRate
				systemDestinationRate, // systemDestinationRate
			].map(bn => bn.toString());
		});
	};

	return {
		whenInstantiated: ({ owner }, cb) => {
			describe(`when instantiated`, () => {
				beforeEach(async () => {
					// have to put this extra mock at the end
					this.directIntegrationManager = await DirectIntegrationManager.new(
						owner,
						this.resolver.address
					);

					// we can just side effect the mock into our address resolver. convenient!
					this.mocks.DirectIntegrationManager = this.directIntegrationManager;
					await this.directIntegrationManager.rebuildCache();

					this.instance = await ExchangerWithFeeRecAlternatives.new(owner, this.resolver.address);
					this.directIntegrationInstance = await DirectIntegrationManager.new(
						owner,
						this.resolver.address
					);
					await this.instance.rebuildCache();
				});
				cb();
			});
		},
		whenMockedToAllowExchangeInvocationChecks: cb => {
			describe(`when mocked to allow invocation checks`, () => {
				beforeEach(async () => {
					this.mocks.Rwaone.rwasByAddress.returns(toBytes32());
				});
				cb();
			});
		},
		whenMockedWithExchangeRatesValidity: ({ valid = true }, cb) => {
			describe(`when mocked with ${valid ? 'valid' : 'invalid'} exchange rates`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.rateWithSafetyChecks.returns([0, false, !valid]);
				});
				cb();
			});
		},
		whenMockedWithExchangeRatesValidityAtRound: ({ valid = true }, cb) => {
			describe(`when mocked with ${valid ? 'valid' : 'invalid'} exchange rates`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.anyRateIsInvalidAtRound.returns(!valid);
				});
				cb();
			});
		},
		whenMockedWithNoPriorExchangesToSettle: cb => {
			describe(`when mocked with no prior exchanges to settle`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeState.getMaxTimestamp.returns('0');
					this.mocks.ExchangeState.getLengthOfEntries.returns('0');
				});
				cb();
			});
		},
		whenMockedWithBoolSystemSetting: ({ setting, value }, cb) => {
			describe(`when SystemSetting.${setting} is mocked to ${value}`, () => {
				beforeEach(async () => {
					this.flexibleStorageMock.mockSystemSetting({ setting, value, type: 'bool' });
				});
				cb();
			});
		},
		whenMockedWithUintSystemSetting: ({ setting, value }, cb) => {
			describe(`when SystemSetting.${setting} is mocked to ${value}`, () => {
				beforeEach(async () => {
					this.flexibleStorageMock.mockSystemSetting({ setting, value, type: 'uint' });
				});
				cb();
			});
		},
		whenMockedWithUintsSystemSetting: ({ setting, value }, cb) => {
			describe(`when SystemSetting.${setting} is mocked to ${value}`, () => {
				beforeEach(async () => {
					this.flexibleStorageMock.mockSystemSetting({ setting, value, type: 'uints' });
				});
				cb();
			});
		},
		whenMockedWithRwaUintSystemSetting: ({ setting, rwa, value }, cb) => {
			const settingForRwa = web3.utils.soliditySha3(
				{ type: 'bytes32', value: toBytes32(setting) },
				{ type: 'bytes32', value: rwa }
			);
			const rwaName = fromBytes32(rwa);
			describe(`when SystemSetting.${setting} for ${rwaName} is mocked to ${value}`, () => {
				beforeEach(async () => {
					this.flexibleStorageMock.mockSystemSetting({
						value,
						setting: settingForRwa,
						type: 'uint',
					});
				});
				cb();
			});
		},
		whenMockedEffectiveRateAsEqual: cb => {
			describe(`when mocked with exchange rates giving an effective value of 1:1`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.effectiveValueAndRates.returns((srcKey, amount, destKey) => [
						amount,
						(1e18).toString(),
						(1e18).toString(),
					]);
				});
				cb();
			});
		},
		whenMockedEffectiveRateAsEqualAtRound: cb => {
			describe(`when mocked with exchange rates giving an effective value of 1:1`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.effectiveValueAndRatesAtRound.returns(
						(srcKey, amount, destKey) => [amount, (1e18).toString(), (1e18).toString()]
					);
				});
				cb();
			});
		},
		whenMockedLastNRates: cb => {
			describe(`when mocked 1e18 as last n rates`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.ratesAndUpdatedTimeForCurrencyLastNRounds.returns([[], []]);
				});
				cb();
			});
		},
		whenMockedEffectiveAtomicRateWithValue: (
			{ sourceCurrency, atomicRate, systemSourceRate, systemDestinationRate },
			cb
		) => {
			describe(`when mocked with atomic rate ${atomicRate}, src rate ${systemSourceRate}, dest rate ${systemDestinationRate}`, () => {
				beforeEach(async () => {
					mockEffectiveAtomicRate({
						sourceCurrency,
						atomicRate,
						systemSourceRate,
						systemDestinationRate,
					});
				});
			});
		},
		whenMockedWithVolatileRwa: ({ rwa, volatile }, cb) => {
			describe(`when mocked with ${fromBytes32(rwa)} deemed ${volatile ? 'volatile' : 'not volatile'
				}`, () => {
					beforeEach(async () => {
						this.mocks.ExchangeRates[
							'rwaTooVolatileForAtomicExchange((bytes32,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))'
						].returns(rwaToCheck => (rwaToCheck === rwa ? volatile : false));
					});
				});
		},
		whenMockedEntireExchangeRateConfiguration: (
			{ sourceCurrency, atomicRate, systemSourceRate, systemDestinationRate },
			cb
		) => {
			describe(`when mocked with atomic rate ${atomicRate}, src rate ${systemSourceRate}, dest rate ${systemDestinationRate}`, () => {
				beforeEach(async () => {
					mockEffectiveAtomicRate({
						sourceCurrency,
						atomicRate,
						systemSourceRate,
						systemDestinationRate,
					});

					this.mocks.ExchangeRates.effectiveValue.returns((srcKey, sourceAmount, destKey) => {
						sourceAmount = sourceAmount.toString(); // passed from smock as a number

						const [sourceRate, destinationRate] =
							srcKey === sourceCurrency
								? [systemSourceRate, systemDestinationRate]
								: [systemDestinationRate, systemSourceRate];
						return divideDecimal(
							multiplyDecimal(sourceAmount, sourceRate),
							destinationRate
						).toString();
					});
				});

				cb();
			});
		},
		whenMockedASingleRwaToIssueAndBurn: cb => {
			describe(`when mocked a rwa to burn`, () => {
				beforeEach(async () => {
					// create and share the one rwa for all Issuer.rwas() calls
					this.mocks.rwa = await smock.fake('Rwa');
					this.mocks.rwa.proxy.returns(web3.eth.accounts.create().address);
					this.mocks.Issuer.rwas.returns(currencyKey => {
						// but when currency
						this.mocks.rwa.currencyKey.returns(currencyKey);
						return this.mocks.rwa.address;
					});
				});
				cb();
			});
		},
		whenMockedSusdAndSethSeparatelyToIssueAndBurn: cb => {
			describe(`when mocked rUSD and rETH`, () => {
				async function mockRwa(currencyKey) {
					const rwa = await smock.fake('Rwa');
					rwa.currencyKey.returns(currencyKey);
					rwa.proxy.returns(web3.eth.accounts.create().address);
					return rwa;
				}

				beforeEach(async () => {
					this.mocks.rUSD = await mockRwa(rUSD);
					this.mocks.rETH = await mockRwa(rETH);
					this.mocks.Issuer.rwas.returns(currencyKey => {
						if (currencyKey === rUSD) {
							return this.mocks.rUSD.address;
						} else if (currencyKey === rETH) {
							return this.mocks.rETH.address;
						}
						// mimic on-chain default of 0s
						return ZERO_ADDRESS;
					});
				});

				cb();
			});
		},
		whenMockedExchangeStatePersistance: cb => {
			describe(`when mocking exchange state persistance`, () => {
				beforeEach(async () => {
					this.mocks.ExchangeRates.getCurrentRoundId.returns('0');
					this.mocks.ExchangeState.appendExchangeEntry.will.return();
				});
				cb();
			});
		},
		whenMockedFeePool: cb => {
			describe('when mocked fee pool', () => {
				beforeEach(async () => {
					this.mocks.FeePool.FEE_ADDRESS.returns(
						getUsers({ network: 'mainnet', user: 'fee' }).address
					);
				});
				cb();
			});
		},
	};
};
