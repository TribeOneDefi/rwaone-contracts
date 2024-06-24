const { artifacts, contract } = require('hardhat');
const { assert } = require('./common');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { toBytes32 } = require('../..');
const { smock } = require('@defi-wonderland/smock');

const { toUnit } = require('../utils')();

const BaseRwaoneBridge = artifacts.require('BaseRwaoneBridge');

contract('BaseRwaoneBridge (unit tests)', accounts => {
	const [, owner, user1, smockedMessenger] = accounts;

	const [rUSD, hETH] = [toBytes32('rUSD'), toBytes32('hETH')];

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: BaseRwaoneBridge.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'resumeInitiation',
				'suspendInitiation',
				'initiateTribeTransfer',
				'finalizeTribeTransfer',
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

			describe('initiateTribeTransfer', () => {
				it('fails if requested tribe is not enabled for cross chain transfer', async () => {
					await assert.revert(
						instance.initiateTribeTransfer(hETH, user1, toUnit('50'), { from: owner }),
						'Tribe not enabled for cross chain transfer'
					);
				});

				it('fails if tribe is not enabled', async () => {
					flexibleStorage.getUIntValue.returns(toUnit('50').toString());
					systemStatus.requireTribeActive.reverts('suspended');

					await assert.revert(
						instance.initiateTribeTransfer(hETH, user1, toUnit('50'), { from: owner }),
						'Transaction reverted without a reason string'
					);
				});

				describe('when enabled for cross chain transfer', () => {
					let txn;

					beforeEach('run tribe transfer calls', async () => {
						// fake the value that would be set by first `initiateTribeTransfer`
						// this also simultaneously enables tribe trade
						flexibleStorage.getUIntValue.returns(toUnit('50').toString());

						// two initiate calls to verify summation
						await instance.initiateTribeTransfer(hETH, user1, toUnit('50'), { from: owner });

						txn = await instance.initiateTribeTransfer(rUSD, owner, toUnit('100'), { from: user1 });
					});

					it('fails if initiation is not active', async () => {
						await instance.suspendInitiation({ from: owner });

						await assert.revert(
							instance.initiateTribeTransfer(hETH, user1, toUnit('50'), { from: owner }),
							'Initiation deactivated'
						);
					});

					it('burns tribes from caller', () => {
						issuer.burnTribesWithoutDebt.returnsAtCall(0, toUnit('100'));
					});

					it('calls messenger', () => {
						messenger.sendMessage.returnsAtCall(0, issuer.address);
					});

					it('increments tribeTransferSent', async () => {
						flexibleStorage.setUIntValue.returnsAtCall(0, toUnit('150'));
					});

					it('emits event', () => {
						assert.eventEqual(txn, 'InitiateTribeTransfer', [rUSD, owner, toUnit('100')]);
					});
				});
			});

			describe('finalizeTribeTransfer', () => {
				beforeEach('set counterpart bridge', async () => {
					messenger.xDomainMessageSender.returns(issuer.address);
				});

				it('fails if xdomainmessagesender doesnt match counterpart', async () => {
					messenger.xDomainMessageSender.returns(owner);
					await assert.revert(instance.finalizeTribeTransfer(rUSD, owner, '100'));
				});

				it('can only be called by messenger and registered counterpart', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: instance.finalizeTribeTransfer,
						accounts,
						address: smockedMessenger,
						args: [rUSD, owner, '100'],
						reason: 'Only the relayer can call this',
					});
				});

				describe('when successfully invoked', () => {
					let txn;
					beforeEach(async () => {
						// fake the value that would be set by previous `finalizeTribeTransfer`
						flexibleStorage.getUIntValue.returns(toUnit('50').toString());

						// two calls to verify summation
						await instance.finalizeTribeTransfer(hETH, owner, toUnit('50'), {
							from: smockedMessenger,
						});

						txn = await instance.finalizeTribeTransfer(rUSD, user1, toUnit('125'), {
							from: smockedMessenger,
						});
					});

					it('mints tribes to the destination', () => {
						issuer.issueTribesWithoutDebt.returnsAtCall(0, toUnit('125'));
					});

					it('increments tribeTransferReceived', async () => {
						flexibleStorage.setUIntValue.returnsAtCall(0, toUnit('175'));
					});

					it('emits event', () => {
						assert.eventEqual(txn, 'FinalizeTribeTransfer', [rUSD, user1, toUnit('125')]);
					});
				});
			});

			describe('tribeTransferSent & tribeTransferReceived', () => {
				beforeEach('set fake values', () => {
					// create some fake tribes
					issuer.availableCurrencyKeys.returns([rUSD, hETH]);

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

					await assert.revert(instance.tribeTransferSent(), 'Rates are invalid');
				});

				it('correctly sums', async () => {
					assert.bnEqual(await instance.tribeTransferSent(), toUnit(700));
					assert.bnEqual(await instance.tribeTransferReceived(), toUnit(700));
				});
			});
		});
	});
});
