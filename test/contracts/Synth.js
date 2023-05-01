'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const MockExchanger = artifacts.require('MockExchanger');
const Synth = artifacts.require('Synth');

const { setupAllContracts } = require('./setup');

const { toUnit, bytesToString } = require('../utils')();
const {
	issueSynthsToUser,
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('Synth', async accounts => {
	const [uUSD, HAKA, sEUR] = ['uUSD', 'HAKA', 'sEUR'].map(toBytes32);

	const [deployerAccount, owner, , , account1, account2] = accounts;

	let feePool,
		FEE_ADDRESS,
		tribeone,
		exchangeRates,
		uUSDProxy,
		uUSDImpl,
		addressResolver,
		systemStatus,
		systemSettings,
		exchanger,
		debtCache,
		issuer;

	before(async () => {
		({
			AddressResolver: addressResolver,
			TribeOne: tribeone,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			SystemStatus: systemStatus,
			Synth: uUSDImpl,
			ProxyERC20Synth: uUSDProxy,
			Exchanger: exchanger,
			DebtCache: debtCache,
			Issuer: issuer,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			contracts: [
				'Synth',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // required for Exchanger/FeePool to access the synth exchange fee rates
				'TribeOne',
				'SystemStatus',
				'AddressResolver',
				'DebtCache',
				'Issuer', // required to issue via TribeOne
				'LiquidatorRewards',
				'Exchanger', // required to exchange into uUSD when transferring to the FeePool
				'SystemSettings',
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral() to read collateral
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [sEUR]);

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		// use implementation ABI on the proxy address to simplify calling
		uUSDProxy = await Synth.at(uUSDProxy.address);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// Send a price update to guarantee we're not stale.
		await updateAggregatorRates(exchangeRates, null, [HAKA], ['0.1'].map(toUnit));
		await debtCache.takeDebtSnapshot();

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		const synth = await Synth.new(
			account1,
			account2,
			'Synth XYZ',
			'sXYZ',
			owner,
			toBytes32('sXYZ'),
			web3.utils.toWei('100'),
			addressResolver.address,
			{ from: deployerAccount }
		);

		assert.equal(await synth.proxy(), account1);
		assert.equal(await synth.tokenState(), account2);
		assert.equal(await synth.name(), 'Synth XYZ');
		assert.equal(await synth.symbol(), 'sXYZ');
		assert.bnEqual(await synth.decimals(), 18);
		assert.equal(await synth.owner(), owner);
		assert.equal(bytesToString(await synth.currencyKey()), 'sXYZ');
		assert.bnEqual(await synth.totalSupply(), toUnit('100'));
		assert.equal(await synth.resolver(), addressResolver.address);
	});

	describe('mutative functions and access', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: uUSDImpl.abi,
				ignoreParents: ['ExternStateToken', 'MixinResolver'],
				expected: [
					'issue',
					'burn',
					'setTotalSupply',
					'transfer',
					'transferAndSettle',
					'transferFrom',
					'transferFromAndSettle',
				],
			});
		});

		describe('when non-internal contract tries to issue', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: uUSDProxy.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: uUSDImpl.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
			});
		});
		describe('when non-internal tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: uUSDProxy.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: uUSDImpl.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
			});
		});

		// SIP-238
		describe('implementation does not allow transfers but allows approve', () => {
			const amount = toUnit('10000');
			const revertMsg = 'Only the proxy';
			beforeEach(async () => {
				// ensure owner has funds
				await tribeone.issueSynths(amount, { from: owner });

				// approve for transferFrom to work
				await uUSDProxy.approve(account1, amount, { from: owner });
			});
			it('approve does not revert', async () => {
				await uUSDImpl.approve(account1, amount, { from: owner });
			});
			it('transfer reverts', async () => {
				await assert.revert(uUSDImpl.transfer(account1, amount, { from: owner }), revertMsg);
			});
			it('transferFrom reverts', async () => {
				await assert.revert(
					uUSDImpl.transferFrom(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferAndSettle reverts', async () => {
				await assert.revert(
					uUSDImpl.transferAndSettle(account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferFromAndSettle reverts', async () => {
				await assert.revert(
					uUSDImpl.transferFromAndSettle(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});

			it('transfer does not revert from a whitelisted contract', async () => {
				// set owner as SynthRedeemer
				await addressResolver.importAddresses(['SynthRedeemer'].map(toBytes32), [owner], {
					from: owner,
				});
				await uUSDImpl.transfer(account1, amount, { from: owner });
			});
		});
	});

	describe('suspension conditions on transfers', () => {
		const amount = toUnit('10000');
		beforeEach(async () => {
			// ensure owner has funds
			await tribeone.issueSynths(amount, { from: owner });

			// approve for transferFrom to work
			await uUSDProxy.approve(account1, amount, { from: owner });
		});

		['System', 'Synth'].forEach(section => {
			describe(`when ${section} is suspended`, () => {
				const synth = toBytes32('uUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section, suspend: true, synth });
				});
				it('when transfer() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						uUSDProxy.transfer(account1, amount, {
							from: owner,
						}),
						'Operation prohibited'
					);
				});
				it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						uUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						}),
						'Operation prohibited'
					);
				});
				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: false, synth });
					});
					it('when transfer() is invoked, it works as expected', async () => {
						await uUSDProxy.transfer(account1, amount, {
							from: owner,
						});
					});
					it('when transferFrom() is invoked, it works as expected', async () => {
						await uUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						});
					});
				});
			});
		});
		describe('when sETH is suspended', () => {
			const synth = toBytes32('sETH');
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
			});
			it('when transfer() is invoked for uUSD, it works as expected', async () => {
				await uUSDProxy.transfer(account1, amount, {
					from: owner,
				});
			});
			it('when transferFrom() is invoked for uUSD, it works as expected', async () => {
				await uUSDProxy.transferFrom(owner, account1, amount, {
					from: account1,
				});
			});
			describe('when uUSD is suspended for exchanging', () => {
				const synth = toBytes32('uUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'SynthExchange', synth, suspend: true });
				});
				it('when transfer() is invoked for uUSD, it works as expected', async () => {
					await uUSDProxy.transfer(account1, amount, {
						from: owner,
					});
				});
				it('when transferFrom() is invoked for sETH, it works as expected', async () => {
					await uUSDProxy.transferFrom(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});
	});

	it('should transfer (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 uUSD.
		const amount = toUnit('10000');
		await tribeone.issueSynths(amount, { from: owner });

		// Do a single transfer of all our uUSD.
		const transaction = await uUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Events should be a fee exchange and a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await uUSDProxy.balanceOf(account1), amount);
	});

	it('should revert when transferring (ERC20) with insufficient balance', async () => {
		// Issue 10,000 uUSD.
		const amount = toUnit('10000');
		await tribeone.issueSynths(amount, { from: owner });

		// Try to transfer 10,000 + 1 wei, which we don't have the balance for.
		await assert.revert(
			uUSDProxy.transfer(account1, amount.add(web3.utils.toBN('1')), { from: owner })
		);
	});

	it('should transferFrom (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 uUSD.
		const amount = toUnit('10000');
		await tribeone.issueSynths(amount, { from: owner });

		// Give account1 permission to act on our behalf
		await uUSDProxy.approve(account1, amount, { from: owner });

		// Do a single transfer of all our uUSD.
		const transaction = await uUSDProxy.transferFrom(owner, account1, amount, {
			from: account1,
		});

		// Events should be a transfer to account1
		assert.eventEqual(
			transaction,
			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await uUSDProxy.balanceOf(account1), amount);

		// And allowance should be exhausted
		assert.bnEqual(await uUSDProxy.allowance(owner, account1), 0);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient allowance', async () => {
		// Issue 10,000 uUSD.
		const amount = toUnit('10000');
		await tribeone.issueSynths(amount, { from: owner });

		// Approve for 1 wei less than amount
		await uUSDProxy.approve(account1, amount.sub(web3.utils.toBN('1')), {
			from: owner,
		});

		// Try to transfer 10,000, which we don't have the allowance for.
		await assert.revert(
			uUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient balance', async () => {
		// Issue 10,000 - 1 wei uUSD.
		const amount = toUnit('10000');
		await tribeone.issueSynths(amount.sub(web3.utils.toBN('1')), { from: owner });

		// Approve for full amount
		await uUSDProxy.approve(account1, amount, { from: owner });

		// Try to transfer 10,000, which we don't have the balance for.
		await assert.revert(
			uUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	describe('invoking issue/burn directly as Issuer', () => {
		beforeEach(async () => {
			// Overwrite TribeOne address to the owner to allow us to invoke issue on the Synth
			await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], { from: owner });
			// now have the synth resync its cache
			await uUSDProxy.rebuildCache();
		});
		it('should issue successfully when called by Issuer', async () => {
			const transaction = await uUSDImpl.issue(account1, toUnit('10000'), {
				from: owner,
			});
			assert.eventsEqual(
				transaction,
				'Transfer',
				{
					from: ZERO_ADDRESS,
					to: account1,
					value: toUnit('10000'),
				},
				'Issued',
				{
					account: account1,
					value: toUnit('10000'),
				}
			);
		});

		it('should burn successfully when called by Issuer', async () => {
			// Issue a bunch of synths so we can play with them.
			await uUSDImpl.issue(owner, toUnit('10000'), {
				from: owner,
			});
			// await tribeone.issueSynths(toUnit('10000'), { from: owner });

			const transaction = await uUSDImpl.burn(owner, toUnit('10000'), { from: owner });

			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: toUnit('10000') },
				'Burned',
				{ account: owner, value: toUnit('10000') }
			);
		});
	});

	it('should transfer (ERC20) with no fee', async () => {
		// Issue 10,000 uUSD.
		const amount = toUnit('10000');

		await tribeone.issueSynths(amount, { from: owner });

		// Do a single transfer of all our uUSD.
		const transaction = await uUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Event should be only a transfer to account1
		assert.eventEqual(
			transaction,

			// The original synth transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await uUSDProxy.balanceOf(account1), amount);

		// The fee pool should have zero balance
		assert.bnEqual(await uUSDProxy.balanceOf(FEE_ADDRESS), 0);
	});

	describe('transfer / transferFrom And Settle', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 1,000 uUSD.
			amount = toUnit('1000');

			await tribeone.issueSynths(amount, { from: owner });
		});

		describe('suspension conditions', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await uUSDProxy.approve(account1, amount, { from: owner });
			});

			['System', 'Synth'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					const synth = toBytes32('uUSD');
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true, synth });
					});
					it('when transferAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							uUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							}),
							'Operation prohibited'
						);
					});
					it('when transferFromAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							uUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							}),
							'Operation prohibited'
						);
					});
					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false, synth });
						});
						it('when transferAndSettle() is invoked, it works as expected', async () => {
							await uUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							});
						});
						it('when transferFromAndSettle() is invoked, it works as expected', async () => {
							await uUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when sETH is suspended', () => {
				const synth = toBytes32('sETH');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'Synth', synth, suspend: true });
				});
				it('when transferAndSettle() is invoked for uUSD, it works as expected', async () => {
					await uUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});
				});
				it('when transferFromAndSettle() is invoked for uUSD, it works as expected', async () => {
					await uUSDProxy.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});

		describe('with mock exchanger', () => {
			let exchanger;
			beforeEach(async () => {
				// Note: here we have a custom mock for Exchanger
				// this could use GenericMock if we added the ability for generic functions
				// to emit events and listened to those instead (so here, for Exchanger.settle() we'd
				// need to be sure it was invoked during transferAndSettle())
				exchanger = await MockExchanger.new(tribeone.address);

				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
					from: owner,
				});
				// now have tribeone resync its cache
				await tribeone.rebuildCache();
				await uUSDImpl.rebuildCache();
			});
			it('then transferableSynths should be the total amount', async () => {
				assert.bnEqual(await uUSDProxy.transferableSynths(owner), toUnit('1000'));
			});

			describe('when max seconds in waiting period is non-zero', () => {
				beforeEach(async () => {
					await exchanger.setMaxSecsLeft('1');
				});
				it('when the synth is attempted to be transferred away by the user, it reverts', async () => {
					await assert.revert(
						uUSDProxy.transfer(account1, toUnit('1'), { from: owner }),
						'Cannot transfer during waiting period'
					);
				});
				it('when sEUR is attempted to be transferFrom away by another user, it reverts', async () => {
					await assert.revert(
						uUSDProxy.transferFrom(owner, account2, toUnit('1'), { from: account1 }),
						'Cannot transfer during waiting period'
					);
				});
			});

			describe('when reclaim amount is set to 10', async () => {
				const reclaimAmount = toUnit('10');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
				});
				it('then transferableSynths should be the total amount minus the reclaim', async () => {
					assert.bnEqual(await uUSDProxy.transferableSynths(owner), toUnit('990'));
				});
				it('should transfer all and settle 1000 uUSD less reclaim amount', async () => {
					// Do a single transfer of all our uUSD.
					await uUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await uUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				it('should transferFrom all and settle 1000 uUSD less reclaim amount', async () => {
					// Give account1 permission to act on our behalf
					await uUSDProxy.approve(account1, amount, { from: owner });

					// Do a single transfer of all our uUSD.
					await uUSDProxy.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await uUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				describe('when account has more balance than transfer amount + reclaim', async () => {
					it('should transfer 50 uUSD and burn 10 uUSD', async () => {
						const transferAmount = toUnit('50');
						// Do a single transfer of all our uUSD.
						await uUSDProxy.transferAndSettle(account1, transferAmount, {
							from: owner,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await uUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await uUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
					it('should transferFrom 50 uUSD and settle reclaim amount', async () => {
						const transferAmount = toUnit('50');

						// Give account1 permission to act on our behalf
						await uUSDProxy.approve(account1, transferAmount, { from: owner });

						// Do a single transferFrom of transferAmount.
						await uUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
							from: account1,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await uUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await uUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
				});
			});
			describe('when synth balance after reclamation is less than requested transfer value', async () => {
				let balanceBefore;
				const reclaimAmount = toUnit('600');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
					balanceBefore = await uUSDProxy.balanceOf(owner);
				});
				describe('when reclaim 600 uUSD and attempting to transfer 500 uUSD synths', async () => {
					// original balance is 1000, reclaim 600 and should send 400
					const transferAmount = toUnit('500');

					describe('using regular transfer and transferFrom', () => {
						it('via regular transfer it reverts', async () => {
							await assert.revert(
								uUSDProxy.transfer(account1, transferAmount, {
									from: owner,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
						it('via transferFrom it also reverts', async () => {
							await uUSDProxy.approve(account1, transferAmount, { from: owner });
							await assert.revert(
								uUSDProxy.transferFrom(owner, account1, transferAmount, {
									from: account1,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
					});
					describe('using transferAndSettle', () => {
						it('then transferableSynths should be the total amount', async () => {
							assert.bnEqual(await uUSDProxy.transferableSynths(owner), toUnit('400'));
						});

						it('should transfer remaining balance less reclaimed', async () => {
							// Do a single transfer of all our uUSD.
							await uUSDProxy.transferAndSettle(account1, transferAmount, {
								from: owner,
							});

							// should transfer balanceAfter if less than value
							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await uUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
						it('should transferFrom and send balance minus reclaimed amount', async () => {
							// Give account1 permission to act on our behalf
							await uUSDProxy.approve(account1, transferAmount, { from: owner });

							// Do a single transferFrom of transferAmount.
							await uUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
								from: account1,
							});

							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await uUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await uUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
					});
				});
			});
		});
	});
	describe('when transferring synths to FEE_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 uUSD.
			amount = toUnit('10000');

			await tribeone.issueSynths(amount, { from: owner });
		});
		it('should transfer to FEE_ADDRESS and recorded as fee', async () => {
			const feeBalanceBefore = await uUSDProxy.balanceOf(FEE_ADDRESS);

			// Do a single transfer of all our uUSD.
			const transaction = await uUSDProxy.transfer(FEE_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to FEE_ADDRESS
			assert.eventEqual(
				transaction,

				// The original synth transfer
				'Transfer',
				{ from: owner, to: FEE_ADDRESS, value: amount }
			);

			const firstFeePeriod = await feePool.recentFeePeriods(0);
			// FEE_ADDRESS balance of uUSD increased
			assert.bnEqual(await uUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amount));

			// fees equal to amount are recorded in feesToDistribute
			assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amount));
		});

		describe('when a non-USD synth exists', () => {
			let sEURImpl, sEURProxy;

			beforeEach(async () => {
				const sEUR = toBytes32('sEUR');

				// create a new sEUR synth
				({ Synth: sEURImpl, ProxyERC20Synth: sEURProxy } = await setupAllContracts({
					accounts,
					existing: {
						ExchangeRates: exchangeRates,
						AddressResolver: addressResolver,
						SystemStatus: systemStatus,
						Issuer: issuer,
						DebtCache: debtCache,
						Exchanger: exchanger,
						FeePool: feePool,
						TribeOne: tribeone,
					},
					contracts: [{ contract: 'Synth', properties: { currencyKey: sEUR } }],
				}));

				// Send a price update to guarantee we're not stale.
				await updateAggregatorRates(exchangeRates, null, [sEUR], ['1'].map(toUnit));
				await debtCache.takeDebtSnapshot();

				// use implementation ABI through the proxy
				sEURProxy = await Synth.at(sEURProxy.address);
			});

			it('when transferring it to FEE_ADDRESS it should exchange into uUSD first before sending', async () => {
				// allocate the user some sEUR
				await issueSynthsToUser({
					owner,
					issuer,
					addressResolver,
					synthContract: sEURImpl,
					user: owner,
					amount,
					synth: sEUR,
				});

				// Get balanceOf FEE_ADDRESS
				const feeBalanceBefore = await uUSDProxy.balanceOf(FEE_ADDRESS);

				// balance of sEUR after exchange fees
				const balanceOf = await sEURImpl.balanceOf(owner);

				const amountInUSD = await exchangeRates.effectiveValue(sEUR, balanceOf, uUSD);

				// Do a single transfer of all sEUR to FEE_ADDRESS
				await sEURProxy.transfer(FEE_ADDRESS, balanceOf, {
					from: owner,
				});

				const firstFeePeriod = await feePool.recentFeePeriods(0);

				// FEE_ADDRESS balance of uUSD increased by USD amount given from exchange
				assert.bnEqual(await uUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amountInUSD));

				// fees equal to amountInUSD are recorded in feesToDistribute
				assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amountInUSD));
			});
		});
	});

	describe('when transferring synths to ZERO_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 uUSD.
			amount = toUnit('1000');

			await tribeone.issueSynths(amount, { from: owner });
		});
		it('should burn the synths and reduce totalSupply', async () => {
			const balanceBefore = await uUSDProxy.balanceOf(owner);
			const totalSupplyBefore = await uUSDProxy.totalSupply();

			// Do a single transfer of all our uUSD to ZERO_ADDRESS.
			const transaction = await uUSDProxy.transfer(ZERO_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to ZERO_ADDRESS and burn
			assert.eventsEqual(
				transaction,
				'Transfer',
				{ from: owner, to: ZERO_ADDRESS, value: amount },
				'Burned',
				{ account: owner, value: amount }
			);

			// owner balance should be less amount burned
			assert.bnEqual(await uUSDProxy.balanceOf(owner), balanceBefore.sub(amount));

			// total supply of synth reduced by amount
			assert.bnEqual(await uUSDProxy.totalSupply(), totalSupplyBefore.sub(amount));
		});
	});
});
