'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const TokenState = artifacts.require('TokenState');
const Proxy = artifacts.require('Proxy');
const PurgeableTribe = artifacts.require('PurgeableTribe');

const { fastForward, toUnit } = require('../utils')();
const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const {
	setExchangeFeeRateForTribes,
	issueTribesToUser,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('PurgeableTribe', accounts => {
	const [hUSD, wHAKA, sAUD, iETH] = ['hUSD', 'wHAKA', 'sAUD', 'iETH'].map(toBytes32);
	const tribeKeys = [hUSD, sAUD, iETH];
	const [deployerAccount, owner, , , account1, account2] = accounts;

	let exchangeRates,
		exchanger,
		systemSettings,
		hUSDContract,
		sAUDContract,
		iETHContract,
		systemStatus,
		addressResolver,
		debtCache,
		issuer;

	before(async () => {
		PurgeableTribe.link(await artifacts.require('SafeDecimalMath').new());

		({
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			Exchanger: exchanger,
			TribehUSD: hUSDContract,
			TribesAUD: sAUDContract,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			DebtCache: debtCache,
			Issuer: issuer,
		} = await setupAllContracts({
			accounts,
			tribes: ['hUSD', 'sAUD'],
			contracts: [
				'ExchangeRates',
				'Exchanger',
				'DebtCache',
				'Issuer',
				'FeePool',
				'FeePoolEternalStorage',
				'Rwaone',
				'SystemStatus',
				'SystemSettings',
				'CollateralManager',
				'FuturesMarketManager',
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [sAUD, iETH]);
	});

	beforeEach(async () => {
		// set a 0.3% exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForTribes({
			owner,
			systemSettings,
			tribeKeys,
			exchangeFeeRates: tribeKeys.map(() => exchangeFeeRate),
		});
	});

	addSnapshotBeforeRestoreAfterEach();

	const deployTribe = async ({ currencyKey, proxy, tokenState }) => {
		tokenState =
			tokenState ||
			(await TokenState.new(owner, ZERO_ADDRESS, {
				from: deployerAccount,
			}));

		proxy = proxy || (await Proxy.new(owner, { from: deployerAccount }));

		const tribe = await PurgeableTribe.new(
			proxy.address,
			tokenState.address,
			`Tribe ${currencyKey}`,
			currencyKey,
			owner,
			toBytes32(currencyKey),
			web3.utils.toWei('0'),
			addressResolver.address,
			{
				from: deployerAccount,
			}
		);
		return { tribe, tokenState, proxy };
	};

	describe('when a Purgeable tribe is added and connected to Rwaone', () => {
		beforeEach(async () => {
			// Create iETH as a PurgeableTribe as we do not create any PurgeableTribe
			// in the migration script
			const { tribe, tokenState, proxy } = await deployTribe({
				currencyKey: 'iETH',
			});
			await tokenState.setAssociatedContract(tribe.address, { from: owner });
			await proxy.setTarget(tribe.address, { from: owner });
			await issuer.addTribe(tribe.address, { from: owner });

			iETHContract = tribe;
		});

		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: iETHContract.abi,
				ignoreParents: ['Tribe'],
				expected: ['purge'],
			});
		});

		it('ensure the list of resolver addresses are as expected', async () => {
			const actual = await iETHContract.resolverAddressesRequired();
			assert.deepEqual(
				actual,
				[
					'SystemStatus',
					'Exchanger',
					'Issuer',
					'FeePool',
					'FuturesMarketManager',
					'ExchangeRates',
				].map(toBytes32)
			);
		});

		it('disallow purge calls by everyone bar the owner', async () => {
			await onlyGivenAddressCanInvoke({
				accounts,
				fnc: iETHContract.purge,
				args: [[]],
				skipPassCheck: true,
				address: owner,
				reason: 'Owner only function',
			});
		});

		describe("when there's a price for the purgeable tribe", () => {
			beforeEach(async () => {
				await updateAggregatorRates(
					exchangeRates,
					null,
					[sAUD, wHAKA, iETH],
					['0.5', '1', '170'].map(toUnit)
				);
				await debtCache.takeDebtSnapshot();
			});

			describe('and a user holds 100K USD worth of purgeable tribe iETH', () => {
				let amountToExchange;
				let userhUSDBalance;
				let balanceBeforePurge;
				beforeEach(async () => {
					// issue the user 100K USD worth of iETH
					amountToExchange = toUnit(1e5);
					const iETHAmount = await exchangeRates.effectiveValue(hUSD, amountToExchange, iETH);
					await issueTribesToUser({
						owner,
						issuer,
						addressResolver,
						tribeContract: iETHContract,
						user: account1,
						amount: iETHAmount,
					});
					userhUSDBalance = await hUSDContract.balanceOf(account1);
					balanceBeforePurge = await iETHContract.balanceOf(account1);
				});

				describe('when the system is suspended', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'System', suspend: true });
					});
					it('then purge() still works as expected', async () => {
						await iETHContract.purge([account1], { from: owner });
						assert.equal(await iETHContract.balanceOf(account1), '0');
					});
				});
				describe('when the tribe is stale', () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
					});
					it('then purge() reverts', async () => {
						await assert.revert(
							iETHContract.purge([account1], { from: owner }),
							'rate stale or flagged'
						);
					});
					describe('when rates are received', () => {
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, null, [iETH], ['170'].map(toUnit));
							await debtCache.takeDebtSnapshot();
						});
						it('then purge() still works as expected', async () => {
							await iETHContract.purge([account1], { from: owner });
							assert.equal(await iETHContract.balanceOf(account1), '0');
						});
					});
				});
				describe('when purge is called for the tribe', () => {
					let txn;
					beforeEach(async () => {
						txn = await iETHContract.purge([account1], { from: owner });
					});
					it('then the user is at 0 balance', async () => {
						const userBalance = await iETHContract.balanceOf(account1);
						assert.bnEqual(
							userBalance,
							toUnit(0),
							'The user must no longer have a balance after the purge'
						);
					});
					it('and they have the value added back to hUSD (with fees taken out)', async () => {
						const userBalance = await hUSDContract.balanceOf(account1);

						const {
							amountReceived,
							// exchangeFee,
							// exchangeFeeRate,
						} = await exchanger.getAmountsForExchange(balanceBeforePurge, iETH, hUSD);

						assert.bnEqual(
							userBalance,
							amountReceived.add(userhUSDBalance),
							'User must be credited back in hUSD from the purge'
						);
					});
					it('then the tribe has totalSupply back at 0', async () => {
						const iETHTotalSupply = await iETHContract.totalSupply();
						assert.bnEqual(iETHTotalSupply, toUnit(0), 'Total supply must be 0 after the purge');
					});

					it('must issue the Purged event', () => {
						const purgedEvent = txn.logs.find(log => log.event === 'Purged');

						assert.eventEqual(purgedEvent, 'Purged', {
							account: account1,
							value: balanceBeforePurge,
						});
					});
				});

				describe('when purge is invoked with no accounts', () => {
					let txn;
					let totalSupplyBeforePurge;
					beforeEach(async () => {
						totalSupplyBeforePurge = await iETHContract.totalSupply();
						txn = await iETHContract.purge([], { from: owner });
					});
					it('then no change occurs', async () => {
						const userBalance = await iETHContract.balanceOf(account1);
						assert.bnEqual(
							userBalance,
							balanceBeforePurge,
							'The user must not be impacted by an empty purge'
						);
					});
					it('and the totalSupply must be unchanged', async () => {
						const iETHTotalSupply = await iETHContract.totalSupply();
						assert.bnEqual(
							iETHTotalSupply,
							totalSupplyBeforePurge,
							'Total supply must be unchanged'
						);
					});
					it('and no events are emitted', async () => {
						assert.equal(txn.logs.length, 0, 'No purged event must be emitted');
					});
				});

				describe('when the user holds 5000 USD worth of the purgeable tribe iETH', () => {
					beforeEach(async () => {
						// Note: 5000 is chosen to be large enough to accommodate exchange fees which
						// ultimately limit the total supply of that tribe
						const amountToExchange = toUnit(5000);
						const iETHAmount = await exchangeRates.effectiveValue(hUSD, amountToExchange, iETH);
						await issueTribesToUser({
							owner,
							issuer,
							addressResolver,
							tribeContract: iETHContract,
							user: account2,
							amount: iETHAmount,
						});
					});
					describe('when purge is invoked with both accounts', () => {
						it('then it reverts as the totalSupply exceeds the 100,000USD max', async () => {
							await assert.revert(iETHContract.purge([account1, account2], { from: owner }));
						});
					});
					describe('when purge is invoked with just one account', () => {
						it('then it reverts as the totalSupply exceeds the 100,000USD max', async () => {
							await assert.revert(iETHContract.purge([account2], { from: owner }));
						});
					});
				});
			});
		});
	});

	describe('Replacing an existing Tribe with a Purgeable one to purge and remove it', () => {
		describe('when sAUD has a price', () => {
			beforeEach(async () => {
				await updateAggregatorRates(exchangeRates, null, [sAUD], ['0.776845993'].map(toUnit));
				await debtCache.takeDebtSnapshot();
			});
			describe('when a user holds some sAUD', () => {
				let userBalanceOfOldTribe;
				let userhUSDBalance;
				beforeEach(async () => {
					const amountToExchange = toUnit('100');

					// as sAUD is MockTribe, we can invoke this directly
					await sAUDContract.issue(account1, amountToExchange);

					userhUSDBalance = await hUSDContract.balanceOf(account1);
					this.oldTribe = sAUDContract;
					userBalanceOfOldTribe = await this.oldTribe.balanceOf(account1);
					assert.equal(
						userBalanceOfOldTribe.gt(toUnit('0')),
						true,
						'The sAUD balance is greater than zero after exchange'
					);
				});

				describe('when the sAUD tribe has its totalSupply set to 0 by the owner', () => {
					beforeEach(async () => {
						this.totalSupply = await this.oldTribe.totalSupply();
						this.oldTokenState = await TokenState.at(await this.oldTribe.tokenState());
						this.oldProxy = await Proxy.at(await this.oldTribe.proxy());
						await this.oldTribe.setTotalSupply(toUnit('0'), { from: owner });
					});
					describe('and the old sAUD tribe is removed from Rwaone', () => {
						beforeEach(async () => {
							await issuer.removeTribe(sAUD, { from: owner });
						});
						describe('when a Purgeable tribe is added to replace the existing sAUD', () => {
							beforeEach(async () => {
								const { tribe } = await deployTribe({
									currencyKey: 'sAUD',
									proxy: this.oldProxy,
									tokenState: this.oldTokenState,
								});
								this.replacement = tribe;
							});
							describe('and it is added to Rwaone', () => {
								beforeEach(async () => {
									await issuer.addTribe(this.replacement.address, { from: owner });
									await this.replacement.rebuildCache();
								});

								describe('and the old sAUD TokenState and Proxy is connected to the replacement tribe', () => {
									beforeEach(async () => {
										await this.oldTokenState.setAssociatedContract(this.replacement.address, {
											from: owner,
										});
										await this.oldProxy.setTarget(this.replacement.address, { from: owner });
										// now reconnect total supply
										await this.replacement.setTotalSupply(this.totalSupply, { from: owner });
									});
									it('then the user balance has transferred', async () => {
										const balance = await this.replacement.balanceOf(account1);
										assert.bnEqual(
											balance,
											userBalanceOfOldTribe,
											'The balance after connecting TokenState must not have changed'
										);
									});
									describe('and purge is called on the replacement sAUD contract', () => {
										let txn;

										beforeEach(async () => {
											txn = await this.replacement.purge([account1], { from: owner });
										});
										it('then the user now has a 0 balance in the replacement', async () => {
											const balance = await this.replacement.balanceOf(account1);
											assert.bnEqual(balance, toUnit('0'), 'The balance after purge must be 0');
										});
										it('and their balance must have gone back into hUSD', async () => {
											const balance = await hUSDContract.balanceOf(account1);

											const { amountReceived } = await exchanger.getAmountsForExchange(
												userBalanceOfOldTribe,
												sAUD,
												hUSD
											);

											assert.bnEqual(
												balance,
												amountReceived.add(userhUSDBalance),
												'The hUSD balance after purge must return to the initial amount, less fees'
											);
										});
										it('and the purge event is issued', async () => {
											const purgedEvent = txn.logs.find(log => log.event === 'Purged');

											assert.eventEqual(purgedEvent, 'Purged', {
												account: account1,
												value: userBalanceOfOldTribe,
											});
										});
										describe('when the purged tribe is removed from the system', () => {
											beforeEach(async () => {
												await issuer.removeTribe(sAUD, { from: owner });
											});
											it('then the balance remains in USD (and no errors occur)', async () => {
												const balance = await hUSDContract.balanceOf(account1);

												const { amountReceived } = await exchanger.getAmountsForExchange(
													userBalanceOfOldTribe,
													sAUD,
													hUSD
												);

												assert.bnEqual(
													balance,
													amountReceived.add(userhUSDBalance),
													'The hUSD balance after purge must return to the initial amount, less fees'
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
	});
});
