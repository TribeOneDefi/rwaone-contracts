const { artifacts, contract } = require('hardhat');
const { assert } = require('./common');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { toBytes32 } = require('../..');
const { smock } = require('@defi-wonderland/smock');

const { toUnit } = require('../utils')();

const BaseRwaoneBridge = artifacts.require('BaseRwaoneBridge');

contract('BaseRwaoneBridge (unit tests)', accounts => {
	const [, owner, user1, smockedMessenger] = accounts;

	const [rUSD, rETH] = [toBytes32('rUSD'), toBytes32('rETH')];

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: BaseRwaoneBridge.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'resumeInitiation',
				'suspendInitiation',
				'initiateRwaTransfer',
				'finalizeRwaTransfer',
			],
		});
	});

	describe('when all the deps are mocked', () => {
		let messenger;
		let rwaone;
		let resolver;
		let issuer;
		let exchangeRates;
		let feePool;
		let rewardEscrow;
		let flexibleStorage;
		let systemStatus;

		beforeEach(async () => {
			messenger = await smock.fake('iAbs_BaseCrossDomainMessenger', {
				address: smockedMessenger,
			});

			rewardEscrow = await smock.fake(
				artifacts.require('contracts/interfaces/IRewardEscrowV2.sol:IRewardEscrowV2').abi
			);

			// can't use IRwaone as we need ERC20 functions as well
			rwaone = await smock.fake('Rwaone');

			feePool = await smock.fake('FeePool');

			issuer = await smock.fake('Issuer');
			exchangeRates = await smock.fake('ExchangeRates');
			systemStatus = await smock.fake('SystemStatus');
			flexibleStorage = await smock.fake('FlexibleStorage');

			resolver = await artifacts.require('AddressResolver').new(owner);

			await resolver.importAddresses(
				[
					'ext:Messenger',
					'Rwaone',
					'RewardEscrowV2',
					'FlexibleStorage',
					'Issuer',
					'ExchangeRates',
					'FeePool',
					'base:RwaoneBridgeToOptimism',
					'SystemStatus',
				].map(toBytes32),
				[
					messenger.address,
					rwaone.address,
					rewardEscrow.address,
					flexibleStorage.address,
					issuer.address,
					exchangeRates.address,
					feePool.address,
					issuer.address,
					systemStatus.address,
				],
				{ from: owner }
			);
		});

		describe('when the target is deployed and the proxy is set', () => {
			let instance;

			beforeEach(async () => {
				instance = await artifacts
					.require('RwaoneBridgeToBase') // have to use a sub-contract becuase `BaseRwaoneBridge` is abstract
					.new(owner, resolver.address);

				await instance.rebuildCache();
			});

			it('should set constructor params on deployment', async () => {
				assert.equal(await instance.owner(), owner);
				assert.equal(await instance.resolver(), resolver.address);
			});

			it('initially initiations are active', async () => {
				assert.equal(await instance.initiationActive(), true);
			});

			describe('suspendInitiation', () => {
				describe('failure modes', () => {
					it('reverts when not invoked by the owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.suspendInitiation,
							args: [],
							accounts,
							reason: 'Only the contract owner may perform this action',
							address: owner,
						});
					});

					it('reverts when initiation is already suspended', async () => {
						await instance.suspendInitiation({ from: owner });

						await assert.revert(
							instance.suspendInitiation({ from: owner }),
							'Initiation suspended'
						);
					});
				});

				describe('when invoked by the owner', () => {
					let txn;
					beforeEach(async () => {
						txn = await instance.suspendInitiation({ from: owner });
					});

					it('and initiationActive is false', async () => {
						assert.equal(await instance.initiationActive(), false);
					});

					it('and a InitiationSuspended event is emitted', async () => {
						assert.eventEqual(txn, 'InitiationSuspended', []);
					});
				});
			});

			describe('resumeInitiation', () => {
				describe('failure modes', () => {
					it('reverts when not invoked by the owner', async () => {
						// first suspend initiations
						await instance.suspendInitiation({ from: owner });
						await onlyGivenAddressCanInvoke({
							fnc: instance.resumeInitiation,
							args: [],
							accounts,
							reason: 'Only the contract owner may perform this action',
							address: owner,
						});
					});

					it('reverts when initiation is not suspended', async () => {
						await assert.revert(
							instance.resumeInitiation({ from: owner }),
							'Initiation not suspended'
						);
					});
				});

				describe('when initiation is suspended', () => {
					let txn;
					beforeEach(async () => {
						txn = await instance.suspendInitiation({ from: owner });
					});

					it('initiationActive is false', async () => {
						assert.equal(await instance.initiationActive(), false);
					});

					describe('when invoked by the owner', () => {
						beforeEach(async () => {
							txn = await instance.resumeInitiation({ from: owner });
						});

						it('initiations are active again', async () => {
							assert.equal(await instance.initiationActive(), true);
						});

						it('a InitiationResumed event is emitted', async () => {
							assert.eventEqual(txn, 'InitiationResumed', []);
						});
					});
				});
			});

			describe('initiateRwaTransfer', () => {
				it('fails if requested rwa is not enabled for cross chain transfer', async () => {
					await assert.revert(
						instance.initiateRwaTransfer(rETH, user1, toUnit('50'), { from: owner }),
						'Rwa not enabled for cross chain transfer'
					);
				});

				it('fails if rwa is not enabled', async () => {
					flexibleStorage.getUIntValue.returns(toUnit('50').toString());
					systemStatus.requireRwaActive.reverts('suspended');

					await assert.revert(
						instance.initiateRwaTransfer(rETH, user1, toUnit('50'), { from: owner }),
						'Transaction reverted without a reason string'
					);
				});

				describe('when enabled for cross chain transfer', () => {
					let txn;

					beforeEach('run rwa transfer calls', async () => {
						// fake the value that would be set by first `initiateRwaTransfer`
						// this also simultaneously enables rwa trade
						flexibleStorage.getUIntValue.returns(toUnit('50').toString());

						// two initiate calls to verify summation
						await instance.initiateRwaTransfer(rETH, user1, toUnit('50'), { from: owner });

						txn = await instance.initiateRwaTransfer(rUSD, owner, toUnit('100'), { from: user1 });
					});

					it('fails if initiation is not active', async () => {
						await instance.suspendInitiation({ from: owner });

						await assert.revert(
							instance.initiateRwaTransfer(rETH, user1, toUnit('50'), { from: owner }),
							'Initiation deactivated'
						);
					});

					it('burns rwas from caller', () => {
						issuer.burnRwasWithoutDebt.returnsAtCall(0, toUnit('100'));
					});

					it('calls messenger', () => {
						messenger.sendMessage.returnsAtCall(0, issuer.address);
					});

					it('increments rwaTransferSent', async () => {
						flexibleStorage.setUIntValue.returnsAtCall(0, toUnit('150'));
					});

					it('emits event', () => {
						assert.eventEqual(txn, 'InitiateRwaTransfer', [rUSD, owner, toUnit('100')]);
					});
				});
			});

			describe('finalizeRwaTransfer', () => {
				beforeEach('set counterpart bridge', async () => {
					messenger.xDomainMessageSender.returns(issuer.address);
				});

				it('fails if xdomainmessagesender doesnt match counterpart', async () => {
					messenger.xDomainMessageSender.returns(owner);
					await assert.revert(instance.finalizeRwaTransfer(rUSD, owner, '100'));
				});

				it('can only be called by messenger and registered counterpart', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: instance.finalizeRwaTransfer,
						accounts,
						address: smockedMessenger,
						args: [rUSD, owner, '100'],
						reason: 'Only the relayer can call this',
					});
				});

				describe('when successfully invoked', () => {
					let txn;
					beforeEach(async () => {
						// fake the value that would be set by previous `finalizeRwaTransfer`
						flexibleStorage.getUIntValue.returns(toUnit('50').toString());

						// two calls to verify summation
						await instance.finalizeRwaTransfer(rETH, owner, toUnit('50'), {
							from: smockedMessenger,
						});

						txn = await instance.finalizeRwaTransfer(rUSD, user1, toUnit('125'), {
							from: smockedMessenger,
						});
					});

					it('mints rwas to the destination', () => {
						issuer.issueRwasWithoutDebt.returnsAtCall(0, toUnit('125'));
					});

					it('increments rwaTransferReceived', async () => {
						flexibleStorage.setUIntValue.returnsAtCall(0, toUnit('175'));
					});

					it('emits event', () => {
						assert.eventEqual(txn, 'FinalizeRwaTransfer', [rUSD, user1, toUnit('125')]);
					});
				});
			});

			describe('rwaTransferSent & rwaTransferReceived', () => {
				beforeEach('set fake values', () => {
					// create some fake rwas
					issuer.availableCurrencyKeys.returns([rUSD, rETH]);

					// set some exchange rates
					exchangeRates.ratesAndInvalidForCurrencies.returns([
						[toUnit('1').toString(), toUnit('3').toString()],
						false,
					]);

					// set flexible storage to a fake value
					flexibleStorage.getUIntValues.returns([
						toUnit('100').toString(),
						toUnit('200').toString(),
					]);
				});

				it('reverts if rates are innaccurate', async () => {
					exchangeRates.ratesAndInvalidForCurrencies.returns([
						[toUnit('1').toString(), toUnit('3').toString()],
						true,
					]);

					await assert.revert(instance.rwaTransferSent(), 'Rates are invalid');
				});

				it('correctly sums', async () => {
					assert.bnEqual(await instance.rwaTransferSent(), toUnit(700));
					assert.bnEqual(await instance.rwaTransferReceived(), toUnit(700));
				});
			});
		});
	});
});
