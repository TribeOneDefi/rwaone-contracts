'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const MockExchanger = artifacts.require('MockExchanger');
const Tribe = artifacts.require('Tribe');

const { setupAllContracts } = require('./setup');

const { toUnit, bytesToString } = require('../utils')();
const {
	issueTribesToUser,
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

contract('Tribe', async accounts => {
	const [rUSD, wRWAX, sEUR] = ['rUSD', 'wRWAX', 'sEUR'].map(toBytes32);

	const [deployerAccount, owner, , , account1, account2] = accounts;

	let feePool,
		FEE_ADDRESS,
		rwaone,
		exchangeRates,
		rUSDProxy,
		rUSDImpl,
		addressResolver,
		systemStatus,
		systemSettings,
		exchanger,
		debtCache,
		issuer;

	before(async () => {
		({
			AddressResolver: addressResolver,
			Rwaone: rwaone,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			SystemStatus: systemStatus,
			Tribe: rUSDImpl,
			ProxyERC20Tribe: rUSDProxy,
			Exchanger: exchanger,
			DebtCache: debtCache,
			Issuer: issuer,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			contracts: [
				'Tribe',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage', // required for Exchanger/FeePool to access the tribe exchange fee rates
				'Rwaone',
				'SystemStatus',
				'AddressResolver',
				'DebtCache',
				'Issuer', // required to issue via Rwaone
				'LiquidatorRewards',
				'Exchanger', // required to exchange into rUSD when transferring to the FeePool
				'SystemSettings',
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral() to read collateral
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [sEUR]);

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		// use implementation ABI on the proxy address to simplify calling
		rUSDProxy = await Tribe.at(rUSDProxy.address);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// Send a price update to guarantee we're not stale.
		await updateAggregatorRates(exchangeRates, null, [wRWAX], ['0.1'].map(toUnit));
		await debtCache.takeDebtSnapshot();

		// set default issuanceRatio to 0.2
		await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
	});

	it('should set constructor params on deployment', async () => {
		const tribe = await Tribe.new(
			account1,
			account2,
			'Tribe XYZ',
			'sXYZ',
			owner,
			toBytes32('sXYZ'),
			web3.utils.toWei('100'),
			addressResolver.address,
			{ from: deployerAccount }
		);

		assert.equal(await tribe.proxy(), account1);
		assert.equal(await tribe.tokenState(), account2);
		assert.equal(await tribe.name(), 'Tribe XYZ');
		assert.equal(await tribe.symbol(), 'sXYZ');
		assert.bnEqual(await tribe.decimals(), 18);
		assert.equal(await tribe.owner(), owner);
		assert.equal(bytesToString(await tribe.currencyKey()), 'sXYZ');
		assert.bnEqual(await tribe.totalSupply(), toUnit('100'));
		assert.equal(await tribe.resolver(), addressResolver.address);
	});

	describe('mutative functions and access', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: rUSDImpl.abi,
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
					fnc: rUSDProxy.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: rUSDImpl.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
			});
		});
		describe('when non-internal tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: rUSDProxy.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: 'Only internal contracts allowed',
				});
				await onlyGivenAddressCanInvoke({
					fnc: rUSDImpl.burn,
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
				await rwaone.issueTribes(amount, { from: owner });

				// approve for transferFrom to work
				await rUSDProxy.approve(account1, amount, { from: owner });
			});
			it('approve does not revert', async () => {
				await rUSDImpl.approve(account1, amount, { from: owner });
			});
			it('transfer reverts', async () => {
				await assert.revert(rUSDImpl.transfer(account1, amount, { from: owner }), revertMsg);
			});
			it('transferFrom reverts', async () => {
				await assert.revert(
					rUSDImpl.transferFrom(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferAndSettle reverts', async () => {
				await assert.revert(
					rUSDImpl.transferAndSettle(account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferFromAndSettle reverts', async () => {
				await assert.revert(
					rUSDImpl.transferFromAndSettle(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});

			it('transfer does not revert from a whitelisted contract', async () => {
				// set owner as TribeRedeemer
				await addressResolver.importAddresses(['TribeRedeemer'].map(toBytes32), [owner], {
					from: owner,
				});
				await rUSDImpl.transfer(account1, amount, { from: owner });
			});
		});
	});

	describe('suspension conditions on transfers', () => {
		const amount = toUnit('10000');
		beforeEach(async () => {
			// ensure owner has funds
			await rwaone.issueTribes(amount, { from: owner });

			// approve for transferFrom to work
			await rUSDProxy.approve(account1, amount, { from: owner });
		});

		['System', 'Tribe'].forEach(section => {
			describe(`when ${section} is suspended`, () => {
				const tribe = toBytes32('rUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section, suspend: true, tribe });
				});
				it('when transfer() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						rUSDProxy.transfer(account1, amount, {
							from: owner,
						}),
						'Operation prohibited'
					);
				});
				it('when transferFrom() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						rUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						}),
						'Operation prohibited'
					);
				});
				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: false, tribe });
					});
					it('when transfer() is invoked, it works as expected', async () => {
						await rUSDProxy.transfer(account1, amount, {
							from: owner,
						});
					});
					it('when transferFrom() is invoked, it works as expected', async () => {
						await rUSDProxy.transferFrom(owner, account1, amount, {
							from: account1,
						});
					});
				});
			});
		});
		describe('when hETH is suspended', () => {
			const tribe = toBytes32('hETH');
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'Tribe', tribe, suspend: true });
			});
			it('when transfer() is invoked for rUSD, it works as expected', async () => {
				await rUSDProxy.transfer(account1, amount, {
					from: owner,
				});
			});
			it('when transferFrom() is invoked for rUSD, it works as expected', async () => {
				await rUSDProxy.transferFrom(owner, account1, amount, {
					from: account1,
				});
			});
			describe('when rUSD is suspended for exchanging', () => {
				const tribe = toBytes32('rUSD');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'TribeExchange', tribe, suspend: true });
				});
				it('when transfer() is invoked for rUSD, it works as expected', async () => {
					await rUSDProxy.transfer(account1, amount, {
						from: owner,
					});
				});
				it('when transferFrom() is invoked for hETH, it works as expected', async () => {
					await rUSDProxy.transferFrom(owner, account1, amount, {
						from: account1,
					});
				});
			});
		});
	});

	it('should transfer (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 rUSD.
		const amount = toUnit('10000');
		await rwaone.issueTribes(amount, { from: owner });

		// Do a single transfer of all our rUSD.
		const transaction = await rUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Events should be a fee exchange and a transfer to account1
		assert.eventEqual(
			transaction,
			// The original tribe transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await rUSDProxy.balanceOf(account1), amount);
	});

	it('should revert when transferring (ERC20) with insufficient balance', async () => {
		// Issue 10,000 rUSD.
		const amount = toUnit('10000');
		await rwaone.issueTribes(amount, { from: owner });

		// Try to transfer 10,000 + 1 wei, which we don't have the balance for.
		await assert.revert(
			rUSDProxy.transfer(account1, amount.add(web3.utils.toBN('1')), { from: owner })
		);
	});

	it('should transferFrom (ERC20) without error @gasprofile', async () => {
		// Issue 10,000 rUSD.
		const amount = toUnit('10000');
		await rwaone.issueTribes(amount, { from: owner });

		// Give account1 permission to act on our behalf
		await rUSDProxy.approve(account1, amount, { from: owner });

		// Do a single transfer of all our rUSD.
		const transaction = await rUSDProxy.transferFrom(owner, account1, amount, {
			from: account1,
		});

		// Events should be a transfer to account1
		assert.eventEqual(
			transaction,
			// The original tribe transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await rUSDProxy.balanceOf(account1), amount);

		// And allowance should be exhausted
		assert.bnEqual(await rUSDProxy.allowance(owner, account1), 0);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient allowance', async () => {
		// Issue 10,000 rUSD.
		const amount = toUnit('10000');
		await rwaone.issueTribes(amount, { from: owner });

		// Approve for 1 wei less than amount
		await rUSDProxy.approve(account1, amount.sub(web3.utils.toBN('1')), {
			from: owner,
		});

		// Try to transfer 10,000, which we don't have the allowance for.
		await assert.revert(
			rUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	it('should revert when calling transferFrom (ERC20) with insufficient balance', async () => {
		// Issue 10,000 - 1 wei rUSD.
		const amount = toUnit('10000');
		await rwaone.issueTribes(amount.sub(web3.utils.toBN('1')), { from: owner });

		// Approve for full amount
		await rUSDProxy.approve(account1, amount, { from: owner });

		// Try to transfer 10,000, which we don't have the balance for.
		await assert.revert(
			rUSDProxy.transferFrom(owner, account1, amount, {
				from: account1,
			})
		);
	});

	describe('invoking issue/burn directly as Issuer', () => {
		beforeEach(async () => {
			// Overwrite Rwaone address to the owner to allow us to invoke issue on the Tribe
			await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], { from: owner });
			// now have the tribe resync its cache
			await rUSDProxy.rebuildCache();
		});
		it('should issue successfully when called by Issuer', async () => {
			const transaction = await rUSDImpl.issue(account1, toUnit('10000'), {
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
			// Issue a bunch of tribes so we can play with them.
			await rUSDImpl.issue(owner, toUnit('10000'), {
				from: owner,
			});
			// await rwaone.issueTribes(toUnit('10000'), { from: owner });

			const transaction = await rUSDImpl.burn(owner, toUnit('10000'), { from: owner });

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
		// Issue 10,000 rUSD.
		const amount = toUnit('10000');

		await rwaone.issueTribes(amount, { from: owner });

		// Do a single transfer of all our rUSD.
		const transaction = await rUSDProxy.transfer(account1, amount, {
			from: owner,
		});

		// Event should be only a transfer to account1
		assert.eventEqual(
			transaction,

			// The original tribe transfer
			'Transfer',
			{ from: owner, to: account1, value: amount }
		);

		// Sender should have nothing
		assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

		// The recipient should have the correct amount
		assert.bnEqual(await rUSDProxy.balanceOf(account1), amount);

		// The fee pool should have zero balance
		assert.bnEqual(await rUSDProxy.balanceOf(FEE_ADDRESS), 0);
	});

	describe('transfer / transferFrom And Settle', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 1,000 rUSD.
			amount = toUnit('1000');

			await rwaone.issueTribes(amount, { from: owner });
		});

		describe('suspension conditions', () => {
			beforeEach(async () => {
				// approve for transferFrom to work
				await rUSDProxy.approve(account1, amount, { from: owner });
			});

			['System', 'Tribe'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					const tribe = toBytes32('rUSD');
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true, tribe });
					});
					it('when transferAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							rUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							}),
							'Operation prohibited'
						);
					});
					it('when transferFromAndSettle() is invoked, it reverts with operation prohibited', async () => {
						await assert.revert(
							rUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							}),
							'Operation prohibited'
						);
					});
					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false, tribe });
						});
						it('when transferAndSettle() is invoked, it works as expected', async () => {
							await rUSDProxy.transferAndSettle(account1, amount, {
								from: owner,
							});
						});
						it('when transferFromAndSettle() is invoked, it works as expected', async () => {
							await rUSDProxy.transferFromAndSettle(owner, account1, amount, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when hETH is suspended', () => {
				const tribe = toBytes32('hETH');
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'Tribe', tribe, suspend: true });
				});
				it('when transferAndSettle() is invoked for rUSD, it works as expected', async () => {
					await rUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});
				});
				it('when transferFromAndSettle() is invoked for rUSD, it works as expected', async () => {
					await rUSDProxy.transferFromAndSettle(owner, account1, amount, {
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
				exchanger = await MockExchanger.new(rwaone.address);

				await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
					from: owner,
				});
				// now have rwaone resync its cache
				await rwaone.rebuildCache();
				await rUSDImpl.rebuildCache();
			});
			it('then transferableTribes should be the total amount', async () => {
				assert.bnEqual(await rUSDProxy.transferableTribes(owner), toUnit('1000'));
			});

			describe('when max seconds in waiting period is non-zero', () => {
				beforeEach(async () => {
					await exchanger.setMaxSecsLeft('1');
				});
				it('when the tribe is attempted to be transferred away by the user, it reverts', async () => {
					await assert.revert(
						rUSDProxy.transfer(account1, toUnit('1'), { from: owner }),
						'Cannot transfer during waiting period'
					);
				});
				it('when sEUR is attempted to be transferFrom away by another user, it reverts', async () => {
					await assert.revert(
						rUSDProxy.transferFrom(owner, account2, toUnit('1'), { from: account1 }),
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
				it('then transferableTribes should be the total amount minus the reclaim', async () => {
					assert.bnEqual(await rUSDProxy.transferableTribes(owner), toUnit('990'));
				});
				it('should transfer all and settle 1000 rUSD less reclaim amount', async () => {
					// Do a single transfer of all our rUSD.
					await rUSDProxy.transferAndSettle(account1, amount, {
						from: owner,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await rUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				it('should transferFrom all and settle 1000 rUSD less reclaim amount', async () => {
					// Give account1 permission to act on our behalf
					await rUSDProxy.approve(account1, amount, { from: owner });

					// Do a single transfer of all our rUSD.
					await rUSDProxy.transferFromAndSettle(owner, account1, amount, {
						from: account1,
					});

					const expectedAmountTransferred = amount.sub(reclaimAmount);

					// Sender balance should be 0
					assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

					// The recipient should have the correct amount minus reclaimed
					assert.bnEqual(await rUSDProxy.balanceOf(account1), expectedAmountTransferred);
				});
				describe('when account has more balance than transfer amount + reclaim', async () => {
					it('should transfer 50 rUSD and burn 10 rUSD', async () => {
						const transferAmount = toUnit('50');
						// Do a single transfer of all our rUSD.
						await rUSDProxy.transferAndSettle(account1, transferAmount, {
							from: owner,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await rUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await rUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
					it('should transferFrom 50 rUSD and settle reclaim amount', async () => {
						const transferAmount = toUnit('50');

						// Give account1 permission to act on our behalf
						await rUSDProxy.approve(account1, transferAmount, { from: owner });

						// Do a single transferFrom of transferAmount.
						await rUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
							from: account1,
						});

						const expectedAmountTransferred = transferAmount;

						// Sender balance should be balance - transfer - reclaimed
						assert.bnEqual(
							await rUSDProxy.balanceOf(owner),
							amount.sub(transferAmount).sub(reclaimAmount)
						);

						// The recipient should have the correct amount
						assert.bnEqual(await rUSDProxy.balanceOf(account1), expectedAmountTransferred);
					});
				});
			});
			describe('when tribe balance after reclamation is less than requested transfer value', async () => {
				let balanceBefore;
				const reclaimAmount = toUnit('600');
				beforeEach(async () => {
					await exchanger.setReclaim(reclaimAmount);
					await exchanger.setNumEntries('1');
					balanceBefore = await rUSDProxy.balanceOf(owner);
				});
				describe('when reclaim 600 rUSD and attempting to transfer 500 rUSD tribes', async () => {
					// original balance is 1000, reclaim 600 and should send 400
					const transferAmount = toUnit('500');

					describe('using regular transfer and transferFrom', () => {
						it('via regular transfer it reverts', async () => {
							await assert.revert(
								rUSDProxy.transfer(account1, transferAmount, {
									from: owner,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
						it('via transferFrom it also reverts', async () => {
							await rUSDProxy.approve(account1, transferAmount, { from: owner });
							await assert.revert(
								rUSDProxy.transferFrom(owner, account1, transferAmount, {
									from: account1,
								}),
								'Insufficient balance after any settlement owing'
							);
						});
					});
					describe('using transferAndSettle', () => {
						it('then transferableTribes should be the total amount', async () => {
							assert.bnEqual(await rUSDProxy.transferableTribes(owner), toUnit('400'));
						});

						it('should transfer remaining balance less reclaimed', async () => {
							// Do a single transfer of all our rUSD.
							await rUSDProxy.transferAndSettle(account1, transferAmount, {
								from: owner,
							});

							// should transfer balanceAfter if less than value
							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await rUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
						it('should transferFrom and send balance minus reclaimed amount', async () => {
							// Give account1 permission to act on our behalf
							await rUSDProxy.approve(account1, transferAmount, { from: owner });

							// Do a single transferFrom of transferAmount.
							await rUSDProxy.transferFromAndSettle(owner, account1, transferAmount, {
								from: account1,
							});

							const balanceAfterReclaim = balanceBefore.sub(reclaimAmount);

							// Sender balance should be 0
							assert.bnEqual(await rUSDProxy.balanceOf(owner), 0);

							// The recipient should have the correct amount
							assert.bnEqual(await rUSDProxy.balanceOf(account1), balanceAfterReclaim);
						});
					});
				});
			});
		});
	});
	describe('when transferring tribes to FEE_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 rUSD.
			amount = toUnit('10000');

			await rwaone.issueTribes(amount, { from: owner });
		});
		it('should transfer to FEE_ADDRESS and recorded as fee', async () => {
			const feeBalanceBefore = await rUSDProxy.balanceOf(FEE_ADDRESS);

			// Do a single transfer of all our rUSD.
			const transaction = await rUSDProxy.transfer(FEE_ADDRESS, amount, {
				from: owner,
			});

			// Event should be only a transfer to FEE_ADDRESS
			assert.eventEqual(
				transaction,

				// The original tribe transfer
				'Transfer',
				{ from: owner, to: FEE_ADDRESS, value: amount }
			);

			const firstFeePeriod = await feePool.recentFeePeriods(0);
			// FEE_ADDRESS balance of rUSD increased
			assert.bnEqual(await rUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amount));

			// fees equal to amount are recorded in feesToDistribute
			assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amount));
		});

		describe('when a non-USD tribe exists', () => {
			let sEURImpl, sEURProxy;

			beforeEach(async () => {
				const sEUR = toBytes32('sEUR');

				// create a new sEUR tribe
				({ Tribe: sEURImpl, ProxyERC20Tribe: sEURProxy } = await setupAllContracts({
					accounts,
					existing: {
						ExchangeRates: exchangeRates,
						AddressResolver: addressResolver,
						SystemStatus: systemStatus,
						Issuer: issuer,
						DebtCache: debtCache,
						Exchanger: exchanger,
						FeePool: feePool,
						Rwaone: rwaone,
					},
					contracts: [{ contract: 'Tribe', properties: { currencyKey: sEUR } }],
				}));

				// Send a price update to guarantee we're not stale.
				await updateAggregatorRates(exchangeRates, null, [sEUR], ['1'].map(toUnit));
				await debtCache.takeDebtSnapshot();

				// use implementation ABI through the proxy
				sEURProxy = await Tribe.at(sEURProxy.address);
			});

			it('when transferring it to FEE_ADDRESS it should exchange into rUSD first before sending', async () => {
				// allocate the user some sEUR
				await issueTribesToUser({
					owner,
					issuer,
					addressResolver,
					tribeContract: sEURImpl,
					user: owner,
					amount,
					tribe: sEUR,
				});

				// Get balanceOf FEE_ADDRESS
				const feeBalanceBefore = await rUSDProxy.balanceOf(FEE_ADDRESS);

				// balance of sEUR after exchange fees
				const balanceOf = await sEURImpl.balanceOf(owner);

				const amountInUSD = await exchangeRates.effectiveValue(sEUR, balanceOf, rUSD);

				// Do a single transfer of all sEUR to FEE_ADDRESS
				await sEURProxy.transfer(FEE_ADDRESS, balanceOf, {
					from: owner,
				});

				const firstFeePeriod = await feePool.recentFeePeriods(0);

				// FEE_ADDRESS balance of rUSD increased by USD amount given from exchange
				assert.bnEqual(await rUSDProxy.balanceOf(FEE_ADDRESS), feeBalanceBefore.add(amountInUSD));

				// fees equal to amountInUSD are recorded in feesToDistribute
				assert.bnEqual(firstFeePeriod.feesToDistribute, feeBalanceBefore.add(amountInUSD));
			});
		});
	});

	describe('when transferring tribes to ZERO_ADDRESS', async () => {
		let amount;
		beforeEach(async () => {
			// Issue 10,000 rUSD.
			amount = toUnit('1000');

			await rwaone.issueTribes(amount, { from: owner });
		});
		it('should burn the tribes and reduce totalSupply', async () => {
			const balanceBefore = await rUSDProxy.balanceOf(owner);
			const totalSupplyBefore = await rUSDProxy.totalSupply();

			// Do a single transfer of all our rUSD to ZERO_ADDRESS.
			const transaction = await rUSDProxy.transfer(ZERO_ADDRESS, amount, {
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
			assert.bnEqual(await rUSDProxy.balanceOf(owner), balanceBefore.sub(amount));

			// total supply of tribe reduced by amount
			assert.bnEqual(await rUSDProxy.totalSupply(), totalSupplyBefore.sub(amount));
		});
	});
});
