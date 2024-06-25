'use strict';

const { contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('../contracts/common');

const { toUnit, fastForward } = require('../utils')();

const { setupAllContracts, setupContract, mockToken } = require('../contracts/setup');

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('CollateralManager', async accounts => {
	const [, owner, , , account1] = accounts;

	const rETH = toBytes32('rETH');
	const rUSD = toBytes32('rUSD');
	const rBTC = toBytes32('rBTC');

	const name = 'Some name';
	const symbol = 'TOKEN';

	const INTERACTION_DELAY = 300;

	const oneRenBTC = 100000000;

	let ceth,
		cerc20,
		renBTC,
		manager,
		managerState,
		addressResolver,
		issuer,
		exchangeRates,
		feePool,
		rUSDRwa,
		rETHRwa,
		rBTCRwa,
		rwas,
		maxDebt,
		short,
		debtCache,
		tx,
		id;

	const getid = tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issue = async (rwa, issueAmount, receiver) => {
		await rwa.issue(receiver, issueAmount, { from: owner });
	};

	const updateRatesWithDefaults = async () => {
		await updateAggregatorRates(exchangeRates, null, [rETH, rBTC], [100, 10000].map(toUnit));
	};

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults();
	};

	const deployCollateral = async ({
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
		underCon,
		decimals,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralErc20',
			args: [owner, manager, resolver, collatKey, minColat, minSize, underCon, decimals],
		});
	};

	const setupManager = async () => {
		rwas = ['rUSD', 'rBTC', 'rETH', 'iBTC', 'iETH'];
		({
			ExchangeRates: exchangeRates,
			RwarUSD: rUSDRwa,
			RwarETH: rETHRwa,
			RwarBTC: rBTCRwa,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			DebtCache: debtCache,
			CollateralManager: manager,
			CollateralManagerState: managerState,
			CollateralEth: ceth,
			CollateralShort: short,
		} = await setupAllContracts({
			accounts,
			rwas,
			contracts: [
				'Rwaone',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
				'Exchanger',
				'CollateralManager',
				'CollateralManagerState',
				'CollateralEth',
				'CollateralShort',
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [rBTC, rETH]);

		maxDebt = toUnit(50000000);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		({ token: renBTC } = await mockToken({
			accounts,
			name,
			symbol,
			supply: 1e6,
		}));

		cerc20 = await deployCollateral({
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: rBTC,
			minColat: toUnit(1.5),
			minSize: toUnit(0.1),
			underCon: renBTC.address,
			decimals: 8,
		});

		// Issue ren and set allowance
		await renBTC.transfer(account1, toUnit(100), { from: owner });

		await addressResolver.importAddresses(
			[
				toBytes32('CollateralEth'),
				toBytes32('CollateralErc20'),
				toBytes32('CollateralManager'),
				toBytes32('CollateralShort'),
			],
			[ceth.address, cerc20.address, manager.address, short.address],
			{
				from: owner,
			}
		);

		await issuer.rebuildCache();
		await ceth.rebuildCache();
		await cerc20.rebuildCache();
		await debtCache.rebuildCache();
		await feePool.rebuildCache();
		await manager.rebuildCache();
		await short.rebuildCache();

		await manager.addCollaterals([ceth.address, cerc20.address, short.address], { from: owner });

		await ceth.addRwas(
			['RwarUSD', 'RwarETH'].map(toBytes32),
			['rUSD', 'rETH'].map(toBytes32),
			{ from: owner }
		);
		await cerc20.addRwas(
			['RwarUSD', 'RwarBTC'].map(toBytes32),
			['rUSD', 'rBTC'].map(toBytes32),
			{ from: owner }
		);
		await short.addRwas(
			['RwarBTC', 'RwarETH'].map(toBytes32),
			['rBTC', 'rETH'].map(toBytes32),
			{ from: owner }
		);

		await manager.addRwas(
			[toBytes32('RwarUSD'), toBytes32('RwarBTC'), toBytes32('RwarETH')],
			[toBytes32('rUSD'), toBytes32('rBTC'), toBytes32('rETH')],
			{
				from: owner,
			}
		);

		await manager.addShortableRwas(
			[toBytes32('RwarETH'), toBytes32('RwarBTC')],
			[rETH, rBTC],
			{
				from: owner,
			}
		);

		// check rwas, currencies, and shortable rwas are set
		assert.isTrue(
			await manager.areRwasAndCurrenciesSet(
				['RwarUSD', 'RwarBTC', 'RwarETH'].map(toBytes32),
				['rUSD', 'rBTC', 'rETH'].map(toBytes32)
			)
		);

		assert.isTrue(
			await manager.areShortableRwasSet(
				['RwarBTC', 'RwarETH'].map(toBytes32),
				['rBTC', 'rETH'].map(toBytes32)
			)
		);

		await renBTC.approve(cerc20.address, toUnit(100), { from: account1 });
		await rUSDRwa.approve(short.address, toUnit(100000), { from: account1 });
	};

	before(async () => {
		await setupManager();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issue(rUSDRwa, toUnit(1000), owner);
		await issue(rETHRwa, toUnit(10), owner);
		await issue(rBTCRwa, toUnit(0.1), owner);
		await debtCache.takeDebtSnapshot();
	});

	it('should set constructor params on deployment', async () => {
		assert.equal(await manager.state(), managerState.address);
		assert.equal(await manager.owner(), owner);
		assert.equal(await manager.resolver(), addressResolver.address);
		assert.bnEqual(await manager.maxDebt(), maxDebt);
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: manager.abi,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'Proxy'],
			expected: [
				'setUtilisationMultiplier',
				'setMaxDebt',
				'setMaxSkewRate',
				'setBaseBorrowRate',
				'setBaseShortRate',
				'getNewLoanId',
				'addCollaterals',
				'removeCollaterals',
				'addRwas',
				'removeRwas',
				'accrueInterest',
				'addShortableRwas',
				'removeShortableRwas',
				'updateBorrowRatesCollateral',
				'updateShortRatesCollateral',
				'incrementLongs',
				'decrementLongs',
				'incrementShorts',
				'decrementShorts',
			],
		});
	});

	it('should access its dependencies via the address resolver', async () => {
		assert.equal(await addressResolver.getAddress(toBytes32('RwarUSD')), rUSDRwa.address);
		assert.equal(await addressResolver.getAddress(toBytes32('FeePool')), feePool.address);
		assert.equal(
			await addressResolver.getAddress(toBytes32('ExchangeRates')),
			exchangeRates.address
		);
	});

	describe('getting collaterals', async () => {
		it('should add the collaterals during construction', async () => {
			assert.isTrue(await manager.hasCollateral(ceth.address));
			assert.isTrue(await manager.hasCollateral(cerc20.address));
			assert.isTrue(await manager.hasCollateral(short.address));
		});
	});

	describe('adding rwas', async () => {
		it('should add the rwas during construction', async () => {
			assert.isTrue(await manager.isRwaManaged(rUSD));
			assert.isTrue(await manager.isRwaManaged(rBTC));
			assert.isTrue(await manager.isRwaManaged(rETH));
		});
		it('should not allow duplicate rwas to be added', async () => {
			await manager.addRwas([toBytes32('RwarUSD')], [toBytes32('rUSD')], {
				from: owner,
			});
			assert.isTrue(
				await manager.areRwasAndCurrenciesSet(
					['RwarUSD', 'RwarBTC', 'RwarETH'].map(toBytes32),
					['rUSD', 'rBTC', 'rETH'].map(toBytes32)
				)
			);
		});
		it('should revert when input array lengths dont match', async () => {
			await assert.revert(
				manager.addRwas([toBytes32('RwarUSD'), toBytes32('RwarBTC')], [toBytes32('rUSD')], {
					from: owner,
				}),
				'Input array length mismatch'
			);
		});
	});

	describe('removing rwas', async () => {
		after('restore removed rwa', async () => {
			await manager.addRwas([toBytes32('RwarETH')], [toBytes32('rETH')], {
				from: owner,
			});
			assert.isTrue(
				await manager.areRwasAndCurrenciesSet(
					['RwarUSD', 'RwarBTC', 'RwarETH'].map(toBytes32),
					['rUSD', 'rBTC', 'rETH'].map(toBytes32)
				)
			);
		});
		it('should successfully remove a rwa', async () => {
			await manager.removeRwas([toBytes32('RwarETH')], [toBytes32('rETH')], {
				from: owner,
			});
			assert.isTrue(
				await manager.areRwasAndCurrenciesSet(
					['RwarUSD', 'RwarBTC'].map(toBytes32),
					['rUSD', 'rBTC'].map(toBytes32)
				)
			);
		});
		it('should revert when input array lengths dont match', async () => {
			await assert.revert(
				manager.removeRwas(
					[toBytes32('RwarUSD'), toBytes32('RwarBTC')],
					[toBytes32('rUSD')],
					{
						from: owner,
					}
				),
				'Input array length mismatch'
			);
		});
	});

	describe('default values for totalLong and totalShort', async () => {
		it('totalLong should be 0', async () => {
			const long = await manager.totalLong();
			assert.bnEqual(long.rusdValue, toUnit('0'));
		});
		it('totalShort should be 0', async () => {
			const short = await manager.totalShort();
			assert.bnEqual(short.rusdValue, toUnit('0'));
		});
	});

	describe('should only allow opening positions up to the debt limiit', async () => {
		beforeEach(async () => {
			await issue(rUSDRwa, toUnit(15000000), account1);
			await rUSDRwa.approve(short.address, toUnit(15000000), { from: account1 });
		});

		it('should not allow opening a position that would surpass the debt limit', async () => {
			await assert.revert(
				short.open(toUnit(15000000), toUnit(6000000), rETH, { from: account1 }),
				'Debt limit or invalid rate'
			);
		});
	});

	describe('tracking rwa balances across collaterals', async () => {
		beforeEach(async () => {
			tx = await ceth.open(toUnit(100), rUSD, { value: toUnit(2), from: account1 });
			await ceth.open(toUnit(1), rETH, { value: toUnit(2), from: account1 });
			await cerc20.open(oneRenBTC, toUnit(100), rUSD, { from: account1 });
			await cerc20.open(oneRenBTC, toUnit(0.01), rBTC, { from: account1 });
			await short.open(toUnit(200), toUnit(1), rETH, { from: account1 });

			id = getid(tx);
		});

		it('should correctly get the total rUSD balance', async () => {
			assert.bnEqual(await manager.long(rUSD), toUnit(200));
		});

		it('should correctly get the total rETH balance', async () => {
			assert.bnEqual(await manager.long(rETH), toUnit(1));
		});

		it('should correctly get the total rBTC balance', async () => {
			assert.bnEqual(await manager.long(rBTC), toUnit(0.01));
		});

		it('should correctly get the total short ETTH balance', async () => {
			assert.bnEqual(await manager.short(rETH), toUnit(1));
		});

		it('should get the total long balance in rUSD correctly', async () => {
			const total = await manager.totalLong();
			const debt = total.rusdValue;

			assert.bnEqual(debt, toUnit(400));
		});

		it('should get the total short balance in rUSD correctly', async () => {
			const total = await manager.totalShort();
			const debt = total.rusdValue;

			assert.bnEqual(debt, toUnit(100));
		});

		it('should get the total long and short balance in rUSD correctly', async () => {
			const total = await manager.totalLongAndShort();
			const debt = total.rusdValue;

			assert.bnEqual(debt, toUnit(500));
		});

		it('should report if a rate is invalid', async () => {
			await fastForward(await exchangeRates.rateStalePeriod());

			const long = await manager.totalLong();
			const debt = long.rusdValue;
			const invalid = long.anyRateIsInvalid;

			const short = await manager.totalShort();
			const shortDebt = short.rusdValue;
			const shortInvalid = short.anyRateIsInvalid;

			assert.bnEqual(debt, toUnit(400));
			assert.bnEqual(shortDebt, toUnit(100));
			assert.isTrue(invalid);
			assert.isTrue(shortInvalid);
		});

		it('should reduce the rUSD balance when a loan is closed', async () => {
			issue(rUSDRwa, toUnit(10), account1);
			await fastForwardAndUpdateRates(INTERACTION_DELAY);
			await ceth.close(id, { from: account1 });

			assert.bnEqual(await manager.long(rUSD), toUnit(100));
		});

		it('should reduce the total balance in rUSD when a loan is closed', async () => {
			issue(rUSDRwa, toUnit(10), account1);
			await fastForwardAndUpdateRates(INTERACTION_DELAY);
			await ceth.close(id, { from: account1 });

			const total = await manager.totalLong();
			const debt = total.rusdValue;

			assert.bnEqual(debt, toUnit(300));
		});
	});

	describe('tracking rwa balances across collaterals', async () => {
		let systemDebtBefore;

		beforeEach(async () => {
			systemDebtBefore = (await debtCache.currentDebt()).debt;

			tx = await ceth.open(toUnit(100), rUSD, { value: toUnit(2), from: account1 });

			id = getid(tx);
		});

		it('should not change the system debt.', async () => {
			assert.bnEqual((await debtCache.currentDebt()).debt, systemDebtBefore);
		});
	});

	describe('setting variables', async () => {
		describe('setUtilisationMultiplier', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						manager.setUtilisationMultiplier(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the minimum is 0', async () => {
					await assert.revert(
						manager.setUtilisationMultiplier(toUnit(0), { from: owner }),
						'Must be greater than 0'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await manager.setUtilisationMultiplier(toUnit(2), { from: owner });
				});
				it('should update the utilisation multiplier', async () => {
					assert.bnEqual(await manager.utilisationMultiplier(), toUnit(2));
				});
			});
		});

		describe('setMaxSkewRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						manager.setMaxSkewRate(toUnit(0.2), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await manager.setMaxSkewRate(toUnit(0.2), { from: owner });
				});
				it('should update the max skew rate', async () => {
					assert.bnEqual(await manager.maxSkewRate(), toUnit(0.2));
				});
				it('should allow the max skew rate to be 0', async () => {
					await manager.setMaxSkewRate(toUnit(0), { from: owner });
					assert.bnEqual(await manager.maxSkewRate(), toUnit(0));
				});
			});
		});

		describe('setBaseBorrowRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						manager.setBaseBorrowRate(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await manager.setBaseBorrowRate(toUnit(2), { from: owner });
				});
				it('should update the base interest rate', async () => {
					assert.bnEqual(await manager.baseBorrowRate(), toUnit(2));
				});
				it('should allow the base interest rate to be 0', async () => {
					await manager.setBaseBorrowRate(toUnit(0), { from: owner });
					assert.bnEqual(await manager.baseBorrowRate(), toUnit(0));
				});
			});
		});

		describe('setBaseShortRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						manager.setBaseShortRate(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await manager.setBaseShortRate(toUnit(2), { from: owner });
				});
				it('should update the base short rate', async () => {
					assert.bnEqual(await manager.baseShortRate(), toUnit(2));
				});
				it('should allow the base short rate to be 0', async () => {
					await manager.setBaseShortRate(toUnit(0), { from: owner });
					assert.bnEqual(await manager.baseShortRate(), toUnit(0));
				});
			});
		});

		describe('updateBorrowRatesCollateral', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the collateral contract', async () => {
					await assert.revert(
						manager.updateBorrowRatesCollateral(toUnit(1), { from: owner }),
						'Only collateral contracts'
					);
				});
			});
			describe('when it succeeds', async () => {
				it('updateBorrowRatesCollateral() can only be invoked by collateral', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: manager.updateBorrowRatesCollateral,
						accounts,
						args: [toUnit(1)],
						address: short.address,
						skipPassCheck: true,
						reason: 'Only collateral contracts',
					});
				});
			});
		});

		describe('updateShortRatesCollateral', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the collateral contract', async () => {
					await assert.revert(
						manager.updateShortRatesCollateral(rETH, toUnit(1), { from: owner }),
						'Only collateral contracts'
					);
				});
			});
			describe('when it succeeds', async () => {
				it('updateShortRatesCollateral() can only be invoked by collateral', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: manager.updateShortRatesCollateral,
						accounts,
						args: [rETH, toUnit(1)],
						address: short.address,
						skipPassCheck: true,
						reason: 'Only collateral contracts',
					});
				});
			});
		});
	});

	describe('adding collateral', async () => {
		describe('revert conditions', async () => {
			it('should revert if the caller is not the owner', async () => {
				await assert.revert(
					manager.addCollaterals([ZERO_ADDRESS], { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
		});

		describe('when a new collateral is added', async () => {
			beforeEach(async () => {
				await manager.addCollaterals([ZERO_ADDRESS], { from: owner });
			});

			it('should add the collateral', async () => {
				assert.isTrue(await manager.hasCollateral(ZERO_ADDRESS));
			});
		});

		describe('retreiving collateral by address', async () => {
			it('if a collateral is in the manager, it should return true', async () => {
				assert.isTrue(await manager.hasCollateral(ceth.address));
			});

			it('if a collateral is not in the manager, it should return false', async () => {
				assert.isFalse(await manager.hasCollateral(ZERO_ADDRESS));
			});
		});
	});

	describe('removing collateral', async () => {
		describe('revert conditions', async () => {
			it('should revert if the caller is not the owner', async () => {
				await assert.revert(
					manager.removeCollaterals([rBTCRwa.address], { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
		});

		describe('when a collateral is removed', async () => {
			beforeEach(async () => {
				await manager.removeCollaterals([rBTCRwa.address], { from: owner });
			});

			it('should not have the collateral', async () => {
				assert.isFalse(await manager.hasCollateral(rBTCRwa.address));
			});
		});
	});

	describe('removing rwas', async () => {
		describe('revert conditions', async () => {
			it('should revert if the caller is not the owner', async () => {
				await assert.revert(
					manager.removeRwas([toBytes32('RwarBTC')], [toBytes32('rBTC')], { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
		});

		describe('it should remove a rwa', async () => {
			beforeEach(async () => {
				await manager.removeRwas([toBytes32('RwarBTC')], [toBytes32('rBTC')], { from: owner });
			});
		});
	});

	describe('removing shortable rwas', async () => {
		describe('revert conditions', async () => {
			it('should revert if the caller is not the owner', async () => {
				await assert.revert(
					manager.removeShortableRwas([toBytes32('RwarBTC')], { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
		});

		describe('when a shortable rwa is removed', async () => {
			it('should emit the ShortableRwaRemoved event', async () => {
				const txn = await manager.removeShortableRwas([toBytes32('RwarBTC')], { from: owner });

				assert.eventEqual(txn, 'ShortableRwaRemoved', {
					rwa: toBytes32('RwarBTC'),
				});
			});
		});
	});
});
