'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

let MultiCollateralTribe;

const {
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');
const { toUnit, fastForward } = require('../utils')();
const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const { setupAllContracts } = require('./setup');

contract('MultiCollateralTribe', accounts => {
	const [deployerAccount, owner, , , account1] = accounts;

	const hETH = toBytes32('hETH');
	const hBTC = toBytes32('hBTC');

	let issuer,
		resolver,
		manager,
		ceth,
		exchangeRates,
		managerState,
		debtCache,
		rUSDTribe,
		feePool,
		tribes;

	const getid = async tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issuerUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of tribes to deposit.
		await rUSDTribe.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	before(async () => {
		MultiCollateralTribe = artifacts.require('MultiCollateralTribe');
	});

	const onlyInternalString = 'Only internal contracts allowed';

	before(async () => {
		tribes = ['rUSD'];
		({
			AddressResolver: resolver,
			Issuer: issuer,
			TriberUSD: rUSDTribe,
			ExchangeRates: exchangeRates,
			DebtCache: debtCache,
			FeePool: feePool,
			CollateralManager: manager,
			CollateralManagerState: managerState,
			CollateralEth: ceth,
		} = await setupAllContracts({
			accounts,
			tribes,
			contracts: [
				'AddressResolver',
				'Rwaone',
				'Issuer',
				'ExchangeRates',
				'SystemStatus',
				'Exchanger',
				'FeePool',
				'CollateralUtil',
				'CollateralManager',
				'CollateralManagerState',
				'CollateralEth',
				'FuturesMarketManager',
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [hETH, hBTC]);
		await updateAggregatorRates(exchangeRates, null, [hETH, hBTC], [100, 10000].map(toUnit));

		await managerState.setAssociatedContract(manager.address, { from: owner });

		await manager.rebuildCache();
		await feePool.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([ceth.address], { from: owner });

		await issuerUSDToAccount(toUnit(1000), owner);
		await debtCache.takeDebtSnapshot();
	});

	addSnapshotBeforeRestoreAfterEach();

	const deployTribe = async ({ currencyKey, proxy, tokenState }) => {
		// As either of these could be legacy, we require them in the testing context (see buidler.config.js)
		const TokenState = artifacts.require('TokenState');
		const Proxy = artifacts.require('Proxy');

		tokenState =
			tokenState ||
			(await TokenState.new(owner, ZERO_ADDRESS, {
				from: deployerAccount,
			}));

		proxy = proxy || (await Proxy.new(owner, { from: deployerAccount }));

		const tribe = await MultiCollateralTribe.new(
			proxy.address,
			tokenState.address,
			`Tribe${currencyKey}`,
			currencyKey,
			owner,
			toBytes32(currencyKey),
			web3.utils.toWei('0'),
			resolver.address,
			{
				from: deployerAccount,
			}
		);

		await resolver.importAddresses([toBytes32(`Tribe${currencyKey}`)], [tribe.address], {
			from: owner,
		});

		await tribe.rebuildCache();
		await manager.rebuildCache();
		await debtCache.rebuildCache();

		await ceth.addTribes([toBytes32(`Tribe${currencyKey}`)], [toBytes32(currencyKey)], {
			from: owner,
		});

		return { tribe, tokenState, proxy };
	};

	describe('when a MultiCollateral tribe is added and connected to Rwaone', () => {
		beforeEach(async () => {
			const { tribe, tokenState, proxy } = await deployTribe({
				currencyKey: 'sXYZ',
			});
			await tokenState.setAssociatedContract(tribe.address, { from: owner });
			await proxy.setTarget(tribe.address, { from: owner });
			await issuer.addTribe(tribe.address, { from: owner });
			this.tribe = tribe;
			this.tribeViaProxy = await MultiCollateralTribe.at(proxy.address);
		});

		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: this.tribe.abi,
				ignoreParents: ['Tribe'],
				expected: [], // issue and burn are both overridden in MultiCollateral from Tribe
			});
		});

		it('ensure the list of resolver addresses are as expected', async () => {
			const actual = await this.tribe.resolverAddressesRequired();
			assert.deepEqual(
				actual,
				[
					'SystemStatus',
					'Exchanger',
					'Issuer',
					'FeePool',
					'FuturesMarketManager',
					'CollateralManager',
					'EtherWrapper',
					'WrapperFactory',
				].map(toBytes32)
			);
		});

		// SIP-238
		describe('implementation does not allow transfer calls (but allows approve)', () => {
			const revertMsg = 'Only the proxy';
			const amount = toUnit('100');
			beforeEach(async () => {
				// approve for transferFrom to work
				await this.tribeViaProxy.approve(account1, amount, { from: owner });
			});
			it('approve does not revert', async () => {
				await this.tribe.approve(account1, amount, { from: owner });
			});
			it('transfer reverts', async () => {
				await assert.revert(this.tribe.transfer(account1, amount, { from: owner }), revertMsg);
			});
			it('transferFrom reverts', async () => {
				await assert.revert(
					this.tribe.transferFrom(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferAndSettle reverts', async () => {
				await assert.revert(
					this.tribe.transferAndSettle(account1, amount, { from: account1 }),
					revertMsg
				);
			});
			it('transferFromAndSettle reverts', async () => {
				await assert.revert(
					this.tribe.transferFromAndSettle(owner, account1, amount, { from: account1 }),
					revertMsg
				);
			});
		});

		describe('when non-multiCollateral tries to issue', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: this.tribe.issue,
					args: [account1, toUnit('1')],
					accounts,
					reason: onlyInternalString,
				});
			});
		});
		describe('when non-multiCollateral tries to burn', () => {
			it('then it fails', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: this.tribe.burn,
					args: [account1, toUnit('1')],
					accounts,
					reason: onlyInternalString,
				});
			});
		});

		describe('when multiCollateral is set to the owner', () => {
			beforeEach(async () => {
				const sXYZ = toBytes32('sXYZ');
				await setupPriceAggregators(exchangeRates, owner, [sXYZ]);
				await updateAggregatorRates(exchangeRates, null, [sXYZ], [toUnit(5)]);
			});
			describe('when multiCollateral tries to issue', () => {
				it('then it can issue new tribes', async () => {
					const accountToIssue = account1;
					const issueAmount = toUnit('1');
					const totalSupplyBefore = await this.tribe.totalSupply();
					const balanceOfBefore = await this.tribe.balanceOf(accountToIssue);

					await ceth.open(issueAmount, toBytes32('sXYZ'), { value: toUnit(2), from: account1 });

					assert.bnEqual(await this.tribe.totalSupply(), totalSupplyBefore.add(issueAmount));
					assert.bnEqual(
						await this.tribe.balanceOf(accountToIssue),
						balanceOfBefore.add(issueAmount)
					);
				});
			});
			describe('when multiCollateral tries to burn', () => {
				it('then it can burn tribes', async () => {
					const totalSupplyBefore = await this.tribe.totalSupply();
					const balanceOfBefore = await this.tribe.balanceOf(account1);
					const amount = toUnit('5');

					const tx = await ceth.open(amount, toBytes32('sXYZ'), {
						value: toUnit(2),
						from: account1,
					});

					const id = await getid(tx);

					await fastForward(300);

					assert.bnEqual(await this.tribe.totalSupply(), totalSupplyBefore.add(amount));
					assert.bnEqual(await this.tribe.balanceOf(account1), balanceOfBefore.add(amount));

					await ceth.repay(account1, id, toUnit(3), { from: account1 });

					assert.bnEqual(await this.tribe.totalSupply(), toUnit(2));
					assert.bnEqual(await this.tribe.balanceOf(account1), toUnit(2));
				});
			});

			describe('when rwaone set to account1', () => {
				const accountToIssue = account1;
				const issueAmount = toUnit('1');

				beforeEach(async () => {
					// have account1 simulate being Issuer so we can invoke issue and burn
					await resolver.importAddresses([toBytes32('Issuer')], [accountToIssue], { from: owner });
					// now have the tribe resync its cache
					await this.tribe.rebuildCache();
				});

				it('then it can issue new tribes as account1', async () => {
					const totalSupplyBefore = await this.tribe.totalSupply();
					const balanceOfBefore = await this.tribe.balanceOf(accountToIssue);

					await this.tribe.issue(accountToIssue, issueAmount, { from: accountToIssue });

					assert.bnEqual(await this.tribe.totalSupply(), totalSupplyBefore.add(issueAmount));
					assert.bnEqual(
						await this.tribe.balanceOf(accountToIssue),
						balanceOfBefore.add(issueAmount)
					);
				});
			});
		});
	});
});
