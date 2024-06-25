'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('../contracts/common');

const {
	fastForward,
	getEthBalance,
	toUnit,
	multiplyDecimal,
	divideDecimal,
} = require('../utils')();

const {
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');

const { mockToken, setupAllContracts } = require('../contracts/setup');

const { toBytes32 } = require('../..');
const { artifacts } = require('hardhat');

contract('Depot', async accounts => {
	let rwaone,
		rwaoneProxy,
		rwa,
		depot,
		addressResolver,
		systemStatus,
		exchangeRates,
		ethRate,
		snxRate;

	const [, owner, , fundsWallet, address1, address2, address3] = accounts;

	const [wRWAX, ETH] = ['wRWAX', 'ETH'].map(toBytes32);

	const approveAndDepositRwas = async (rwasToDeposit, depositor) => {
		// Approve Transaction
		await rwa.approve(depot.address, rwasToDeposit, { from: depositor });

		// Deposit rUSD in Depot
		// console.log('Deposit rUSD in Depot amount', rwasToDeposit, depositor);
		const txn = await depot.depositRwas(rwasToDeposit, {
			from: depositor,
		});

		return txn;
	};

	// Run once at beginning - snapshots will take care of resetting this before each test
	before(async () => {
		// Mock rUSD as Depot only needs its ERC20 methods (System Pause will not work for suspending rUSD transfers)
		[{ token: rwa }] = await Promise.all([
			mockToken({ accounts, rwa: 'rUSD', name: 'RwaOne USD', symbol: 'rUSD' }),
		]);

		({
			Depot: depot,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			SystemStatus: systemStatus,
			Rwaone: rwaone,
			ProxyERC20Rwaone: rwaoneProxy,
		} = await setupAllContracts({
			accounts,
			mocks: {
				// mocks necessary for address resolver imports
				RwarUSD: rwa,
			},
			contracts: [
				'Depot',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Rwaone',
				'Issuer',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		rwaone = await artifacts.require('Rwaone').at(rwaoneProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [ETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		snxRate = toUnit('0.1');
		ethRate = toUnit('172');
		await updateAggregatorRates(exchangeRates, null, [wRWAX, ETH], [snxRate, ethRate]);
	});

	it('should set constructor params on deployment', async () => {
		assert.equal(await depot.fundsWallet(), fundsWallet);
		assert.equal(await depot.resolver(), addressResolver.address);
	});

	describe('Restricted methods', () => {
		it('ensure only known functions are mutative', () => {
			ensureOnlyExpectedMutativeFunctions({
				abi: depot.abi,
				hasFallback: true,
				ignoreParents: ['Pausable', 'ReentrancyGuard', 'MixinResolver'],
				expected: [
					'depositRwas',
					'exchangeEtherForRWAX',
					'exchangeEtherForRWAXAtRate',
					'exchangeEtherForRwas',
					'exchangeEtherForRwasAtRate',
					'exchangeRwasForRWAX',
					'exchangeRwasForRWAXAtRate',
					'setFundsWallet',
					'setMaxEthPurchase',
					'setMinimumDepositAmount',
					'withdrawMyDepositedRwas',
					'withdrawRwaone',
				],
			});
		});

		describe('setMaxEthPurchase()', () => {
			it('can only be invoked by the owner', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: depot.setMaxEthPurchase,
					args: [toUnit('25')],
					accounts,
					address: owner,
					reason: 'Only the contract owner may perform this action',
				});
			});
			it('when invoked by the owner, changes the expected property', async () => {
				const maxEthPurchase = toUnit('20');
				await depot.setMaxEthPurchase(maxEthPurchase, { from: owner });
				assert.bnEqual(await depot.maxEthPurchase(), maxEthPurchase);
			});
		});

		describe('setFundsWallet()', () => {
			it('can only be invoked by the owner', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: depot.setFundsWallet,
					args: [address1],
					accounts,
					address: owner,
					reason: 'Only the contract owner may perform this action',
				});
			});
			it('when invoked by the owner, changes the expected property', async () => {
				const transaction = await depot.setFundsWallet(address1, { from: owner });
				assert.eventEqual(transaction, 'FundsWalletUpdated', { newFundsWallet: address1 });

				assert.equal(await depot.fundsWallet(), address1);
			});
		});

		describe('setMinimumDepositAmount()', () => {
			it('can only be invoked by the owner', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: depot.setMinimumDepositAmount,
					args: [toUnit('100')],
					accounts,
					address: owner,
					reason: 'Only the contract owner may perform this action',
				});
			});
			it('can only be invoked by the owner, and with less than a unit', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: depot.setMinimumDepositAmount,
					args: [toUnit('0.1')],
					accounts,
					address: owner,
					reason: 'Only the contract owner may perform this action',
					skipPassCheck: true,
				});
			});
			it('when invoked by the owner, changes the expected property', async () => {
				const minimumDepositAmount = toUnit('100');
				const setMinimumDepositAmountTx = await depot.setMinimumDepositAmount(
					minimumDepositAmount,
					{
						from: owner,
					}
				);
				assert.eventEqual(setMinimumDepositAmountTx, 'MinimumDepositAmountUpdated', {
					amount: minimumDepositAmount,
				});
				const newMinimumDepositAmount = await depot.minimumDepositAmount();
				assert.bnEqual(newMinimumDepositAmount, minimumDepositAmount);
			});
			it('when invoked by the owner for less than a unit, reverts', async () => {
				await assert.revert(
					depot.setMinimumDepositAmount(toUnit('0.1'), { from: owner }),
					'Minimum deposit amount must be greater than UNIT'
				);
				await assert.revert(
					depot.setMinimumDepositAmount('0', { from: owner }),
					'Minimum deposit amount must be greater than UNIT'
				);
			});
		});
	});

	describe('should increment depositor smallDeposits balance', async () => {
		const rwasBalance = toUnit('100');
		const depositor = address1;

		beforeEach(async () => {
			// Set up the depositor with an amount of rwas to deposit.
			await rwa.transfer(depositor, rwasBalance, {
				from: owner,
			});
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when depositRwas is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					approveAndDepositRwas(toUnit('1'), depositor),
					'Operation prohibited'
				);
			});

			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when depositRwas is invoked, it works as expected', async () => {
					await approveAndDepositRwas(toUnit('1'), depositor);
				});
			});
		});

		it('if the deposit rwa amount is a tiny amount', async () => {
			const rwasToDeposit = toUnit('0.01');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositRwas(rwasToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, rwasToDeposit);
		});

		it('if the deposit rwa of 10 amount is less than the minimumDepositAmount', async () => {
			const rwasToDeposit = toUnit('10');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositRwas(rwasToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, rwasToDeposit);
		});

		it('if the deposit rwa amount of 49.99 is less than the minimumDepositAmount', async () => {
			const rwasToDeposit = toUnit('49.99');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositRwas(rwasToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, rwasToDeposit);
		});
	});

	describe('should accept rwa deposits', async () => {
		const rwasBalance = toUnit('100');
		const depositor = address1;

		beforeEach(async () => {
			// Set up the depositor with an amount of rwas to deposit.
			await rwa.transfer(depositor, rwasBalance, {
				from: owner,
			});
		});

		it('if the deposit rwa amount of 50 is the minimumDepositAmount', async () => {
			const rwasToDeposit = toUnit('50');

			await approveAndDepositRwas(rwasToDeposit, depositor);

			const events = await depot.getPastEvents();
			const rwaDepositEvent = events.find(log => log.event === 'RwaDeposit');
			const rwaDepositIndex = rwaDepositEvent.args.depositIndex.toString();

			assert.eventEqual(rwaDepositEvent, 'RwaDeposit', {
				user: depositor,
				amount: rwasToDeposit,
				depositIndex: rwaDepositIndex,
			});

			const depotRwaBalanceCurrent = await rwa.balanceOf(depot.address);
			assert.bnEqual(depotRwaBalanceCurrent, rwasToDeposit);

			const depositStartIndexAfter = await depot.depositStartIndex();
			const rwaDeposit = await depot.deposits.call(depositStartIndexAfter);
			assert.equal(rwaDeposit.user, depositor);
			assert.bnEqual(rwaDeposit.amount, rwasToDeposit);
		});

		it('if the deposit rwa amount of 51 is more than the minimumDepositAmount', async () => {
			const rwasToDeposit = toUnit('51');

			await approveAndDepositRwas(rwasToDeposit, depositor);

			const events = await depot.getPastEvents();
			const rwaDepositEvent = events.find(log => log.event === 'RwaDeposit');
			const rwaDepositIndex = rwaDepositEvent.args.depositIndex.toString();

			assert.eventEqual(rwaDepositEvent, 'RwaDeposit', {
				user: depositor,
				amount: rwasToDeposit,
				depositIndex: rwaDepositIndex,
			});

			const depotRwaBalanceCurrent = await rwa.balanceOf(depot.address);
			assert.bnEqual(depotRwaBalanceCurrent, rwasToDeposit);

			const depositStartIndexAfter = await depot.depositStartIndex();
			const rwaDeposit = await depot.deposits.call(depositStartIndexAfter);
			assert.equal(rwaDeposit.user, depositor);
			assert.bnEqual(rwaDeposit.amount, rwasToDeposit);
		});
	});

	describe('should not exchange ether for rwas', async () => {
		let fundsWalletFromContract;
		let fundsWalletEthBalanceBefore;
		let rwasBalance;
		let depotRwaBalanceBefore;

		beforeEach(async () => {
			fundsWalletFromContract = await depot.fundsWallet();
			fundsWalletEthBalanceBefore = await getEthBalance(fundsWallet);
			// Set up the depot so it contains some rwas to convert Ether for
			rwasBalance = await rwa.balanceOf(owner, { from: owner });

			await approveAndDepositRwas(rwasBalance, owner);

			depotRwaBalanceBefore = await rwa.balanceOf(depot.address);
		});

		it('if the price is stale', async () => {
			const rateStalePeriod = await exchangeRates.rateStalePeriod();
			await fastForward(Number(rateStalePeriod) + 1);

			// Attempt exchange
			await assert.revert(
				depot.exchangeEtherForRwas({
					from: address1,
					value: 10,
				}),
				'Rate invalid or not a rwa'
			);
			const depotRwaBalanceCurrent = await rwa.balanceOf(depot.address);
			assert.bnEqual(depotRwaBalanceCurrent, depotRwaBalanceBefore);
			assert.bnEqual(await rwa.balanceOf(address1), 0);
			assert.equal(fundsWalletFromContract, fundsWallet);
			assert.bnEqual(await getEthBalance(fundsWallet), fundsWalletEthBalanceBefore);
		});

		it('if the contract is paused', async () => {
			// Pause Contract
			await depot.setPaused(true, { from: owner });

			// Attempt exchange
			await assert.revert(
				depot.exchangeEtherForRwas({
					from: address1,
					value: 10,
				}),
				'This action cannot be performed while the contract is paused'
			);

			const depotRwaBalanceCurrent = await rwa.balanceOf(depot.address);
			assert.bnEqual(depotRwaBalanceCurrent, depotRwaBalanceBefore);
			assert.bnEqual(await rwa.balanceOf(address1), 0);
			assert.equal(fundsWalletFromContract, fundsWallet);
			assert.bnEqual(await getEthBalance(fundsWallet), fundsWalletEthBalanceBefore.toString());
		});

		it('if the system is suspended', async () => {
			const depositStartIndex = await depot.depositStartIndex();
			const depositEndIndex = await depot.depositEndIndex();

			// Assert that there is now one deposit in the queue.
			assert.equal(depositStartIndex, 0);
			assert.equal(depositEndIndex, 1);

			await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			await assert.revert(
				depot.exchangeEtherForRwas({
					from: address1,
					value: toUnit('1'),
				}),
				'Operation prohibited'
			);
			// resume
			await setStatus({ owner, systemStatus, section: 'System', suspend: false });
			// no errors
			await depot.exchangeEtherForRwas({
				from: address1,
				value: 10,
			});
		});
	});

	describe('Ensure user can exchange ETH for Rwas where the amount', async () => {
		const depositor = address1;
		const depositor2 = address2;
		const purchaser = address3;
		const rwasBalance = toUnit('1000');
		let ethUsd;

		beforeEach(async () => {
			ethUsd = await exchangeRates.rateForCurrency(ETH);

			// Assert that there are no deposits already.
			const depositStartIndex = await depot.depositStartIndex();
			const depositEndIndex = await depot.depositEndIndex();

			assert.equal(depositStartIndex, 0);
			assert.equal(depositEndIndex, 0);

			// Set up the depositor with an amount of rwas to deposit.
			await rwa.transfer(depositor, rwasBalance.toString(), {
				from: owner,
			});
			await rwa.transfer(depositor2, rwasBalance.toString(), {
				from: owner,
			});
		});

		['exchangeEtherForRwas function directly', 'fallback function'].forEach(type => {
			const isFallback = type === 'fallback function';

			describe(`using the ${type}`, () => {
				describe('when the system is suspended', () => {
					const ethToSendFromPurchaser = { from: purchaser, value: toUnit('1') };
					let fnc;
					beforeEach(async () => {
						fnc = isFallback ? 'sendTransaction' : 'exchangeEtherForRwas';
						// setup with deposits
						await approveAndDepositRwas(toUnit('1000'), depositor);

						await setStatus({ owner, systemStatus, section: 'System', suspend: true });
					});
					it(`when ${type} is invoked, it reverts with operation prohibited`, async () => {
						await assert.revert(depot[fnc](ethToSendFromPurchaser), 'Operation prohibited');
					});

					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section: 'System', suspend: false });
						});
						it('when depositRwas is invoked, it works as expected', async () => {
							await depot[fnc](ethToSendFromPurchaser);
						});
					});
				});
			});

			it('exactly matches one deposit (and that the queue is correctly updated) [ @cov-skip ]', async () => {
				const gasPrice = 1e9;

				const rwasToDeposit = ethUsd;
				const ethToSend = toUnit('1');
				const depositorStartingBalance = await getEthBalance(depositor);

				// Send the rwas to the Depot.
				const approveTxn = await rwa.approve(depot.address, rwasToDeposit, {
					from: depositor,
					gasPrice,
				});
				const gasPaidApprove = web3.utils.toBN(approveTxn.receipt.gasUsed * gasPrice);

				// Deposit rUSD in Depot
				const depositTxn = await depot.depositRwas(rwasToDeposit, {
					from: depositor,
					gasPrice,
				});

				const gasPaidDeposit = web3.utils.toBN(depositTxn.receipt.gasUsed * gasPrice);

				const depositStartIndex = await depot.depositStartIndex();
				const depositEndIndex = await depot.depositEndIndex();

				// Assert that there is now one deposit in the queue.
				assert.equal(depositStartIndex, 0);
				assert.equal(depositEndIndex, 1);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, rwasToDeposit);

				// Now purchase some.
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					txn = await depot.exchangeEtherForRwas({
						from: purchaser,
						value: ethToSend,
					});
				}

				// Exchange("ETH", msg.value, "rUSD", fulfilled);
				const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');
				assert.eventEqual(exchangeEvent, 'Exchange', {
					fromCurrency: 'ETH',
					fromAmount: ethToSend,
					toCurrency: 'rUSD',
					toAmount: rwasToDeposit,
				});

				// Purchaser should have received the Rwas
				const purchaserRwaBalance = await rwa.balanceOf(purchaser);
				assert.bnEqual(purchaserRwaBalance, rwasToDeposit);

				// Depot should no longer have the rwas
				const depotRwaBalance = await rwa.balanceOf(depot.address);
				assert.equal(depotRwaBalance, 0);

				// We should have no deposit in the queue anymore
				assert.equal(await depot.depositStartIndex(), 1);
				assert.equal(await depot.depositEndIndex(), 1);

				// And our total should be 0 as the purchase amount was equal to the deposit
				assert.equal(await depot.totalSellableDeposits(), 0);

				// The depositor should have received the ETH
				const depositorEndingBalance = await getEthBalance(depositor);
				assert.bnEqual(
					web3.utils
						.toBN(depositorEndingBalance)
						.add(gasPaidApprove)
						.add(gasPaidDeposit),
					web3.utils.toBN(depositorStartingBalance).add(ethToSend)
				);
			});

			it('is less than one deposit (and that the queue is correctly updated)', async () => {
				const rwasToDeposit = web3.utils.toBN(ethUsd); // ETH Price
				const ethToSend = toUnit('0.5');

				// Send the rwas to the Token Depot.
				await approveAndDepositRwas(rwasToDeposit, depositor);

				const depositStartIndex = await depot.depositStartIndex();
				const depositEndIndex = await depot.depositEndIndex();

				// Assert that there is now one deposit in the queue.
				assert.equal(depositStartIndex, 0);
				assert.equal(depositEndIndex, 1);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, rwasToDeposit);

				assert.bnEqual(await depot.totalSellableDeposits(), (await depot.deposits(0)).amount);

				// Now purchase some.
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					txn = await depot.exchangeEtherForRwas({
						from: purchaser,
						value: ethToSend,
					});
				}

				// Exchange("ETH", msg.value, "rUSD", fulfilled);
				const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');
				assert.eventEqual(exchangeEvent, 'Exchange', {
					fromCurrency: 'ETH',
					fromAmount: ethToSend,
					toCurrency: 'rUSD',
					toAmount: rwasToDeposit.div(web3.utils.toBN('2')),
				});

				// We should have one deposit in the queue with half the amount
				assert.equal(await depot.depositStartIndex(), 0);
				assert.equal(await depot.depositEndIndex(), 1);

				assert.bnEqual(await depot.totalSellableDeposits(), (await depot.deposits(0)).amount);

				assert.bnEqual(
					await depot.totalSellableDeposits(),
					rwasToDeposit.div(web3.utils.toBN('2'))
				);
			});

			it('exceeds one deposit (and that the queue is correctly updated)', async () => {
				const rwasToDeposit = toUnit('172'); // 1 ETH worth
				const totalRwasDeposit = toUnit('344'); // 2 ETH worth
				const ethToSend = toUnit('1.5');

				// Send the rwas to the Token Depot.
				await approveAndDepositRwas(rwasToDeposit, depositor);
				await approveAndDepositRwas(rwasToDeposit, depositor2);

				const depositStartIndex = await depot.depositStartIndex();
				const depositEndIndex = await depot.depositEndIndex();

				// Assert that there is now two deposits in the queue.
				assert.equal(depositStartIndex, 0);
				assert.equal(depositEndIndex, 2);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, totalRwasDeposit);

				// Now purchase some.
				let transaction;
				if (isFallback) {
					transaction = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					transaction = await depot.exchangeEtherForRwas({
						from: purchaser,
						value: ethToSend,
					});
				}

				// Exchange("ETH", msg.value, "rUSD", fulfilled);
				const exchangeEvent = transaction.logs.find(log => log.event === 'Exchange');
				const rwasAmount = multiplyDecimal(ethToSend, ethUsd);

				assert.eventEqual(exchangeEvent, 'Exchange', {
					fromCurrency: 'ETH',
					fromAmount: ethToSend,
					toCurrency: 'rUSD',
					toAmount: rwasAmount,
				});

				// Purchaser should have received the Rwas
				const purchaserRwaBalance = await rwa.balanceOf(purchaser);
				const depotRwaBalance = await rwa.balanceOf(depot.address);
				const remainingRwas = web3.utils.toBN(totalRwasDeposit).sub(rwasAmount);
				assert.bnEqual(purchaserRwaBalance, rwasAmount);

				assert.bnEqual(depotRwaBalance, remainingRwas);

				// We should have one deposit left in the queue
				assert.equal(await depot.depositStartIndex(), 1);
				assert.equal(await depot.depositEndIndex(), 2);

				// And our total should be totalRwasDeposit - last purchase
				assert.bnEqual(await depot.totalSellableDeposits(), remainingRwas);
			});

			xit('exceeds available rwas (and that the remainder of the ETH is correctly refunded)', async () => {
				const gasPrice = 1e9;

				const ethToSend = toUnit('2');
				const rwasToDeposit = multiplyDecimal(ethToSend, ethRate); // 344
				const purchaserInitialBalance = await getEthBalance(purchaser);

				// Send the rwas to the Token Depot.
				await approveAndDepositRwas(rwasToDeposit, depositor);

				// Assert that there is now one deposit in the queue.
				assert.equal(await depot.depositStartIndex(), 0);
				assert.equal(await depot.depositEndIndex(), 1);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.equal(totalSellableDeposits.toString(), rwasToDeposit);

				// Now purchase some
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
						gasPrice,
					});
				} else {
					txn = await depot.exchangeEtherForRwas({
						from: purchaser,
						value: ethToSend,
						gasPrice,
					});
				}

				const gasPaid = web3.utils.toBN(txn.receipt.gasUsed * gasPrice);

				// Exchange("ETH", msg.value, "rUSD", fulfilled);
				const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

				assert.eventEqual(exchangeEvent, 'Exchange', {
					fromCurrency: 'ETH',
					fromAmount: ethToSend,
					toCurrency: 'rUSD',
					toAmount: rwasToDeposit,
				});

				// We need to calculate the amount - fees the purchaser is supposed to get
				const rwasAvailableInETH = divideDecimal(rwasToDeposit, ethUsd);

				// Purchaser should have received the total available rwas
				const purchaserRwaBalance = await rwa.balanceOf(purchaser);
				assert.equal(rwasToDeposit.toString(), purchaserRwaBalance.toString());

				// Token Depot should have 0 rwas left
				const depotRwaBalance = await rwa.balanceOf(depot.address);
				assert.equal(depotRwaBalance, 0);

				// The purchaser should have received the refund
				// which can be checked by initialBalance = endBalance + fees + amount of rwas bought in ETH
				const purchaserEndingBalance = await getEthBalance(purchaser);

				// Note: currently failing under coverage via:
				// AssertionError: expected '10000000000000002397319999880134' to equal '10000000000000000000000000000000'
				// 		+ expected - actual
				// 		-10000000000000002397319999880134
				// 		+10000000000000000000000000000000
				assert.bnEqual(
					web3.utils
						.toBN(purchaserEndingBalance)
						.add(gasPaid)
						.add(rwasAvailableInETH),
					web3.utils.toBN(purchaserInitialBalance)
				);
			});
		});

		describe('exchangeEtherForRwasAtRate', () => {
			const ethToSend = toUnit('1');
			let rwasToPurchase;
			let payload;
			let txn;

			beforeEach(async () => {
				rwasToPurchase = multiplyDecimal(ethToSend, ethRate);
				payload = { from: purchaser, value: ethToSend };
				await approveAndDepositRwas(toUnit('1000'), depositor);
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeEtherForRwasAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeEtherForRwasAtRate(ethRate, payload);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');
					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'ETH',
						fromAmount: ethToSend,
						toCurrency: 'rUSD',
						toAmount: rwasToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForRwasAtRate('99', payload),
						'Guaranteed rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForRwasAtRate('9999', payload),
						'Guaranteed rate would not be received'
					);
				});
				it('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wRWAX, ETH], ['0.1', '134'].map(toUnit));
					await assert.revert(
						depot.exchangeEtherForRwasAtRate(ethRate, payload),
						'Guaranteed rate would not be received'
					);
				});
			});
		});

		describe('exchangeEtherForRWAXAtRate', () => {
			const ethToSend = toUnit('1');
			const ethToSendFromPurchaser = { from: purchaser, value: ethToSend };
			let snxToPurchase;
			let txn;

			beforeEach(async () => {
				const purchaseValueDollars = multiplyDecimal(ethToSend, ethRate);
				snxToPurchase = divideDecimal(purchaseValueDollars, snxRate);
				// Send some wRWAX to the Depot contract
				await rwaone.transfer(depot.address, toUnit('1000000'), {
					from: owner,
				});
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeEtherForRWAXAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeEtherForRWAXAtRate(ethRate, snxRate, ethToSendFromPurchaser);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'ETH',
						fromAmount: ethToSend,
						toCurrency: 'wRWAX',
						toAmount: snxToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForRWAXAtRate(ethRate, '99', ethToSendFromPurchaser),
						'Guaranteed rwaone rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForRWAXAtRate(ethRate, '9999', ethToSendFromPurchaser),
						'Guaranteed rwaone rate would not be received'
					);
				});
				it('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wRWAX, ETH], ['0.1', '134'].map(toUnit));
					await assert.revert(
						depot.exchangeEtherForRWAXAtRate(ethRate, snxRate, ethToSendFromPurchaser),
						'Guaranteed ether rate would not be received'
					);
				});
			});
		});

		describe('exchangeRwasForRWAXAtRate', () => {
			const purchaser = address1;
			const purchaserRwaAmount = toUnit('2000');
			const depotRWAXAmount = toUnit('1000000');
			const rwasToSend = toUnit('1');
			const fromPurchaser = { from: purchaser };
			let snxToPurchase;
			let txn;

			beforeEach(async () => {
				// Send the purchaser some rwas
				await rwa.transfer(purchaser, purchaserRwaAmount, {
					from: owner,
				});
				// Send some wRWAX to the Token Depot contract
				await rwaone.transfer(depot.address, depotRWAXAmount, {
					from: owner,
				});

				await rwa.approve(depot.address, rwasToSend, fromPurchaser);

				const depotRWAXBalance = await rwaone.balanceOf(depot.address);
				assert.bnEqual(depotRWAXBalance, depotRWAXAmount);

				snxToPurchase = divideDecimal(rwasToSend, snxRate);
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeRwasForRWAXAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeRwasForRWAXAtRate(rwasToSend, snxRate, fromPurchaser);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'rUSD',
						fromAmount: rwasToSend,
						toCurrency: 'wRWAX',
						toAmount: snxToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeRwasForRWAXAtRate(rwasToSend, '99', fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeRwasForRWAXAtRate(rwasToSend, '9999', fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});

				// skipped because depot is deactivated on live networks and will be removed from the repo shortly
				it.skip('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wRWAX], ['0.05'].map(toUnit));
					await assert.revert(
						depot.exchangeRwasForRWAXAtRate(rwasToSend, snxRate, fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});
			});
		});

		describe('withdrawMyDepositedRwas()', () => {
			describe('when the system is suspended', () => {
				beforeEach(async () => {
					await approveAndDepositRwas(toUnit('100'), depositor);
					await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				});
				it('when withdrawMyDepositedRwas() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						depot.withdrawMyDepositedRwas({ from: depositor }),
						'Operation prohibited'
					);
				});

				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'System', suspend: false });
					});
					it('when withdrawMyDepositedRwas() is invoked, it works as expected', async () => {
						await depot.withdrawMyDepositedRwas({ from: depositor });
					});
				});
			});

			it('Ensure user can withdraw their Rwa deposit', async () => {
				const rwasToDeposit = toUnit('500');
				// Send the rwas to the Token Depot.
				await approveAndDepositRwas(rwasToDeposit, depositor);

				const events = await depot.getPastEvents();
				const rwaDepositEvent = events.find(log => log.event === 'RwaDeposit');
				const rwaDepositIndex = rwaDepositEvent.args.depositIndex.toString();

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, rwasToDeposit);

				// Wthdraw the deposited rwas
				const txn = await depot.withdrawMyDepositedRwas({ from: depositor });
				const depositRemovedEvent = txn.logs[0];
				const withdrawEvent = txn.logs[1];

				// The sent rwas should be equal the initial deposit
				assert.eventEqual(depositRemovedEvent, 'RwaDepositRemoved', {
					user: depositor,
					amount: rwasToDeposit,
					depositIndex: rwaDepositIndex,
				});

				// Tells the DApps the deposit is removed from the fifi queue
				assert.eventEqual(withdrawEvent, 'RwaWithdrawal', {
					user: depositor,
					amount: rwasToDeposit,
				});
			});

			it('Ensure user can withdraw their Rwa deposit even if they sent an amount smaller than the minimum required', async () => {
				const rwasToDeposit = toUnit('10');

				await approveAndDepositRwas(rwasToDeposit, depositor);

				// Now balance should be equal to the amount we just sent minus the fees
				const smallDepositsBalance = await depot.smallDeposits(depositor);
				assert.bnEqual(smallDepositsBalance, rwasToDeposit);

				// Wthdraw the deposited rwas
				const txn = await depot.withdrawMyDepositedRwas({ from: depositor });
				const withdrawEvent = txn.logs[0];

				// The sent rwas should be equal the initial deposit
				assert.eventEqual(withdrawEvent, 'RwaWithdrawal', {
					user: depositor,
					amount: rwasToDeposit,
				});
			});

			it('Ensure user can withdraw their multiple Rwa deposits when they sent amounts smaller than the minimum required', async () => {
				const rwasToDeposit1 = toUnit('10');
				const rwasToDeposit2 = toUnit('15');
				const totalRwaDeposits = rwasToDeposit1.add(rwasToDeposit2);

				await approveAndDepositRwas(rwasToDeposit1, depositor);

				await approveAndDepositRwas(rwasToDeposit2, depositor);

				// Now balance should be equal to the amount we just sent minus the fees
				const smallDepositsBalance = await depot.smallDeposits(depositor);
				assert.bnEqual(smallDepositsBalance, rwasToDeposit1.add(rwasToDeposit2));

				// Wthdraw the deposited rwas
				const txn = await depot.withdrawMyDepositedRwas({ from: depositor });
				const withdrawEvent = txn.logs[0];

				// The sent rwas should be equal the initial deposit
				assert.eventEqual(withdrawEvent, 'RwaWithdrawal', {
					user: depositor,
					amount: totalRwaDeposits,
				});
			});
		});

		it('Ensure user can exchange ETH for Rwas after a withdrawal and that the queue correctly skips the empty entry', async () => {
			//   - e.g. Deposits of [1, 2, 3], user withdraws 2, so [1, (empty), 3], then
			//      - User can exchange for 1, and queue is now [(empty), 3]
			//      - User can exchange for 2 and queue is now [2]
			const deposit1 = toUnit('172');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');

			// Send the rwas to the Token Depot.
			await approveAndDepositRwas(deposit1, depositor);
			await approveAndDepositRwas(deposit2, depositor2);
			await approveAndDepositRwas(deposit3, depositor);

			// Assert that there is now three deposits in the queue.
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 3);

			// Depositor 2 withdraws Rwas
			await depot.withdrawMyDepositedRwas({ from: depositor2 });

			// Queue should be  [1, (empty), 3]
			const queueResultForDeposit2 = await depot.deposits(1);
			assert.equal(queueResultForDeposit2.amount, 0);

			// User exchange ETH for Rwas (same amount as first deposit)
			const ethToSend = divideDecimal(deposit1, ethRate);
			await depot.exchangeEtherForRwas({
				from: purchaser,
				value: ethToSend,
			});

			// Queue should now be [(empty), 3].
			assert.equal(await depot.depositStartIndex(), 1);
			assert.equal(await depot.depositEndIndex(), 3);
			const queueResultForDeposit1 = await depot.deposits(1);
			assert.equal(queueResultForDeposit1.amount, 0);

			// User exchange ETH for Rwas
			await depot.exchangeEtherForRwas({
				from: purchaser,
				value: ethToSend,
			});

			// Queue should now be [(deposit3 - rwasPurchasedAmount )]
			const remainingRwas =
				web3.utils.fromWei(deposit3) - web3.utils.fromWei(ethToSend) * web3.utils.fromWei(ethUsd);
			assert.equal(await depot.depositStartIndex(), 2);
			assert.equal(await depot.depositEndIndex(), 3);
			const totalSellableDeposits = await depot.totalSellableDeposits();
			assert.equal(totalSellableDeposits.toString(), toUnit(remainingRwas.toString()));
		});

		it('Ensure multiple users can make multiple Rwa deposits', async () => {
			const deposit1 = toUnit('100');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');
			const deposit4 = toUnit('400');

			// Send the rwas to the Token Depot.
			await approveAndDepositRwas(deposit1, depositor);
			await approveAndDepositRwas(deposit2, depositor2);
			await approveAndDepositRwas(deposit3, depositor);
			await approveAndDepositRwas(deposit4, depositor2);

			// We should have now 4 deposits
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 4);
		});

		it('Ensure multiple users can make multiple Rwa deposits and multiple withdrawals (and that the queue is correctly updated)', async () => {
			const deposit1 = toUnit('100');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');
			const deposit4 = toUnit('400');

			// Send the rwas to the Token Depot.
			await approveAndDepositRwas(deposit1, depositor);
			await approveAndDepositRwas(deposit2, depositor);
			await approveAndDepositRwas(deposit3, depositor2);
			await approveAndDepositRwas(deposit4, depositor2);

			// We should have now 4 deposits
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 4);

			// Depositors withdraws all his deposits
			await depot.withdrawMyDepositedRwas({ from: depositor });

			// We should have now 4 deposits
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 4);

			// First two deposits should be 0
			const firstDepositInQueue = await depot.deposits(0);
			const secondDepositInQueue = await depot.deposits(1);
			assert.equal(firstDepositInQueue.amount, 0);
			assert.equal(secondDepositInQueue.amount, 0);
		});
	});

	describe('Ensure user can exchange ETH for wRWAX', async () => {
		const purchaser = address1;

		beforeEach(async () => {
			// Send some wRWAX to the Depot contract
			await rwaone.transfer(depot.address, toUnit('1000000'), {
				from: owner,
			});
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when exchangeEtherForRWAX() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					depot.exchangeEtherForRWAX({
						from: purchaser,
						value: toUnit('10'),
					}),
					'Operation prohibited'
				);
			});

			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when exchangeEtherForRWAX() is invoked, it works as expected', async () => {
					await depot.exchangeEtherForRWAX({
						from: purchaser,
						value: toUnit('10'),
					});
				});
			});
		});

		it('ensure user get the correct amount of wRWAX after sending ETH', async () => {
			const ethToSend = toUnit('10');

			const purchaserRWAXStartBalance = await rwaone.balanceOf(purchaser);
			// Purchaser should not have wRWAX yet
			assert.equal(purchaserRWAXStartBalance, 0);

			// Purchaser sends ETH
			await depot.exchangeEtherForRWAX({
				from: purchaser,
				value: ethToSend,
			});

			const purchaseValueInRwas = multiplyDecimal(ethToSend, ethRate);
			const purchaseValueInRwaone = divideDecimal(purchaseValueInRwas, snxRate);

			const purchaserRWAXEndBalance = await rwaone.balanceOf(purchaser);

			// Purchaser wRWAX balance should be equal to the purchase value we calculated above
			assert.bnEqual(purchaserRWAXEndBalance, purchaseValueInRwaone);
		});
	});

	describe('Ensure user can exchange Rwas for Rwaone', async () => {
		const purchaser = address1;
		const purchaserRwaAmount = toUnit('2000');
		const depotRWAXAmount = toUnit('1000000');
		const rwasToSend = toUnit('1');

		beforeEach(async () => {
			// Send the purchaser some rwas
			await rwa.transfer(purchaser, purchaserRwaAmount, {
				from: owner,
			});
			// We need to send some wRWAX to the Token Depot contract
			await rwaone.transfer(depot.address, depotRWAXAmount, {
				from: owner,
			});

			await rwa.approve(depot.address, rwasToSend, { from: purchaser });

			const depotRWAXBalance = await rwaone.balanceOf(depot.address);
			const purchaserRwaBalance = await rwa.balanceOf(purchaser);
			assert.bnEqual(depotRWAXBalance, depotRWAXAmount);
			assert.bnEqual(purchaserRwaBalance, purchaserRwaAmount);
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when exchangeRwasForRWAX() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					depot.exchangeRwasForRWAX(rwasToSend, {
						from: purchaser,
					}),
					'Operation prohibited'
				);
			});

			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when exchangeRwasForRWAX() is invoked, it works as expected', async () => {
					await depot.exchangeRwasForRWAX(rwasToSend, {
						from: purchaser,
					});
				});
			});
		});

		it('ensure user gets the correct amount of wRWAX after sending 10 rUSD', async () => {
			const purchaserRWAXStartBalance = await rwaone.balanceOf(purchaser);
			// Purchaser should not have wRWAX yet
			assert.equal(purchaserRWAXStartBalance, 0);

			// Purchaser sends rUSD
			const txn = await depot.exchangeRwasForRWAX(rwasToSend, {
				from: purchaser,
			});

			const purchaseValueInRwaone = divideDecimal(rwasToSend, snxRate);

			const purchaserRWAXEndBalance = await rwaone.balanceOf(purchaser);

			// Purchaser wRWAX balance should be equal to the purchase value we calculated above
			assert.bnEqual(purchaserRWAXEndBalance, purchaseValueInRwaone);

			// assert the exchange event
			const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

			assert.eventEqual(exchangeEvent, 'Exchange', {
				fromCurrency: 'rUSD',
				fromAmount: rwasToSend,
				toCurrency: 'wRWAX',
				toAmount: purchaseValueInRwaone,
			});
		});
	});

	describe('withdrawRwaone', () => {
		const snxAmount = toUnit('1000000');

		beforeEach(async () => {
			// Send some wRWAX to the Depot contract
			await rwaone.transfer(depot.address, snxAmount, {
				from: owner,
			});
		});

		it('when non owner withdrawRwaone calls then revert', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: depot.withdrawRwaone,
				args: [snxAmount],
				accounts,
				address: owner,
				reason: 'Only the contract owner may perform this action',
			});
		});

		it('when owner calls withdrawRwaone then withdrawRwaone', async () => {
			const depotRWAXBalanceBefore = await rwaone.balanceOf(depot.address);

			assert.bnEqual(depotRWAXBalanceBefore, snxAmount);

			await depot.withdrawRwaone(snxAmount, { from: owner });

			const depotRWAXBalanceAfter = await rwaone.balanceOf(depot.address);
			assert.bnEqual(depotRWAXBalanceAfter, toUnit('0'));
		});
	});
});
