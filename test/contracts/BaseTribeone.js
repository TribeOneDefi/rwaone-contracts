'use strict';

const { artifacts, contract, web3, ethers } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { smock } = require('@defi-wonderland/smock');

require('./common'); // import common test scaffolding

const { setupContract, setupAllContracts } = require('./setup');

const { currentTime, fastForward, toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setupPriceAggregators,
	updateAggregatorRates,
	updateRatesWithDefaults,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('BaseTribeone', async accounts => {
	const [hUSD, sAUD, sEUR, HAKA, sETH] = ['hUSD', 'sAUD', 'sEUR', 'HAKA', 'sETH'].map(toBytes32);

	const [, owner, account1, account2, account3] = accounts;

	let baseTribeoneImpl,
		baseTribeoneProxy,
		exchangeRates,
		debtCache,
		escrow,
		rewardEscrowV2,
		addressResolver,
		systemSettings,
		systemStatus,
		circuitBreaker,
		aggregatorDebtRatio;

	before(async () => {
		({
			Tribeone: baseTribeoneImpl,
			ProxyERC20BaseTribeone: baseTribeoneProxy,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			DebtCache: debtCache,
			SystemStatus: systemStatus,
			CircuitBreaker: circuitBreaker,
			TribeoneEscrow: escrow,
			RewardEscrowV2: rewardEscrowV2,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
		} = await setupAllContracts({
			accounts,
			synths: ['hUSD', 'sETH', 'sEUR', 'sAUD'],
			contracts: [
				'BaseTribeone',
				'SupplySchedule',
				'AddressResolver',
				'ExchangeRates',
				'SystemSettings',
				'SystemStatus',
				'DebtCache',
				'Issuer',
				'LiquidatorRewards',
				'OneNetAggregatorDebtRatio',
				'Exchanger',
				'RewardsDistribution',
				'CollateralManager',
				'CircuitBreaker',
				'RewardEscrowV2', // required for collateral check in issuer
			],
		}));

		// approve creating escrow entries from owner
		await baseTribeoneImpl.approve(rewardEscrowV2.address, ethers.constants.MaxUint256, {
			from: owner,
		});

		// use implementation ABI on the proxy address to simplify calling
		baseTribeoneProxy = await artifacts.require('BaseTribeone').at(baseTribeoneProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, sETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: baseTribeoneImpl.abi,
			ignoreParents: ['ExternStateToken', 'MixinResolver'],
			expected: [
				'burnSecondary',
				'burnSynths',
				'burnSynthsOnBehalf',
				'burnSynthsToTarget',
				'burnSynthsToTargetOnBehalf',
				'emitSynthExchange',
				'emitExchangeRebate',
				'emitExchangeReclaim',
				'emitExchangeTracking',
				'exchange',
				'exchangeAtomically',
				'exchangeOnBehalf',
				'exchangeOnBehalfWithTracking',
				'exchangeWithTracking',
				'exchangeWithTrackingForInitiator',
				'exchangeWithVirtual',
				'issueMaxSynths',
				'issueMaxSynthsOnBehalf',
				'issueSynths',
				'issueSynthsOnBehalf',
				'mint',
				'mintSecondary',
				'mintSecondaryRewards',
				'revokeAllEscrow',
				'settle',
				'transfer',
				'transferFrom',
				'liquidateSelf',
				'liquidateDelinquentAccount',
				'liquidateDelinquentAccountEscrowIndex',
				'migrateEscrowContractBalance',
				'migrateAccountBalances',
			],
		});
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const TRIBEONE_TOTAL_SUPPLY = web3.utils.toWei('100000000');
			const instance = await setupContract({
				contract: 'BaseTribeone',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, TRIBEONE_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), TRIBEONE_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});

		it('should set constructor params on upgrade to new totalSupply', async () => {
			const YEAR_2_TRIBEONE_TOTAL_SUPPLY = web3.utils.toWei('175000000');
			const instance = await setupContract({
				contract: 'BaseTribeone',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, YEAR_2_TRIBEONE_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), YEAR_2_TRIBEONE_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});
	});

	describe('non-basic functions always revert', () => {
		const amount = 100;
		it('exchangeWithVirtual should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.exchangeWithVirtual,
				accounts,
				args: [hUSD, amount, sAUD, toBytes32('AGGREGATOR')],
				reason: 'Cannot be run on this layer',
			});
		});

		it('exchangeWithTrackingForInitiator should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.exchangeWithTrackingForInitiator,
				accounts,
				args: [hUSD, amount, sAUD, owner, toBytes32('AGGREGATOR')],
				reason: 'Cannot be run on this layer',
			});
		});

		it('ExchangeAtomically should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.exchangeAtomically,
				accounts,
				args: [hUSD, amount, sETH, toBytes32('AGGREGATOR'), 0],
				reason: 'Cannot be run on this layer',
			});
		});

		it('mint should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.mint,
				accounts,
				args: [],
				reason: 'Cannot be run on this layer',
			});
		});

		it('mintSecondary should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.mintSecondary,
				accounts,
				args: [account1, amount],
				reason: 'Cannot be run on this layer',
			});
		});
		it('mintSecondaryRewards should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.mintSecondaryRewards,
				accounts,
				args: [amount],
				reason: 'Cannot be run on this layer',
			});
		});
		it('burnSecondary should revert no matter who the caller is', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.burnSecondary,
				accounts,
				args: [account1, amount],
				reason: 'Cannot be run on this layer',
			});
		});
	});

	describe('only Exchanger can call emit event functions', () => {
		const amount1 = 10;
		const amount2 = 100;
		const currencyKey1 = sAUD;
		const currencyKey2 = sEUR;
		const trackingCode = toBytes32('1inch');

		it('emitExchangeTracking() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.emitExchangeTracking,
				accounts,
				args: [trackingCode, currencyKey1, amount1, amount2],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitExchangeRebate() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.emitExchangeRebate,
				accounts,
				args: [account1, currencyKey1, amount1],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitExchangeReclaim() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.emitExchangeReclaim,
				accounts,
				args: [account1, currencyKey1, amount1],
				reason: 'Only Exchanger can invoke this',
			});
		});
		it('emitSynthExchange() cannot be invoked directly by any account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: baseTribeoneImpl.emitSynthExchange,
				accounts,
				args: [account1, currencyKey1, amount1, currencyKey2, amount2, account2],
				reason: 'Only Exchanger can invoke this',
			});
		});

		describe('Exchanger calls emit', () => {
			const exchanger = account1;
			let tx1, tx2, tx3, tx4;
			beforeEach('pawn Exchanger and sync cache', async () => {
				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger], {
					from: owner,
				});
				await baseTribeoneImpl.rebuildCache();
			});
			beforeEach('call event emission functions', async () => {
				tx1 = await baseTribeoneImpl.emitExchangeRebate(account1, currencyKey1, amount1, {
					from: exchanger,
				});
				tx2 = await baseTribeoneImpl.emitExchangeReclaim(account1, currencyKey1, amount1, {
					from: exchanger,
				});
				tx3 = await baseTribeoneImpl.emitSynthExchange(
					account1,
					currencyKey1,
					amount1,
					currencyKey2,
					amount2,
					account2,
					{ from: exchanger }
				);
				tx4 = await baseTribeoneImpl.emitExchangeTracking(
					trackingCode,
					currencyKey1,
					amount1,
					amount2,
					{ from: exchanger }
				);
			});

			it('the corresponding events are emitted', async () => {
				it('the corresponding events are emitted', async () => {
					assert.eventEqual(tx1, 'ExchangeRebate', {
						account: account1,
						currencyKey: currencyKey1,
						amount: amount1,
					});
					assert.eventEqual(tx2, 'ExchangeReclaim', {
						account: account1,
						currencyKey: currencyKey1,
						amount: amount1,
					});
					assert.eventEqual(tx3, 'SynthExchange', {
						account: account1,
						fromCurrencyKey: currencyKey1,
						fromAmount: amount1,
						toCurrencyKey: currencyKey2,
						toAmount: amount2,
						toAddress: account2,
					});
					assert.eventEqual(tx4, 'ExchangeTracking', {
						trackingCode: trackingCode,
						toCurrencyKey: currencyKey1,
						toAmount: amount1,
						fee: amount2,
					});
				});
			});
		});
	});

	describe('Exchanger calls', () => {
		let smockExchanger;
		beforeEach(async () => {
			smockExchanger = await smock.fake('Exchanger');
			smockExchanger.exchange.returns(() => ['1', ZERO_ADDRESS]);
			smockExchanger.settle.returns(() => ['1', '2', '3']);
			await addressResolver.importAddresses(
				['Exchanger'].map(toBytes32),
				[smockExchanger.address],
				{ from: owner }
			);
			await baseTribeoneImpl.rebuildCache();
		});

		const amount1 = '10';
		const currencyKey1 = sAUD;
		const currencyKey2 = sEUR;
		const msgSender = owner;
		const trackingCode = toBytes32('1inch');

		it('exchangeOnBehalf is called with the right arguments ', async () => {
			await baseTribeoneImpl.exchangeOnBehalf(account1, currencyKey1, amount1, currencyKey2, {
				from: msgSender,
			});
			smockExchanger.exchange.returnsAtCall(0, account1);
			smockExchanger.exchange.returnsAtCall(1, msgSender);
			smockExchanger.exchange.returnsAtCall(2, currencyKey1);
			smockExchanger.exchange.returnsAtCall(3, amount1);
			smockExchanger.exchange.returnsAtCall(4, currencyKey2);
			smockExchanger.exchange.returnsAtCall(5, account1);
			smockExchanger.exchange.returnsAtCall(6, false);
			smockExchanger.exchange.returnsAtCall(7, account1);
			smockExchanger.exchange.returnsAtCall(8, toBytes32(''));
		});

		it('exchangeWithTracking is called with the right arguments ', async () => {
			await baseTribeoneImpl.exchangeWithTracking(
				currencyKey1,
				amount1,
				currencyKey2,
				account2,
				trackingCode,
				{ from: msgSender }
			);
			smockExchanger.exchange.returnsAtCall(0, msgSender);
			smockExchanger.exchange.returnsAtCall(1, msgSender);
			smockExchanger.exchange.returnsAtCall(2, currencyKey1);
			smockExchanger.exchange.returnsAtCall(3, amount1);
			smockExchanger.exchange.returnsAtCall(4, currencyKey2);
			smockExchanger.exchange.returnsAtCall(5, msgSender);
			smockExchanger.exchange.returnsAtCall(6, false);
			smockExchanger.exchange.returnsAtCall(7, account2);
			smockExchanger.exchange.returnsAtCall(8, trackingCode);
		});

		it('exchangeOnBehalfWithTracking is called with the right arguments ', async () => {
			await baseTribeoneImpl.exchangeOnBehalfWithTracking(
				account1,
				currencyKey1,
				amount1,
				currencyKey2,
				account2,
				trackingCode,
				{ from: owner }
			);
			smockExchanger.exchange.returnsAtCall(0, account1);
			smockExchanger.exchange.returnsAtCall(1, msgSender);
			smockExchanger.exchange.returnsAtCall(2, currencyKey1);
			smockExchanger.exchange.returnsAtCall(3, amount1);
			smockExchanger.exchange.returnsAtCall(4, currencyKey2);
			smockExchanger.exchange.returnsAtCall(5, account1);

			smockExchanger.exchange.returnsAtCall(6, false);
			smockExchanger.exchange.returnsAtCall(7, account2);
			smockExchanger.exchange.returnsAtCall(8, trackingCode);
		});

		it('settle is called with the right arguments ', async () => {
			await baseTribeoneImpl.settle(currencyKey1, {
				from: owner,
			});
			smockExchanger.settle.returnsAtCall(0, msgSender);
			smockExchanger.settle.returnsAtCall(1, currencyKey1);
		});
	});

	describe('isWaitingPeriod()', () => {
		it('returns false by default', async () => {
			assert.isFalse(await baseTribeoneImpl.isWaitingPeriod(sETH));
		});
		describe('when a user has exchanged into sETH', () => {
			beforeEach(async () => {
				await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

				await baseTribeoneImpl.issueSynths(toUnit('100'), { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sETH, { from: owner });
			});
			it('then waiting period is true', async () => {
				assert.isTrue(await baseTribeoneImpl.isWaitingPeriod(sETH));
			});
			describe('when the waiting period expires', () => {
				beforeEach(async () => {
					await fastForward(await systemSettings.waitingPeriodSecs());
				});
				it('returns false by default', async () => {
					assert.isFalse(await baseTribeoneImpl.isWaitingPeriod(sETH));
				});
			});
		});
	});

	describe('anySynthOrHAKARateIsInvalid()', () => {
		it('should have stale rates initially', async () => {
			assert.equal(await baseTribeoneImpl.anySynthOrHAKARateIsInvalid(), true);
		});
		describe('when synth rates set', () => {
			beforeEach(async () => {
				// fast forward to get past initial HAKA setting
				await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, sETH],
					['0.5', '1.25', '100'].map(toUnit)
				);
				await debtCache.takeDebtSnapshot();
			});
			it('should still have stale rates', async () => {
				assert.equal(await baseTribeoneImpl.anySynthOrHAKARateIsInvalid(), true);
			});
			describe('when HAKA is also set', () => {
				beforeEach(async () => {
					await updateAggregatorRates(exchangeRates, circuitBreaker, [HAKA], ['1'].map(toUnit));
				});
				it('then no stale rates', async () => {
					assert.equal(await baseTribeoneImpl.anySynthOrHAKARateIsInvalid(), false);
				});

				describe('when only some synths are updated', () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));

						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[HAKA, sAUD],
							['0.1', '0.78'].map(toUnit)
						);
					});

					it('then anySynthOrHAKARateIsInvalid() returns true', async () => {
						assert.equal(await baseTribeoneImpl.anySynthOrHAKARateIsInvalid(), true);
					});
				});
			});
		});
	});

	describe('availableCurrencyKeys()', () => {
		it('returns all currency keys by default', async () => {
			assert.deepEqual(await baseTribeoneImpl.availableCurrencyKeys(), [hUSD, sETH, sEUR, sAUD]);
		});
	});

	describe('isWaitingPeriod()', () => {
		it('returns false by default', async () => {
			assert.isFalse(await baseTribeoneImpl.isWaitingPeriod(sETH));
		});
	});

	describe('transfer()', () => {
		describe('when the system is suspended', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await baseTribeoneImpl.approve(account1, toUnit('10'), { from: owner });
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when transfer() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					baseTribeoneProxy.transfer(account1, toUnit('10'), { from: owner }),
					'Operation prohibited'
				);
			});
			it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					baseTribeoneProxy.transferFrom(owner, account2, toUnit('10'), { from: account1 }),
					'Operation prohibited'
				);
			});
			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when transfer() is invoked, it works as expected', async () => {
					await baseTribeoneProxy.transfer(account1, toUnit('10'), { from: owner });
				});
				it('when transferFrom() is invoked, it works as expected', async () => {
					await baseTribeoneProxy.transferFrom(owner, account2, toUnit('10'), { from: account1 });
				});
			});
		});

		beforeEach(async () => {
			// Ensure all synths have rates to allow issuance
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
		});

		// SIP-238
		describe('implementation does not allow transfers but allows approve', () => {
			const amount = toUnit('10');
			const revertMsg = 'Only the proxy';

			it('approve does not revert', async () => {
				await baseTribeoneImpl.approve(account1, amount, { from: owner });
			});
			it('transfer reverts', async () => {
				await assert.revert(
					baseTribeoneImpl.transfer(account1, amount, { from: owner }),
					revertMsg
				);
			});
			it('transferFrom reverts', async () => {
				await baseTribeoneImpl.approve(account1, amount, { from: owner });
				await assert.revert(
					baseTribeoneImpl.transferFrom(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transfer does not revert from a whitelisted contract', async () => {
				// set owner as RewardEscrowV2
				await addressResolver.importAddresses(['RewardEscrowV2'].map(toBytes32), [owner], {
					from: owner,
				});
				await baseTribeoneImpl.transfer(account1, amount, { from: owner });
			});
		});

		// SIP-252
		describe('migrateEscrowContractBalance', () => {
			it('restricted to owner', async () => {
				await assert.revert(
					baseTribeoneImpl.migrateEscrowContractBalance({ from: account2 }),
					'contract owner'
				);
			});
			it('reverts if both are the same address', async () => {
				await addressResolver.importAddresses(
					['RewardEscrowV2Frozen', 'RewardEscrowV2'].map(toBytes32),
					[account1, account1],
					{ from: owner }
				);
				await assert.revert(
					baseTribeoneImpl.migrateEscrowContractBalance({ from: owner }),
					'same address'
				);
			});
			it('transfers balance as needed', async () => {
				await baseTribeoneProxy.transfer(account1, toUnit('10'), { from: owner });
				// check balances
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('10'));
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('0'));

				await addressResolver.importAddresses(
					['RewardEscrowV2Frozen', 'RewardEscrowV2'].map(toBytes32),
					[account1, account2],
					{ from: owner }
				);

				await baseTribeoneImpl.migrateEscrowContractBalance({ from: owner });

				// check balances
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('0'));
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('10'));
			});
		});

		// SIP-237
		describe('migrateAccountBalances', () => {
			beforeEach(async () => {
				// give the account some balance to test with
				await baseTribeoneProxy.transfer(account3, toUnit('200'), { from: owner });
				await rewardEscrowV2.createEscrowEntry(account3, toUnit('100'), 1, { from: owner });

				assert.bnEqual(await baseTribeoneImpl.collateral(account3), toUnit('300'));
			});
			it('restricted to debt migrator on ethereum', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: baseTribeoneImpl.migrateAccountBalances,
					accounts,
					args: [account3],
					reason: 'Only L1 DebtMigrator',
				});
			});
			it('zeroes balances on this layer', async () => {
				await addressResolver.importAddresses(
					['DebtMigratorOnEthereum', 'ovm:DebtMigratorOnOptimism'].map(toBytes32),
					[account1, account2],
					{ from: owner }
				);

				await baseTribeoneImpl.migrateAccountBalances(account3, { from: account1 });

				// collateral balance should be zero after migration
				assert.bnEqual(await baseTribeoneImpl.collateral(account3), toUnit('0'));
			});
		});

		// SIP-299
		describe('revokeAllEscrow', () => {
			it('restricted to legacy market', async () => {
				await addressResolver.importAddresses(['LegacyMarket'].map(toBytes32), [account2], {
					from: owner,
				});
				await rewardEscrowV2.createEscrowEntry(account1, toUnit('100'), 1, { from: owner });
				await assert.revert(
					baseTribeoneImpl.revokeAllEscrow(account1, { from: owner }),
					'Only LegacyMarket can revoke escrow'
				);
			});
		});

		it('should transfer when legacy market address is non-zero', async () => {
			await addressResolver.importAddresses(['LegacyMarket'].map(toBytes32), [account2], {
				from: owner,
			});

			// transfer some haka to the LegacyMarket
			assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('0'));
			await baseTribeoneProxy.transfer(account2, toUnit('10'), { from: owner });
			assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('10'));

			// transfer HAKA from the legacy market to another account
			await baseTribeoneProxy.transfer(account1, toUnit('10'), { from: account2 });
			assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('0'));
		});

		it('should transfer using the ERC20 transfer function @gasprofile', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all HAKA.

			assert.bnEqual(
				await baseTribeoneImpl.totalSupply(),
				await baseTribeoneImpl.balanceOf(owner)
			);

			const transaction = await baseTribeoneProxy.transfer(account1, toUnit('10'), {
				from: owner,
			});

			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account1,
				value: toUnit('10'),
			});

			assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('10'));
		});

		it('should revert when exceeding locked tribeone and calling the ERC20 transfer function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all HAKA.
			assert.bnEqual(
				await baseTribeoneImpl.totalSupply(),
				await baseTribeoneImpl.balanceOf(owner)
			);

			// Issue max synths.
			await baseTribeoneImpl.issueMaxSynths({ from: owner });

			// Try to transfer 0.000000000000000001 HAKA
			await assert.revert(
				baseTribeoneProxy.transfer(account1, '1', { from: owner }),
				'Cannot transfer staked or escrowed HAKA'
			);
		});

		it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all HAKA.
			const previousOwnerBalance = await baseTribeoneImpl.balanceOf(owner);
			assert.bnEqual(await baseTribeoneImpl.totalSupply(), previousOwnerBalance);

			// Approve account1 to act on our behalf for 10 HAKA.
			let transaction = await baseTribeoneImpl.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Assert that transferFrom works.
			transaction = await baseTribeoneProxy.transferFrom(owner, account2, toUnit('10'), {
				from: account1,
			});

			assert.eventEqual(transaction, 'Transfer', {
				from: owner,
				to: account2,
				value: toUnit('10'),
			});

			// Assert that account2 has 10 HAKA and owner has 10 less HAKA
			assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('10'));
			assert.bnEqual(
				await baseTribeoneImpl.balanceOf(owner),
				previousOwnerBalance.sub(toUnit('10'))
			);

			// Assert that we can't transfer more even though there's a balance for owner.
			await assert.revert(
				baseTribeoneProxy.transferFrom(owner, account2, '1', {
					from: account1,
				})
			);
		});

		it('should revert when exceeding locked tribeone and calling the ERC20 transferFrom function', async () => {
			// Ensure our environment is set up correctly for our assumptions
			// e.g. owner owns all HAKA.
			assert.bnEqual(
				await baseTribeoneImpl.totalSupply(),
				await baseTribeoneImpl.balanceOf(owner)
			);

			// Approve account1 to act on our behalf for 10 HAKA.
			const transaction = await baseTribeoneImpl.approve(account1, toUnit('10'), { from: owner });
			assert.eventEqual(transaction, 'Approval', {
				owner: owner,
				spender: account1,
				value: toUnit('10'),
			});

			// Issue max synths
			await baseTribeoneImpl.issueMaxSynths({ from: owner });

			// Assert that transferFrom fails even for the smallest amount of HAKA.
			await assert.revert(
				baseTribeoneProxy.transferFrom(owner, account2, '1', {
					from: account1,
				}),
				'Cannot transfer staked or escrowed HAKA'
			);
		});

		describe('when the user has issued some hUSD and exchanged for other synths', () => {
			beforeEach(async () => {
				await baseTribeoneImpl.issueSynths(toUnit('100'), { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sETH, { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sAUD, { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sEUR, { from: owner });
			});
			it('should transfer using the ERC20 transfer function @gasprofile', async () => {
				await baseTribeoneProxy.transfer(account1, toUnit('10'), { from: owner });

				assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('10'));
			});

			it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
				const previousOwnerBalance = await baseTribeoneImpl.balanceOf(owner);

				// Approve account1 to act on our behalf for 10 HAKA.
				await baseTribeoneImpl.approve(account1, toUnit('10'), { from: owner });

				// Assert that transferFrom works.
				await baseTribeoneProxy.transferFrom(owner, account2, toUnit('10'), {
					from: account1,
				});

				// Assert that account2 has 10 HAKA and owner has 10 less HAKA
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('10'));
				assert.bnEqual(
					await baseTribeoneImpl.balanceOf(owner),
					previousOwnerBalance.sub(toUnit('10'))
				);

				// Assert that we can't transfer more even though there's a balance for owner.
				await assert.revert(
					baseTribeoneProxy.transferFrom(owner, account2, '1', {
						from: account1,
					})
				);
			});
		});

		describe('rates stale for transfers', () => {
			const value = toUnit('300');
			const ensureTransferReverts = async () => {
				await assert.revert(
					baseTribeoneProxy.transfer(account2, value, { from: account1 }),
					'A synth or HAKA rate is invalid'
				);
				await assert.revert(
					baseTribeoneProxy.transferFrom(account2, account1, value, {
						from: account3,
					}),
					'A synth or HAKA rate is invalid'
				);
			};

			beforeEach(async () => {
				// Give some HAKA to account1 & account2
				await baseTribeoneProxy.transfer(account1, toUnit('10000'), {
					from: owner,
				});
				await baseTribeoneProxy.transfer(account2, toUnit('10000'), {
					from: owner,
				});

				// Ensure that we can do a successful transfer before rates go stale
				await baseTribeoneProxy.transfer(account2, value, { from: account1 });

				// approve account3 to transferFrom account2
				await baseTribeoneImpl.approve(account3, toUnit('10000'), { from: account2 });
				await baseTribeoneProxy.transferFrom(account2, account1, value, {
					from: account3,
				});
			});

			describe('when the user has a debt position', () => {
				beforeEach(async () => {
					// ensure the accounts have a debt position
					await Promise.all([
						baseTribeoneImpl.issueSynths(toUnit('1'), { from: account1 }),
						baseTribeoneImpl.issueSynths(toUnit('1'), { from: account2 }),
					]);

					// make aggregator debt info rate stale
					await aggregatorDebtRatio.setOverrideTimestamp(await currentTime());

					// Now jump forward in time so the rates are stale
					await fastForward((await exchangeRates.rateStalePeriod()) + 1);
				});
				it('should not allow transfer if the exchange rate for HAKA is stale', async () => {
					await ensureTransferReverts();

					// now give some synth rates
					await aggregatorDebtRatio.setOverrideTimestamp(0);

					await updateAggregatorRates(
						exchangeRates,
						circuitBreaker,
						[sAUD, sEUR],
						['0.5', '1.25'].map(toUnit)
					);
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// the remainder of the synths have prices
					await updateAggregatorRates(exchangeRates, circuitBreaker, [sETH], ['100'].map(toUnit));
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// now give HAKA rate
					await updateAggregatorRates(exchangeRates, circuitBreaker, [HAKA], ['1'].map(toUnit));

					// now HAKA transfer should work
					await baseTribeoneProxy.transfer(account2, value, { from: account1 });
					await baseTribeoneProxy.transferFrom(account2, account1, value, {
						from: account3,
					});
				});

				it('should not allow transfer if debt aggregator is stale', async () => {
					await ensureTransferReverts();

					// now give HAKA rate
					await updateAggregatorRates(exchangeRates, circuitBreaker, [HAKA], ['1'].map(toUnit));
					await debtCache.takeDebtSnapshot();

					await ensureTransferReverts();

					// now give the aggregator debt info rate
					await aggregatorDebtRatio.setOverrideTimestamp(0);

					// now HAKA transfer should work
					await baseTribeoneProxy.transfer(account2, value, { from: account1 });
					await baseTribeoneProxy.transferFrom(account2, account1, value, {
						from: account3,
					});
				});
			});

			describe('when the user has no debt', () => {
				it('should allow transfer if the exchange rate for HAKA is stale', async () => {
					// HAKA transfer should work
					await baseTribeoneProxy.transfer(account2, value, { from: account1 });
					await baseTribeoneProxy.transferFrom(account2, account1, value, {
						from: account3,
					});
				});

				it('should allow transfer if the exchange rate for any synth is stale', async () => {
					// now HAKA transfer should work
					await baseTribeoneProxy.transfer(account2, value, { from: account1 });
					await baseTribeoneProxy.transferFrom(account2, account1, value, {
						from: account3,
					});
				});
			});
		});

		describe('when the user holds HAKA', () => {
			beforeEach(async () => {
				await baseTribeoneProxy.transfer(account1, toUnit('1000'), {
					from: owner,
				});
			});

			describe('and has an escrow entry', () => {
				beforeEach(async () => {
					// Setup escrow
					const escrowedTribeones = toUnit('30000');
					await baseTribeoneProxy.transfer(escrow.address, escrowedTribeones, {
						from: owner,
					});
				});

				it('should allow transfer of tribeone by default', async () => {
					await baseTribeoneProxy.transfer(account2, toUnit('100'), { from: account1 });
				});

				describe('when the user has a debt position (i.e. has issued)', () => {
					beforeEach(async () => {
						await baseTribeoneImpl.issueSynths(toUnit('10'), { from: account1 });
					});

					it('should not allow transfer of tribeone in escrow', async () => {
						// Ensure the transfer fails as all the tribeone are in escrow
						await assert.revert(
							baseTribeoneProxy.transfer(account2, toUnit('990'), { from: account1 }),
							'Cannot transfer staked or escrowed HAKA'
						);
					});
				});
			});
		});

		it('should not be possible to transfer locked tribeone', async () => {
			const issuedTribeones = web3.utils.toBN('200000');
			await baseTribeoneProxy.transfer(account1, toUnit(issuedTribeones), {
				from: owner,
			});

			// Issue
			const amountIssued = toUnit('2000');
			await baseTribeoneImpl.issueSynths(amountIssued, { from: account1 });

			await assert.revert(
				baseTribeoneProxy.transfer(account2, toUnit(issuedTribeones), {
					from: account1,
				}),
				'Cannot transfer staked or escrowed HAKA'
			);
		});

		it("should lock newly received tribeone if the user's collaterisation is too high", async () => {
			// Disable Dynamic fee so that we can neglect it.
			await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

			// Set sEUR for purposes of this test
			await updateAggregatorRates(exchangeRates, circuitBreaker, [sEUR], [toUnit('0.75')]);
			await debtCache.takeDebtSnapshot();

			const issuedTribeones = web3.utils.toBN('200000');
			await baseTribeoneProxy.transfer(account1, toUnit(issuedTribeones), {
				from: owner,
			});
			await baseTribeoneProxy.transfer(account2, toUnit(issuedTribeones), {
				from: owner,
			});

			const maxIssuableSynths = await baseTribeoneImpl.maxIssuableSynths(account1);

			// Issue
			await baseTribeoneImpl.issueSynths(maxIssuableSynths, { from: account1 });

			// Exchange into sEUR
			await baseTribeoneImpl.exchange(hUSD, maxIssuableSynths, sEUR, { from: account1 });

			// Ensure that we can transfer in and out of the account successfully
			await baseTribeoneProxy.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await baseTribeoneProxy.transfer(account2, toUnit('10000'), {
				from: account1,
			});

			// Increase the value of sEUR relative to tribeone
			await updateAggregatorRates(exchangeRates, circuitBreaker, [sEUR], [toUnit('2.10')]);
			await debtCache.takeDebtSnapshot();

			// Ensure that the new tribeone account1 receives cannot be transferred out.
			await baseTribeoneProxy.transfer(account1, toUnit('10000'), {
				from: account2,
			});
			await assert.revert(
				baseTribeoneProxy.transfer(account2, toUnit('10000'), { from: account1 })
			);
		});

		it('should unlock tribeone when collaterisation ratio changes', async () => {
			// Disable Dynamic fee so that we can neglect it.
			await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

			// prevent circuit breaker from firing by upping the threshold to factor 5
			await systemSettings.setPriceDeviationThresholdFactor(toUnit('5'), { from: owner });

			// Set sAUD for purposes of this test
			const aud2usdrate = toUnit('2');

			await updateAggregatorRates(exchangeRates, null, [sAUD], [aud2usdrate]);
			await debtCache.takeDebtSnapshot();

			const issuedTribeones = web3.utils.toBN('200000');
			await baseTribeoneProxy.transfer(account1, toUnit(issuedTribeones), {
				from: owner,
			});

			// Issue
			const issuedSynths = await baseTribeoneImpl.maxIssuableSynths(account1);
			await baseTribeoneImpl.issueSynths(issuedSynths, { from: account1 });
			const remainingIssuable = (await baseTribeoneImpl.remainingIssuableSynths(account1))[0];

			assert.bnClose(remainingIssuable, '0');

			const transferable1 = await baseTribeoneProxy.transferableTribeone(account1);
			assert.bnEqual(transferable1, '0');

			// Exchange into sAUD
			await baseTribeoneImpl.exchange(hUSD, issuedSynths, sAUD, { from: account1 });

			// Increase the value of sAUD relative to tribeone
			const newAUDExchangeRate = toUnit('1');
			await updateAggregatorRates(exchangeRates, circuitBreaker, [sAUD], [newAUDExchangeRate]);
			await debtCache.takeDebtSnapshot();

			const transferable2 = await baseTribeoneProxy.transferableTribeone(account1);
			assert.equal(transferable2.gt(toUnit('1000')), true);
		});

		describe('when the user has issued some hUSD and exchanged for other synths', () => {
			beforeEach(async () => {
				await baseTribeoneImpl.issueSynths(toUnit('100'), { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sETH, { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sAUD, { from: owner });
				await baseTribeoneImpl.exchange(hUSD, toUnit('10'), sEUR, { from: owner });
			});
			it('should transfer using the ERC20 transfer function @gasprofile', async () => {
				await baseTribeoneProxy.transfer(account1, toUnit('10'), { from: owner });

				assert.bnEqual(await baseTribeoneImpl.balanceOf(account1), toUnit('10'));
			});

			it('should transfer using the ERC20 transferFrom function @gasprofile', async () => {
				const previousOwnerBalance = await baseTribeoneImpl.balanceOf(owner);

				// Approve account1 to act on our behalf for 10 HAKA.
				await baseTribeoneImpl.approve(account1, toUnit('10'), { from: owner });

				// Assert that transferFrom works.
				await baseTribeoneProxy.transferFrom(owner, account2, toUnit('10'), {
					from: account1,
				});

				// Assert that account2 has 10 HAKA and owner has 10 less HAKA
				assert.bnEqual(await baseTribeoneImpl.balanceOf(account2), toUnit('10'));
				assert.bnEqual(
					await baseTribeoneImpl.balanceOf(owner),
					previousOwnerBalance.sub(toUnit('10'))
				);

				// Assert that we can't transfer more even though there's a balance for owner.
				await assert.revert(
					baseTribeoneProxy.transferFrom(owner, account2, '1', {
						from: account1,
					})
				);
			});
		});
	});
});
