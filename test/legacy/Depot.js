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
		tribeetixProxy,
		tribe,
		depot,
		addressResolver,
		systemStatus,
		exchangeRates,
		ethRate,
		snxRate;

	const [, owner, , fundsWallet, address1, address2, address3] = accounts;

	const [wHAKA, ETH] = ['wHAKA', 'ETH'].map(toBytes32);

	const approveAndDepositTribes = async (tribesToDeposit, depositor) => {
		// Approve Transaction
		await tribe.approve(depot.address, tribesToDeposit, { from: depositor });

		// Deposit rUSD in Depot
		// console.log('Deposit rUSD in Depot amount', tribesToDeposit, depositor);
		const txn = await depot.depositTribes(tribesToDeposit, {
			from: depositor,
		});

		return txn;
	};

	// Run once at beginning - snapshots will take care of resetting this before each test
	before(async () => {
		// Mock rUSD as Depot only needs its ERC20 methods (System Pause will not work for suspending rUSD transfers)
		[{ token: tribe }] = await Promise.all([
			mockToken({ accounts, tribe: 'rUSD', name: 'RwaOne USD', symbol: 'rUSD' }),
		]);

		({
			Depot: depot,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			SystemStatus: systemStatus,
			Rwaone: rwaone,
			ProxyERC20Rwaone: tribeetixProxy,
		} = await setupAllContracts({
			accounts,
			mocks: {
				// mocks necessary for address resolver imports
				TriberUSD: tribe,
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
		rwaone = await artifacts.require('Rwaone').at(tribeetixProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [ETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		snxRate = toUnit('0.1');
		ethRate = toUnit('172');
		await updateAggregatorRates(exchangeRates, null, [wHAKA, ETH], [snxRate, ethRate]);
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
					'depositTribes',
					'exchangeEtherForHAKA',
					'exchangeEtherForHAKAAtRate',
					'exchangeEtherForTribes',
					'exchangeEtherForTribesAtRate',
					'exchangeTribesForHAKA',
					'exchangeTribesForHAKAAtRate',
					'setFundsWallet',
					'setMaxEthPurchase',
					'setMinimumDepositAmount',
					'withdrawMyDepositedTribes',
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
		const tribesBalance = toUnit('100');
		const depositor = address1;

		beforeEach(async () => {
			// Set up the depositor with an amount of tribes to deposit.
			await tribe.transfer(depositor, tribesBalance, {
				from: owner,
			});
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when depositTribes is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					approveAndDepositTribes(toUnit('1'), depositor),
					'Operation prohibited'
				);
			});

			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when depositTribes is invoked, it works as expected', async () => {
					await approveAndDepositTribes(toUnit('1'), depositor);
				});
			});
		});

		it('if the deposit tribe amount is a tiny amount', async () => {
			const tribesToDeposit = toUnit('0.01');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositTribes(tribesToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, tribesToDeposit);
		});

		it('if the deposit tribe of 10 amount is less than the minimumDepositAmount', async () => {
			const tribesToDeposit = toUnit('10');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositTribes(tribesToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, tribesToDeposit);
		});

		it('if the deposit tribe amount of 49.99 is less than the minimumDepositAmount', async () => {
			const tribesToDeposit = toUnit('49.99');
			// Depositor should initially have a smallDeposits balance of 0
			const initialSmallDepositsBalance = await depot.smallDeposits(depositor);
			assert.equal(initialSmallDepositsBalance, 0);

			await approveAndDepositTribes(tribesToDeposit, depositor);

			// Now balance should be equal to the amount we just sent
			const smallDepositsBalance = await depot.smallDeposits(depositor);
			assert.bnEqual(smallDepositsBalance, tribesToDeposit);
		});
	});

	describe('should accept tribe deposits', async () => {
		const tribesBalance = toUnit('100');
		const depositor = address1;

		beforeEach(async () => {
			// Set up the depositor with an amount of tribes to deposit.
			await tribe.transfer(depositor, tribesBalance, {
				from: owner,
			});
		});

		it('if the deposit tribe amount of 50 is the minimumDepositAmount', async () => {
			const tribesToDeposit = toUnit('50');

			await approveAndDepositTribes(tribesToDeposit, depositor);

			const events = await depot.getPastEvents();
			const tribeDepositEvent = events.find(log => log.event === 'TribeDeposit');
			const tribeDepositIndex = tribeDepositEvent.args.depositIndex.toString();

			assert.eventEqual(tribeDepositEvent, 'TribeDeposit', {
				user: depositor,
				amount: tribesToDeposit,
				depositIndex: tribeDepositIndex,
			});

			const depotTribeBalanceCurrent = await tribe.balanceOf(depot.address);
			assert.bnEqual(depotTribeBalanceCurrent, tribesToDeposit);

			const depositStartIndexAfter = await depot.depositStartIndex();
			const tribeDeposit = await depot.deposits.call(depositStartIndexAfter);
			assert.equal(tribeDeposit.user, depositor);
			assert.bnEqual(tribeDeposit.amount, tribesToDeposit);
		});

		it('if the deposit tribe amount of 51 is more than the minimumDepositAmount', async () => {
			const tribesToDeposit = toUnit('51');

			await approveAndDepositTribes(tribesToDeposit, depositor);

			const events = await depot.getPastEvents();
			const tribeDepositEvent = events.find(log => log.event === 'TribeDeposit');
			const tribeDepositIndex = tribeDepositEvent.args.depositIndex.toString();

			assert.eventEqual(tribeDepositEvent, 'TribeDeposit', {
				user: depositor,
				amount: tribesToDeposit,
				depositIndex: tribeDepositIndex,
			});

			const depotTribeBalanceCurrent = await tribe.balanceOf(depot.address);
			assert.bnEqual(depotTribeBalanceCurrent, tribesToDeposit);

			const depositStartIndexAfter = await depot.depositStartIndex();
			const tribeDeposit = await depot.deposits.call(depositStartIndexAfter);
			assert.equal(tribeDeposit.user, depositor);
			assert.bnEqual(tribeDeposit.amount, tribesToDeposit);
		});
	});

	describe('should not exchange ether for tribes', async () => {
		let fundsWalletFromContract;
		let fundsWalletEthBalanceBefore;
		let tribesBalance;
		let depotTribeBalanceBefore;

		beforeEach(async () => {
			fundsWalletFromContract = await depot.fundsWallet();
			fundsWalletEthBalanceBefore = await getEthBalance(fundsWallet);
			// Set up the depot so it contains some tribes to convert Ether for
			tribesBalance = await tribe.balanceOf(owner, { from: owner });

			await approveAndDepositTribes(tribesBalance, owner);

			depotTribeBalanceBefore = await tribe.balanceOf(depot.address);
		});

		it('if the price is stale', async () => {
			const rateStalePeriod = await exchangeRates.rateStalePeriod();
			await fastForward(Number(rateStalePeriod) + 1);

			// Attempt exchange
			await assert.revert(
				depot.exchangeEtherForTribes({
					from: address1,
					value: 10,
				}),
				'Rate invalid or not a tribe'
			);
			const depotTribeBalanceCurrent = await tribe.balanceOf(depot.address);
			assert.bnEqual(depotTribeBalanceCurrent, depotTribeBalanceBefore);
			assert.bnEqual(await tribe.balanceOf(address1), 0);
			assert.equal(fundsWalletFromContract, fundsWallet);
			assert.bnEqual(await getEthBalance(fundsWallet), fundsWalletEthBalanceBefore);
		});

		it('if the contract is paused', async () => {
			// Pause Contract
			await depot.setPaused(true, { from: owner });

			// Attempt exchange
			await assert.revert(
				depot.exchangeEtherForTribes({
					from: address1,
					value: 10,
				}),
				'This action cannot be performed while the contract is paused'
			);

			const depotTribeBalanceCurrent = await tribe.balanceOf(depot.address);
			assert.bnEqual(depotTribeBalanceCurrent, depotTribeBalanceBefore);
			assert.bnEqual(await tribe.balanceOf(address1), 0);
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
				depot.exchangeEtherForTribes({
					from: address1,
					value: toUnit('1'),
				}),
				'Operation prohibited'
			);
			// resume
			await setStatus({ owner, systemStatus, section: 'System', suspend: false });
			// no errors
			await depot.exchangeEtherForTribes({
				from: address1,
				value: 10,
			});
		});
	});

	describe('Ensure user can exchange ETH for Tribes where the amount', async () => {
		const depositor = address1;
		const depositor2 = address2;
		const purchaser = address3;
		const tribesBalance = toUnit('1000');
		let ethUsd;

		beforeEach(async () => {
			ethUsd = await exchangeRates.rateForCurrency(ETH);

			// Assert that there are no deposits already.
			const depositStartIndex = await depot.depositStartIndex();
			const depositEndIndex = await depot.depositEndIndex();

			assert.equal(depositStartIndex, 0);
			assert.equal(depositEndIndex, 0);

			// Set up the depositor with an amount of tribes to deposit.
			await tribe.transfer(depositor, tribesBalance.toString(), {
				from: owner,
			});
			await tribe.transfer(depositor2, tribesBalance.toString(), {
				from: owner,
			});
		});

		['exchangeEtherForTribes function directly', 'fallback function'].forEach(type => {
			const isFallback = type === 'fallback function';

			describe(`using the ${type}`, () => {
				describe('when the system is suspended', () => {
					const ethToSendFromPurchaser = { from: purchaser, value: toUnit('1') };
					let fnc;
					beforeEach(async () => {
						fnc = isFallback ? 'sendTransaction' : 'exchangeEtherForTribes';
						// setup with deposits
						await approveAndDepositTribes(toUnit('1000'), depositor);

						await setStatus({ owner, systemStatus, section: 'System', suspend: true });
					});
					it(`when ${type} is invoked, it reverts with operation prohibited`, async () => {
						await assert.revert(depot[fnc](ethToSendFromPurchaser), 'Operation prohibited');
					});

					describe('when the system is resumed', () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section: 'System', suspend: false });
						});
						it('when depositTribes is invoked, it works as expected', async () => {
							await depot[fnc](ethToSendFromPurchaser);
						});
					});
				});
			});

			it('exactly matches one deposit (and that the queue is correctly updated) [ @cov-skip ]', async () => {
				const gasPrice = 1e9;

				const tribesToDeposit = ethUsd;
				const ethToSend = toUnit('1');
				const depositorStartingBalance = await getEthBalance(depositor);

				// Send the tribes to the Depot.
				const approveTxn = await tribe.approve(depot.address, tribesToDeposit, {
					from: depositor,
					gasPrice,
				});
				const gasPaidApprove = web3.utils.toBN(approveTxn.receipt.gasUsed * gasPrice);

				// Deposit rUSD in Depot
				const depositTxn = await depot.depositTribes(tribesToDeposit, {
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
				assert.bnEqual(totalSellableDeposits, tribesToDeposit);

				// Now purchase some.
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					txn = await depot.exchangeEtherForTribes({
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
					toAmount: tribesToDeposit,
				});

				// Purchaser should have received the Tribes
				const purchaserTribeBalance = await tribe.balanceOf(purchaser);
				assert.bnEqual(purchaserTribeBalance, tribesToDeposit);

				// Depot should no longer have the tribes
				const depotTribeBalance = await tribe.balanceOf(depot.address);
				assert.equal(depotTribeBalance, 0);

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
				const tribesToDeposit = web3.utils.toBN(ethUsd); // ETH Price
				const ethToSend = toUnit('0.5');

				// Send the tribes to the Token Depot.
				await approveAndDepositTribes(tribesToDeposit, depositor);

				const depositStartIndex = await depot.depositStartIndex();
				const depositEndIndex = await depot.depositEndIndex();

				// Assert that there is now one deposit in the queue.
				assert.equal(depositStartIndex, 0);
				assert.equal(depositEndIndex, 1);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, tribesToDeposit);

				assert.bnEqual(await depot.totalSellableDeposits(), (await depot.deposits(0)).amount);

				// Now purchase some.
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					txn = await depot.exchangeEtherForTribes({
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
					toAmount: tribesToDeposit.div(web3.utils.toBN('2')),
				});

				// We should have one deposit in the queue with half the amount
				assert.equal(await depot.depositStartIndex(), 0);
				assert.equal(await depot.depositEndIndex(), 1);

				assert.bnEqual(await depot.totalSellableDeposits(), (await depot.deposits(0)).amount);

				assert.bnEqual(
					await depot.totalSellableDeposits(),
					tribesToDeposit.div(web3.utils.toBN('2'))
				);
			});

			it('exceeds one deposit (and that the queue is correctly updated)', async () => {
				const tribesToDeposit = toUnit('172'); // 1 ETH worth
				const totalTribesDeposit = toUnit('344'); // 2 ETH worth
				const ethToSend = toUnit('1.5');

				// Send the tribes to the Token Depot.
				await approveAndDepositTribes(tribesToDeposit, depositor);
				await approveAndDepositTribes(tribesToDeposit, depositor2);

				const depositStartIndex = await depot.depositStartIndex();
				const depositEndIndex = await depot.depositEndIndex();

				// Assert that there is now two deposits in the queue.
				assert.equal(depositStartIndex, 0);
				assert.equal(depositEndIndex, 2);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, totalTribesDeposit);

				// Now purchase some.
				let transaction;
				if (isFallback) {
					transaction = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
					});
				} else {
					transaction = await depot.exchangeEtherForTribes({
						from: purchaser,
						value: ethToSend,
					});
				}

				// Exchange("ETH", msg.value, "rUSD", fulfilled);
				const exchangeEvent = transaction.logs.find(log => log.event === 'Exchange');
				const tribesAmount = multiplyDecimal(ethToSend, ethUsd);

				assert.eventEqual(exchangeEvent, 'Exchange', {
					fromCurrency: 'ETH',
					fromAmount: ethToSend,
					toCurrency: 'rUSD',
					toAmount: tribesAmount,
				});

				// Purchaser should have received the Tribes
				const purchaserTribeBalance = await tribe.balanceOf(purchaser);
				const depotTribeBalance = await tribe.balanceOf(depot.address);
				const remainingTribes = web3.utils.toBN(totalTribesDeposit).sub(tribesAmount);
				assert.bnEqual(purchaserTribeBalance, tribesAmount);

				assert.bnEqual(depotTribeBalance, remainingTribes);

				// We should have one deposit left in the queue
				assert.equal(await depot.depositStartIndex(), 1);
				assert.equal(await depot.depositEndIndex(), 2);

				// And our total should be totalTribesDeposit - last purchase
				assert.bnEqual(await depot.totalSellableDeposits(), remainingTribes);
			});

			xit('exceeds available tribes (and that the remainder of the ETH is correctly refunded)', async () => {
				const gasPrice = 1e9;

				const ethToSend = toUnit('2');
				const tribesToDeposit = multiplyDecimal(ethToSend, ethRate); // 344
				const purchaserInitialBalance = await getEthBalance(purchaser);

				// Send the tribes to the Token Depot.
				await approveAndDepositTribes(tribesToDeposit, depositor);

				// Assert that there is now one deposit in the queue.
				assert.equal(await depot.depositStartIndex(), 0);
				assert.equal(await depot.depositEndIndex(), 1);

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.equal(totalSellableDeposits.toString(), tribesToDeposit);

				// Now purchase some
				let txn;

				if (isFallback) {
					txn = await depot.sendTransaction({
						from: purchaser,
						value: ethToSend,
						gasPrice,
					});
				} else {
					txn = await depot.exchangeEtherForTribes({
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
					toAmount: tribesToDeposit,
				});

				// We need to calculate the amount - fees the purchaser is supposed to get
				const tribesAvailableInETH = divideDecimal(tribesToDeposit, ethUsd);

				// Purchaser should have received the total available tribes
				const purchaserTribeBalance = await tribe.balanceOf(purchaser);
				assert.equal(tribesToDeposit.toString(), purchaserTribeBalance.toString());

				// Token Depot should have 0 tribes left
				const depotTribeBalance = await tribe.balanceOf(depot.address);
				assert.equal(depotTribeBalance, 0);

				// The purchaser should have received the refund
				// which can be checked by initialBalance = endBalance + fees + amount of tribes bought in ETH
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
						.add(tribesAvailableInETH),
					web3.utils.toBN(purchaserInitialBalance)
				);
			});
		});

		describe('exchangeEtherForTribesAtRate', () => {
			const ethToSend = toUnit('1');
			let tribesToPurchase;
			let payload;
			let txn;

			beforeEach(async () => {
				tribesToPurchase = multiplyDecimal(ethToSend, ethRate);
				payload = { from: purchaser, value: ethToSend };
				await approveAndDepositTribes(toUnit('1000'), depositor);
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeEtherForTribesAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeEtherForTribesAtRate(ethRate, payload);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');
					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'ETH',
						fromAmount: ethToSend,
						toCurrency: 'rUSD',
						toAmount: tribesToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForTribesAtRate('99', payload),
						'Guaranteed rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForTribesAtRate('9999', payload),
						'Guaranteed rate would not be received'
					);
				});
				it('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wHAKA, ETH], ['0.1', '134'].map(toUnit));
					await assert.revert(
						depot.exchangeEtherForTribesAtRate(ethRate, payload),
						'Guaranteed rate would not be received'
					);
				});
			});
		});

		describe('exchangeEtherForHAKAAtRate', () => {
			const ethToSend = toUnit('1');
			const ethToSendFromPurchaser = { from: purchaser, value: ethToSend };
			let snxToPurchase;
			let txn;

			beforeEach(async () => {
				const purchaseValueDollars = multiplyDecimal(ethToSend, ethRate);
				snxToPurchase = divideDecimal(purchaseValueDollars, snxRate);
				// Send some wHAKA to the Depot contract
				await rwaone.transfer(depot.address, toUnit('1000000'), {
					from: owner,
				});
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeEtherForHAKAAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeEtherForHAKAAtRate(ethRate, snxRate, ethToSendFromPurchaser);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'ETH',
						fromAmount: ethToSend,
						toCurrency: 'wHAKA',
						toAmount: snxToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForHAKAAtRate(ethRate, '99', ethToSendFromPurchaser),
						'Guaranteed rwaone rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeEtherForHAKAAtRate(ethRate, '9999', ethToSendFromPurchaser),
						'Guaranteed rwaone rate would not be received'
					);
				});
				it('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wHAKA, ETH], ['0.1', '134'].map(toUnit));
					await assert.revert(
						depot.exchangeEtherForHAKAAtRate(ethRate, snxRate, ethToSendFromPurchaser),
						'Guaranteed ether rate would not be received'
					);
				});
			});
		});

		describe('exchangeTribesForHAKAAtRate', () => {
			const purchaser = address1;
			const purchaserTribeAmount = toUnit('2000');
			const depotHAKAAmount = toUnit('1000000');
			const tribesToSend = toUnit('1');
			const fromPurchaser = { from: purchaser };
			let snxToPurchase;
			let txn;

			beforeEach(async () => {
				// Send the purchaser some tribes
				await tribe.transfer(purchaser, purchaserTribeAmount, {
					from: owner,
				});
				// Send some wHAKA to the Token Depot contract
				await rwaone.transfer(depot.address, depotHAKAAmount, {
					from: owner,
				});

				await tribe.approve(depot.address, tribesToSend, fromPurchaser);

				const depotHAKABalance = await rwaone.balanceOf(depot.address);
				assert.bnEqual(depotHAKABalance, depotHAKAAmount);

				snxToPurchase = divideDecimal(tribesToSend, snxRate);
			});

			describe('when the purchaser supplies a rate', () => {
				it('when exchangeTribesForHAKAAtRate is invoked, it works as expected', async () => {
					txn = await depot.exchangeTribesForHAKAAtRate(tribesToSend, snxRate, fromPurchaser);
					const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

					assert.eventEqual(exchangeEvent, 'Exchange', {
						fromCurrency: 'rUSD',
						fromAmount: tribesToSend,
						toCurrency: 'wHAKA',
						toAmount: snxToPurchase,
					});
				});
				it('when purchaser supplies a rate lower than the current rate', async () => {
					await assert.revert(
						depot.exchangeTribesForHAKAAtRate(tribesToSend, '99', fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});
				it('when purchaser supplies a rate higher than the current rate', async () => {
					await assert.revert(
						depot.exchangeTribesForHAKAAtRate(tribesToSend, '9999', fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});

				// skipped because depot is deactivated on live networks and will be removed from the repo shortly
				it.skip('when the purchaser supplies a rate and the rate is changed in by the oracle', async () => {
					await updateAggregatorRates(exchangeRates, null, [wHAKA], ['0.05'].map(toUnit));
					await assert.revert(
						depot.exchangeTribesForHAKAAtRate(tribesToSend, snxRate, fromPurchaser),
						'Guaranteed rate would not be received'
					);
				});
			});
		});

		describe('withdrawMyDepositedTribes()', () => {
			describe('when the system is suspended', () => {
				beforeEach(async () => {
					await approveAndDepositTribes(toUnit('100'), depositor);
					await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				});
				it('when withdrawMyDepositedTribes() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						depot.withdrawMyDepositedTribes({ from: depositor }),
						'Operation prohibited'
					);
				});

				describe('when the system is resumed', () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section: 'System', suspend: false });
					});
					it('when withdrawMyDepositedTribes() is invoked, it works as expected', async () => {
						await depot.withdrawMyDepositedTribes({ from: depositor });
					});
				});
			});

			it('Ensure user can withdraw their Tribe deposit', async () => {
				const tribesToDeposit = toUnit('500');
				// Send the tribes to the Token Depot.
				await approveAndDepositTribes(tribesToDeposit, depositor);

				const events = await depot.getPastEvents();
				const tribeDepositEvent = events.find(log => log.event === 'TribeDeposit');
				const tribeDepositIndex = tribeDepositEvent.args.depositIndex.toString();

				// And assert that our total has increased by the right amount.
				const totalSellableDeposits = await depot.totalSellableDeposits();
				assert.bnEqual(totalSellableDeposits, tribesToDeposit);

				// Wthdraw the deposited tribes
				const txn = await depot.withdrawMyDepositedTribes({ from: depositor });
				const depositRemovedEvent = txn.logs[0];
				const withdrawEvent = txn.logs[1];

				// The sent tribes should be equal the initial deposit
				assert.eventEqual(depositRemovedEvent, 'TribeDepositRemoved', {
					user: depositor,
					amount: tribesToDeposit,
					depositIndex: tribeDepositIndex,
				});

				// Tells the DApps the deposit is removed from the fifi queue
				assert.eventEqual(withdrawEvent, 'TribeWithdrawal', {
					user: depositor,
					amount: tribesToDeposit,
				});
			});

			it('Ensure user can withdraw their Tribe deposit even if they sent an amount smaller than the minimum required', async () => {
				const tribesToDeposit = toUnit('10');

				await approveAndDepositTribes(tribesToDeposit, depositor);

				// Now balance should be equal to the amount we just sent minus the fees
				const smallDepositsBalance = await depot.smallDeposits(depositor);
				assert.bnEqual(smallDepositsBalance, tribesToDeposit);

				// Wthdraw the deposited tribes
				const txn = await depot.withdrawMyDepositedTribes({ from: depositor });
				const withdrawEvent = txn.logs[0];

				// The sent tribes should be equal the initial deposit
				assert.eventEqual(withdrawEvent, 'TribeWithdrawal', {
					user: depositor,
					amount: tribesToDeposit,
				});
			});

			it('Ensure user can withdraw their multiple Tribe deposits when they sent amounts smaller than the minimum required', async () => {
				const tribesToDeposit1 = toUnit('10');
				const tribesToDeposit2 = toUnit('15');
				const totalTribeDeposits = tribesToDeposit1.add(tribesToDeposit2);

				await approveAndDepositTribes(tribesToDeposit1, depositor);

				await approveAndDepositTribes(tribesToDeposit2, depositor);

				// Now balance should be equal to the amount we just sent minus the fees
				const smallDepositsBalance = await depot.smallDeposits(depositor);
				assert.bnEqual(smallDepositsBalance, tribesToDeposit1.add(tribesToDeposit2));

				// Wthdraw the deposited tribes
				const txn = await depot.withdrawMyDepositedTribes({ from: depositor });
				const withdrawEvent = txn.logs[0];

				// The sent tribes should be equal the initial deposit
				assert.eventEqual(withdrawEvent, 'TribeWithdrawal', {
					user: depositor,
					amount: totalTribeDeposits,
				});
			});
		});

		it('Ensure user can exchange ETH for Tribes after a withdrawal and that the queue correctly skips the empty entry', async () => {
			//   - e.g. Deposits of [1, 2, 3], user withdraws 2, so [1, (empty), 3], then
			//      - User can exchange for 1, and queue is now [(empty), 3]
			//      - User can exchange for 2 and queue is now [2]
			const deposit1 = toUnit('172');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');

			// Send the tribes to the Token Depot.
			await approveAndDepositTribes(deposit1, depositor);
			await approveAndDepositTribes(deposit2, depositor2);
			await approveAndDepositTribes(deposit3, depositor);

			// Assert that there is now three deposits in the queue.
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 3);

			// Depositor 2 withdraws Tribes
			await depot.withdrawMyDepositedTribes({ from: depositor2 });

			// Queue should be  [1, (empty), 3]
			const queueResultForDeposit2 = await depot.deposits(1);
			assert.equal(queueResultForDeposit2.amount, 0);

			// User exchange ETH for Tribes (same amount as first deposit)
			const ethToSend = divideDecimal(deposit1, ethRate);
			await depot.exchangeEtherForTribes({
				from: purchaser,
				value: ethToSend,
			});

			// Queue should now be [(empty), 3].
			assert.equal(await depot.depositStartIndex(), 1);
			assert.equal(await depot.depositEndIndex(), 3);
			const queueResultForDeposit1 = await depot.deposits(1);
			assert.equal(queueResultForDeposit1.amount, 0);

			// User exchange ETH for Tribes
			await depot.exchangeEtherForTribes({
				from: purchaser,
				value: ethToSend,
			});

			// Queue should now be [(deposit3 - tribesPurchasedAmount )]
			const remainingTribes =
				web3.utils.fromWei(deposit3) - web3.utils.fromWei(ethToSend) * web3.utils.fromWei(ethUsd);
			assert.equal(await depot.depositStartIndex(), 2);
			assert.equal(await depot.depositEndIndex(), 3);
			const totalSellableDeposits = await depot.totalSellableDeposits();
			assert.equal(totalSellableDeposits.toString(), toUnit(remainingTribes.toString()));
		});

		it('Ensure multiple users can make multiple Tribe deposits', async () => {
			const deposit1 = toUnit('100');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');
			const deposit4 = toUnit('400');

			// Send the tribes to the Token Depot.
			await approveAndDepositTribes(deposit1, depositor);
			await approveAndDepositTribes(deposit2, depositor2);
			await approveAndDepositTribes(deposit3, depositor);
			await approveAndDepositTribes(deposit4, depositor2);

			// We should have now 4 deposits
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 4);
		});

		it('Ensure multiple users can make multiple Tribe deposits and multiple withdrawals (and that the queue is correctly updated)', async () => {
			const deposit1 = toUnit('100');
			const deposit2 = toUnit('200');
			const deposit3 = toUnit('300');
			const deposit4 = toUnit('400');

			// Send the tribes to the Token Depot.
			await approveAndDepositTribes(deposit1, depositor);
			await approveAndDepositTribes(deposit2, depositor);
			await approveAndDepositTribes(deposit3, depositor2);
			await approveAndDepositTribes(deposit4, depositor2);

			// We should have now 4 deposits
			assert.equal(await depot.depositStartIndex(), 0);
			assert.equal(await depot.depositEndIndex(), 4);

			// Depositors withdraws all his deposits
			await depot.withdrawMyDepositedTribes({ from: depositor });

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

	describe('Ensure user can exchange ETH for wHAKA', async () => {
		const purchaser = address1;

		beforeEach(async () => {
			// Send some wHAKA to the Depot contract
			await rwaone.transfer(depot.address, toUnit('1000000'), {
				from: owner,
			});
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when exchangeEtherForHAKA() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					depot.exchangeEtherForHAKA({
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
				it('when exchangeEtherForHAKA() is invoked, it works as expected', async () => {
					await depot.exchangeEtherForHAKA({
						from: purchaser,
						value: toUnit('10'),
					});
				});
			});
		});

		it('ensure user get the correct amount of wHAKA after sending ETH', async () => {
			const ethToSend = toUnit('10');

			const purchaserHAKAStartBalance = await rwaone.balanceOf(purchaser);
			// Purchaser should not have wHAKA yet
			assert.equal(purchaserHAKAStartBalance, 0);

			// Purchaser sends ETH
			await depot.exchangeEtherForHAKA({
				from: purchaser,
				value: ethToSend,
			});

			const purchaseValueInTribes = multiplyDecimal(ethToSend, ethRate);
			const purchaseValueInRwaone = divideDecimal(purchaseValueInTribes, snxRate);

			const purchaserHAKAEndBalance = await rwaone.balanceOf(purchaser);

			// Purchaser wHAKA balance should be equal to the purchase value we calculated above
			assert.bnEqual(purchaserHAKAEndBalance, purchaseValueInRwaone);
		});
	});

	describe('Ensure user can exchange Tribes for Rwaone', async () => {
		const purchaser = address1;
		const purchaserTribeAmount = toUnit('2000');
		const depotHAKAAmount = toUnit('1000000');
		const tribesToSend = toUnit('1');

		beforeEach(async () => {
			// Send the purchaser some tribes
			await tribe.transfer(purchaser, purchaserTribeAmount, {
				from: owner,
			});
			// We need to send some wHAKA to the Token Depot contract
			await rwaone.transfer(depot.address, depotHAKAAmount, {
				from: owner,
			});

			await tribe.approve(depot.address, tribesToSend, { from: purchaser });

			const depotHAKABalance = await rwaone.balanceOf(depot.address);
			const purchaserTribeBalance = await tribe.balanceOf(purchaser);
			assert.bnEqual(depotHAKABalance, depotHAKAAmount);
			assert.bnEqual(purchaserTribeBalance, purchaserTribeAmount);
		});

		describe('when the system is suspended', () => {
			beforeEach(async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
			});
			it('when exchangeTribesForHAKA() is invoked, it reverts with operation prohibited', async () => {
				await assert.revert(
					depot.exchangeTribesForHAKA(tribesToSend, {
						from: purchaser,
					}),
					'Operation prohibited'
				);
			});

			describe('when the system is resumed', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: false });
				});
				it('when exchangeTribesForHAKA() is invoked, it works as expected', async () => {
					await depot.exchangeTribesForHAKA(tribesToSend, {
						from: purchaser,
					});
				});
			});
		});

		it('ensure user gets the correct amount of wHAKA after sending 10 rUSD', async () => {
			const purchaserHAKAStartBalance = await rwaone.balanceOf(purchaser);
			// Purchaser should not have wHAKA yet
			assert.equal(purchaserHAKAStartBalance, 0);

			// Purchaser sends rUSD
			const txn = await depot.exchangeTribesForHAKA(tribesToSend, {
				from: purchaser,
			});

			const purchaseValueInRwaone = divideDecimal(tribesToSend, snxRate);

			const purchaserHAKAEndBalance = await rwaone.balanceOf(purchaser);

			// Purchaser wHAKA balance should be equal to the purchase value we calculated above
			assert.bnEqual(purchaserHAKAEndBalance, purchaseValueInRwaone);

			// assert the exchange event
			const exchangeEvent = txn.logs.find(log => log.event === 'Exchange');

			assert.eventEqual(exchangeEvent, 'Exchange', {
				fromCurrency: 'rUSD',
				fromAmount: tribesToSend,
				toCurrency: 'wHAKA',
				toAmount: purchaseValueInRwaone,
			});
		});
	});

	describe('withdrawRwaone', () => {
		const snxAmount = toUnit('1000000');

		beforeEach(async () => {
			// Send some wHAKA to the Depot contract
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
			const depotHAKABalanceBefore = await rwaone.balanceOf(depot.address);

			assert.bnEqual(depotHAKABalanceBefore, snxAmount);

			await depot.withdrawRwaone(snxAmount, { from: owner });

			const depotHAKABalanceAfter = await rwaone.balanceOf(depot.address);
			assert.bnEqual(depotHAKABalanceAfter, toUnit('0'));
		});
	});
});
