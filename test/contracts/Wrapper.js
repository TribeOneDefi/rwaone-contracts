'use strict';

const { contract, artifacts, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	getDecodedLogs,
	decodedEventEqual,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

const { toBytes32 } = require('../..');
const { toBN } = require('web3-utils');

contract('Wrapper', async accounts => {
	const rwas = ['rUSD', 'rETH', 'ETH', 'wRWAX'];
	const [rETH, rUSD, ETH] = ['rETH', 'rUSD', 'ETH'].map(toBytes32);

	const ONE = toBN('1');

	const [, owner, , , account1] = accounts;

	let systemSettings,
		feePool,
		exchangeRates,
		addressResolver,
		depot,
		issuer,
		rUSDRwa,
		rETHRwa,
		wrapperFactory,
		etherWrapper,
		weth;

	const calculateETHToUSD = async feesInETH => {
		// Ask the Depot how many rUSD I will get for this ETH
		const expectedFeerUSD = await depot.rwasReceivedForEther(feesInETH);
		return expectedFeerUSD;
	};

	const calculateMintFees = async amount => {
		const mintFee = (await etherWrapper.calculateMintFee(amount))[0];
		const expectedFeerUSD = await calculateETHToUSD(mintFee);
		return { mintFee, expectedFeerUSD };
	};

	const calculateBurnFees = async amount => {
		const burnFee = (await etherWrapper.calculateBurnFee(amount))[0];
		const expectedFeerUSD = await calculateETHToUSD(burnFee);
		return { burnFee, expectedFeerUSD };
	};

	before(async () => {
		({
			SystemSettings: systemSettings,
			AddressResolver: addressResolver,
			Issuer: issuer,
			FeePool: feePool,
			Depot: depot,
			ExchangeRates: exchangeRates,
			WrapperFactory: wrapperFactory,
			RwarUSD: rUSDRwa,
			RwarETH: rETHRwa,
			WETH: weth,
		} = await setupAllContracts({
			accounts,
			rwas,
			contracts: [
				'Rwaone',
				'AddressResolver',
				'SystemStatus',
				'Issuer',
				'Depot',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'DebtCache',
				'Exchanger',
				'WrapperFactory',
				'WETH',
				'CollateralManager',
			],
		}));

		// deploy an eth wrapper
		const etherWrapperCreateTx = await wrapperFactory.createWrapper(
			weth.address,
			rETH,
			toBytes32('RwarETH'),
			{ from: owner }
		);

		// extract address from events
		const etherWrapperAddress = etherWrapperCreateTx.logs.find(l => l.event === 'WrapperCreated')
			.args.wrapperAddress;
		etherWrapper = await artifacts.require('Wrapper').at(etherWrapperAddress);

		// set defaults for test - 50bps mint and burn fees
		await systemSettings.setWrapperMaxTokenAmount(etherWrapperAddress, toUnit('5000'), {
			from: owner,
		});
		await systemSettings.setWrapperMintFeeRate(etherWrapperAddress, toUnit('0.005'), {
			from: owner,
		});
		await systemSettings.setWrapperBurnFeeRate(etherWrapperAddress, toUnit('0.005'), {
			from: owner,
		});

		await setupPriceAggregators(exchangeRates, owner, [rETH, ETH]);
		await updateAggregatorRates(exchangeRates, null, [rETH, ETH], ['1500', '1500'].map(toUnit));
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: etherWrapper.abi,
			hasFallback: true,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'MixinSystemSettings'],
			expected: ['mint', 'burn'],
		});
	});

	describe('On deployment of Contract', async () => {
		let instance;
		beforeEach(async () => {
			instance = etherWrapper;
		});

		it('should set constructor params on deployment', async () => {
			assert.equal(await instance.resolver(), addressResolver.address);
		});

		it('should set the wrapper token approval', async () => {
			const allowance = await weth.allowance(instance.address, instance.address);
			assert.bnEqual(
				allowance,
				web3.utils.toBN(
					'115792089237316195423570985008687907853269984665640564039457584007913129639935'
				) // uint256(-1)
			);
		});

		it('should access its dependencies via the address resolver', async () => {
			assert.equal(await addressResolver.getAddress(toBytes32('RwarETH')), rETHRwa.address);
			assert.equal(await addressResolver.getAddress(toBytes32('RwarUSD')), rUSDRwa.address);
			assert.equal(
				await addressResolver.getAddress(toBytes32('ExchangeRates')),
				exchangeRates.address
			);
			assert.equal(await addressResolver.getAddress(toBytes32('Issuer')), issuer.address);
			assert.equal(await addressResolver.getAddress(toBytes32('FeePool')), feePool.address);
			assert.equal(
				await addressResolver.getAddress(toBytes32('WrapperFactory')),
				wrapperFactory.address
			);
		});

		it('should not be payable', async () => {
			await assert.revert(
				web3.eth.sendTransaction({
					value: toUnit('1'),
					from: owner,
					to: instance.address,
				}),
				'Fallback disabled, use mint()'
			);
		});

		describe('should have a default', async () => {
			const MAX_ETH = toUnit('5000');
			const FIFTY_BIPS = toUnit('0.005');

			it('maxTokenAmount of 5,000 ETH', async () => {
				assert.bnEqual(await etherWrapper.maxTokenAmount(), MAX_ETH);
			});
			it('capacity of 5,000 ETH', async () => {
				assert.bnEqual(await etherWrapper.capacity(), MAX_ETH);
			});
			it('mintFeeRate of 50 bps', async () => {
				assert.bnEqual(await etherWrapper.mintFeeRate(), FIFTY_BIPS);
			});
			it('burnFeeRate of 50 bps', async () => {
				assert.bnEqual(await etherWrapper.burnFeeRate(), FIFTY_BIPS);
			});
			describe('totalIssuedRwas', async () => {
				it('rwa = 0', async () => {
					assert.bnEqual(await etherWrapper.targetRwaIssued(), toBN('0'));
				});
			});
		});
	});

	describe('totalIssuedRwas', async () => {
		const mintAmount = toUnit('1.0');
		let feeAmount;

		before(async () => {
			feeAmount = await exchangeRates.effectiveValue(rETH, toUnit('0.005'), rUSD);
		});

		describe('when mint(1 rETH) is called', async () => {
			beforeEach(async () => {
				await weth.deposit({ from: account1, value: mintAmount });
				await weth.approve(etherWrapper.address, mintAmount, { from: account1 });
				await etherWrapper.mint(mintAmount, { from: account1 });
			});

			it('total issued rETH = 1.0', async () => {
				assert.bnEqual(await etherWrapper.targetRwaIssued(), toUnit('1.0'));
			});
			it('fees escrowed = 0.005', async () => {
				assert.bnEqual(await wrapperFactory.feesEscrowed(), feeAmount);
			});

			describe('then burn(`reserves + fees` WETH) is called', async () => {
				const burnAmount = toUnit('1.0');

				beforeEach(async () => {
					const { burnFee } = await calculateBurnFees(burnAmount);
					const amountIn = burnAmount.add(burnFee);
					await rETHRwa.issue(account1, amountIn);
					await rETHRwa.approve(etherWrapper.address, amountIn, { from: account1 });
					await etherWrapper.burn(amountIn, { from: account1 });
				});

				it('total issued rETH = 0.0', async () => {
					assert.bnEqual(await etherWrapper.targetRwaIssued(), toUnit('0.0'));
				});
				it('fees escrowed = 0.01', async () => {
					assert.bnEqual(await wrapperFactory.feesEscrowed(), feeAmount.mul(toBN(2)));
				});

				describe('then distributeFees is called', async () => {
					beforeEach(async () => {
						// await feePool.closeCurrentFeePeriod({ from: account1 });
						await wrapperFactory.distributeFees();
					});

					it('fees escrowed = 0.0', async () => {
						assert.bnEqual(await wrapperFactory.feesEscrowed(), toUnit('0.0'));
					});
				});
			});
		});
	});

	describe('mint', async () => {
		describe('when amount is less than than capacity', () => {
			let amount;
			let initialCapacity;
			let mintFee;
			let expectedFeerUSD;
			let mintTx;
			let feesEscrowed;

			describe('fee is positive', () => {
				beforeEach(async () => {
					initialCapacity = await etherWrapper.capacity();
					amount = initialCapacity.sub(toUnit('1.0'));

					({ mintFee, expectedFeerUSD } = await calculateMintFees(amount));

					feesEscrowed = await wrapperFactory.feesEscrowed();

					await weth.deposit({ from: account1, value: amount });
					await weth.approve(etherWrapper.address, amount, { from: account1 });
					mintTx = await etherWrapper.mint(amount, { from: account1 });
				});

				it('locks `amount` WETH in the contract', async () => {
					const logs = await getDecodedLogs({
						hash: mintTx.tx,
						contracts: [weth],
					});

					decodedEventEqual({
						event: 'Transfer',
						emittedFrom: weth.address,
						args: [account1, etherWrapper.address, amount],
						log: logs[0],
					});
				});
				it('mints amount(1-mintFeeRate) rETH into the user’s wallet', async () => {
					assert.bnEqual(await rETHRwa.balanceOf(account1), amount.sub(mintFee));
				});
				it('escrows `amount * mintFeeRate` worth of rUSD as fees', async () => {
					assert.bnEqual(await wrapperFactory.feesEscrowed(), feesEscrowed.add(expectedFeerUSD));
				});
				it('has a capacity of (capacity - amount) after', async () => {
					assert.bnEqual(await etherWrapper.capacity(), initialCapacity.sub(amount));
				});
				it('targetRwaIssued = rETH balance', async () => {
					assert.bnEqual(
						await etherWrapper.targetRwaIssued(),
						await weth.balanceOf(etherWrapper.address)
					);
				});
				it('emits Minted event', async () => {
					const logs = await getDecodedLogs({
						hash: mintTx.tx,
						contracts: [etherWrapper],
					});

					decodedEventEqual({
						event: 'Minted',
						emittedFrom: etherWrapper.address,
						args: [account1, amount.sub(mintFee), mintFee],
						log: logs.filter(l => !!l).find(({ name }) => name === 'Minted'),
					});
				});
			});

			describe('fee is negative', () => {
				beforeEach(async () => {
					await systemSettings.setWrapperMintFeeRate(etherWrapper.address, toUnit('-0.005'), {
						from: owner,
					});

					initialCapacity = await etherWrapper.capacity();
					amount = initialCapacity.sub(toUnit('1.0'));

					({ mintFee, expectedFeerUSD } = await calculateMintFees(amount));

					feesEscrowed = await wrapperFactory.feesEscrowed();

					await weth.deposit({ from: account1, value: amount });
					await weth.approve(etherWrapper.address, amount, { from: account1 });
					mintTx = await etherWrapper.mint(amount, { from: account1 });
				});

				it('locks `amount` WETH in the contract', async () => {
					const logs = await getDecodedLogs({
						hash: mintTx.tx,
						contracts: [weth],
					});

					decodedEventEqual({
						event: 'Transfer',
						emittedFrom: weth.address,
						args: [account1, etherWrapper.address, amount],
						log: logs[0],
					});
				});
				it('mints amount(1+mintFeeRate) rETH into the user’s wallet', async () => {
					assert.bnEqual(await rETHRwa.balanceOf(account1), amount.add(mintFee));
				});
			});
		});

		describe('amount is larger than or equal to capacity', () => {
			let amount;
			let initialCapacity;
			let mintFee;
			let expectedFeerUSD;
			let mintTx;
			let feesEscrowed;

			describe('fee is positive', () => {
				beforeEach(async () => {
					initialCapacity = await etherWrapper.capacity();
					amount = initialCapacity.add(ONE);

					// Calculate the mint fees on the capacity amount,
					// as this will be the ETH accepted by the contract.
					({ mintFee, expectedFeerUSD } = await calculateMintFees(initialCapacity));

					feesEscrowed = await wrapperFactory.feesEscrowed();

					await weth.deposit({ from: account1, value: amount });
					await weth.approve(etherWrapper.address, amount, { from: account1 });
					mintTx = await etherWrapper.mint(amount, { from: account1 });
				});

				it('locks `capacity` ETH in the contract', async () => {
					const logs = await getDecodedLogs({
						hash: mintTx.tx,
						contracts: [weth],
					});

					decodedEventEqual({
						event: 'Transfer',
						emittedFrom: weth.address,
						args: [account1, etherWrapper.address, initialCapacity],
						log: logs[0],
					});
				});
				it('mints capacity(1-mintFeeRate) rETH into the user’s wallet', async () => {
					assert.bnEqual(await rETHRwa.balanceOf(account1), initialCapacity.sub(mintFee));
				});
				it('escrows `capacity * mintFeeRate` worth of rUSD as fees', async () => {
					assert.bnEqual(await wrapperFactory.feesEscrowed(), feesEscrowed.add(expectedFeerUSD));
				});
				it('has a capacity of 0 after', async () => {
					assert.bnEqual(await etherWrapper.capacity(), toBN('0'));
				});
				it('targetRwaIssued = rETH balance', async () => {
					assert.bnEqual(
						await etherWrapper.targetRwaIssued(),
						await weth.balanceOf(etherWrapper.address)
					);
				});
			});

			describe('fee is negative', () => {
				beforeEach(async () => {
					await systemSettings.setWrapperMintFeeRate(etherWrapper.address, toUnit('-0.005'), {
						from: owner,
					});

					initialCapacity = await etherWrapper.capacity();
					amount = initialCapacity.add(ONE);

					// Calculate the mint fees on the capacity amount,
					// as this will be the ETH accepted by the contract.
					({ mintFee, expectedFeerUSD } = await calculateMintFees(initialCapacity));

					feesEscrowed = await wrapperFactory.feesEscrowed();

					await weth.deposit({ from: account1, value: amount });
					await weth.approve(etherWrapper.address, amount, { from: account1 });
					mintTx = await etherWrapper.mint(amount, { from: account1 });
				});

				it('locks `capacity` WETH in the contract', async () => {
					const logs = await getDecodedLogs({
						hash: mintTx.tx,
						contracts: [weth],
					});

					decodedEventEqual({
						event: 'Transfer',
						emittedFrom: weth.address,
						args: [account1, etherWrapper.address, amount],
						log: logs[0],
					});
				});
				it('mints capacity(1+mintFeeRate) rETH into the user’s wallet', async () => {
					assert.bnEqual(await rETHRwa.balanceOf(account1), initialCapacity.add(mintFee));
				});
			});
		});

		describe('when capacity = 0', () => {
			beforeEach(async () => {
				await systemSettings.setWrapperMaxTokenAmount(etherWrapper.address, '0', { from: owner });
			});

			it('reverts', async () => {
				const amount = '1';
				await weth.deposit({ from: account1, value: amount });
				await weth.approve(etherWrapper.address, amount, { from: account1 });

				await assert.revert(
					etherWrapper.mint(amount, { from: account1 }),
					'Contract has no spare capacity to mint'
				);
			});
		});
	});

	describe('burn', async () => {
		describe('when the contract has 0 WETH', async () => {
			it('reverts', async () => {
				await assert.revert(etherWrapper.burn('1', { from: account1 }), 'Balance is too low');
			});
		});

		describe('when the contract has WETH reserves', async () => {
			let burnTx;

			beforeEach(async () => {
				const amount = toUnit('2');
				await weth.deposit({ from: account1, value: amount });
				await weth.approve(etherWrapper.address, amount, { from: account1 });
				await etherWrapper.mint(amount, { from: account1 });
			});

			describe('when amount is strictly lower than reserves(1+burnFeeRate)', async () => {
				const principal = toUnit('1.0');
				let amount;
				let burnFee;
				let expectedFeerUSD;
				let initialCapacity;
				let feesEscrowed;

				describe('fee is positive', () => {
					beforeEach(async () => {
						initialCapacity = await etherWrapper.capacity();
						feesEscrowed = await wrapperFactory.feesEscrowed();

						({ burnFee, expectedFeerUSD } = await calculateBurnFees(principal));
						amount = principal.add(burnFee);
						await rETHRwa.issue(account1, amount);
						await rETHRwa.approve(etherWrapper.address, amount, { from: account1 });

						burnTx = await etherWrapper.burn(amount, { from: account1 });
					});

					it('burns `amount` of rETH from user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [rETHRwa],
						});

						decodedEventEqual({
							event: 'Burned',
							emittedFrom: rETHRwa.address,
							args: [account1, amount],
							log: logs.filter(l => !!l).find(({ name }) => name === 'Burned'),
						});
					});
					it('sends amount(1-burnFeeRate) WETH to user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [weth],
						});

						decodedEventEqual({
							event: 'Transfer',
							emittedFrom: weth.address,
							args: [etherWrapper.address, account1, amount.sub(burnFee)],
							log: logs
								.reverse()
								.filter(l => !!l)
								.find(({ name }) => name === 'Transfer'),
						});
					});
					it('escrows `amount * burnFeeRate` worth of rETH as fees', async () => {
						assert.bnEqual(await wrapperFactory.feesEscrowed(), feesEscrowed.add(expectedFeerUSD));
					});
					it('increases capacity by `amount - fees` WETH', async () => {
						assert.bnEqual(await etherWrapper.capacity(), initialCapacity.add(amount.sub(burnFee)));
					});
					it('targetRwaIssued = rETH balance', async () => {
						assert.bnEqual(
							await etherWrapper.targetRwaIssued(),
							await weth.balanceOf(etherWrapper.address)
						);
					});
					it('emits Burned event', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [etherWrapper],
						});

						decodedEventEqual({
							event: 'Burned',
							emittedFrom: etherWrapper.address,
							args: [account1, amount.sub(burnFee), burnFee],
							log: logs
								.reverse()
								.filter(l => !!l)
								.find(({ name }) => name === 'Burned'),
						});
					});
				});

				describe('fee is negative', () => {
					beforeEach(async () => {
						await systemSettings.setWrapperBurnFeeRate(etherWrapper.address, toUnit('-0.005'), {
							from: owner,
						});

						initialCapacity = await etherWrapper.capacity();
						feesEscrowed = await wrapperFactory.feesEscrowed();

						({ burnFee, expectedFeerUSD } = await calculateBurnFees(principal));
						amount = principal;
						await rETHRwa.issue(account1, amount);
						await rETHRwa.approve(etherWrapper.address, amount, { from: account1 });

						burnTx = await etherWrapper.burn(amount, { from: account1 });
					});

					it('burns `amount` of rETH from user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [rETHRwa],
						});

						decodedEventEqual({
							event: 'Burned',
							emittedFrom: rETHRwa.address,
							args: [account1, amount],
							log: logs.filter(l => !!l).find(({ name }) => name === 'Burned'),
						});
					});
					it('sends amount(1+burnFeeRate) WETH to user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [weth],
						});

						decodedEventEqual({
							event: 'Transfer',
							emittedFrom: weth.address,
							args: [etherWrapper.address, account1, amount.add(burnFee)],
							log: logs
								.reverse()
								.filter(l => !!l)
								.find(({ name }) => name === 'Transfer'),
						});
					});
				});
			});

			describe('when amount is larger than or equal to reserves(1+burnFeeRate)', async () => {
				let reserves;
				let amount;
				let burnFee;
				let expectedFeerUSD;
				let feesEscrowed;

				describe('fee is positive', () => {
					beforeEach(async () => {
						reserves = await etherWrapper.targetRwaIssued();
						({ burnFee, expectedFeerUSD } = await calculateBurnFees(reserves));

						amount = reserves.add(burnFee).add(toBN('100000000'));
						feesEscrowed = await wrapperFactory.feesEscrowed();

						await rETHRwa.issue(account1, amount);
						await rETHRwa.approve(etherWrapper.address, amount, { from: account1 });

						burnTx = await etherWrapper.burn(amount, { from: account1 });
					});

					it('burns `reserves(1+burnFeeRate)` amount of rETH from user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [rETHRwa],
						});

						decodedEventEqual({
							event: 'Burned',
							emittedFrom: rETHRwa.address,
							args: [account1, reserves.add(burnFee)],
							log: logs.filter(l => !!l).find(({ name }) => name === 'Burned'),
						});
					});
					it('sends `reserves` WETH to user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [weth],
						});

						decodedEventEqual({
							event: 'Transfer',
							emittedFrom: weth.address,
							args: [etherWrapper.address, account1, reserves],
							log: logs
								.reverse()
								.filter(l => !!l)
								.find(({ name }) => name === 'Transfer'),
						});
					});
					it('escrows `amount * burnFeeRate` worth of rUSD as fees', async () => {
						assert.bnEqual(await wrapperFactory.feesEscrowed(), feesEscrowed.add(expectedFeerUSD));
					});
					it('has a max capacity after', async () => {
						assert.bnEqual(await etherWrapper.capacity(), await etherWrapper.maxTokenAmount());
					});
					it('is left with 0 rwa issued remaining', async () => {
						assert.equal(await etherWrapper.targetRwaIssued(), '0');
					});
				});

				describe('fee is negative', () => {
					beforeEach(async () => {
						await systemSettings.setWrapperBurnFeeRate(etherWrapper.address, toUnit('-0.005'), {
							from: owner,
						});

						reserves = await etherWrapper.targetRwaIssued();
						({ burnFee, expectedFeerUSD } = await calculateBurnFees(reserves));

						amount = reserves.add(burnFee).add(toBN('100000000'));
						feesEscrowed = await wrapperFactory.feesEscrowed();

						await rETHRwa.issue(account1, amount);
						await rETHRwa.approve(etherWrapper.address, amount, { from: account1 });

						burnTx = await etherWrapper.burn(amount, { from: account1 });
					});

					it('burns `reserves(1-burnFeeRate)` amount of rETH from user', async () => {
						const logs = await getDecodedLogs({
							hash: burnTx.tx,
							contracts: [rETHRwa],
						});

						decodedEventEqual({
							event: 'Burned',
							emittedFrom: rETHRwa.address,
							args: [account1, reserves.sub(burnFee)],
							log: logs.filter(l => !!l).find(({ name }) => name === 'Burned'),
						});
					});
				});
			});

			describe('precision and rounding', async () => {
				let burnAmount;
				let burnTx;

				before(async () => {
					const amount = toUnit('1.2');
					await weth.deposit({ from: account1, value: amount });
					await weth.approve(etherWrapper.address, amount, { from: account1 });
					await etherWrapper.mint(amount, { from: account1 });

					burnAmount = toUnit('0.9');
					await rETHRwa.issue(account1, burnAmount);
					await rETHRwa.approve(etherWrapper.address, burnAmount, { from: account1 });
					burnTx = await etherWrapper.burn(burnAmount, { from: account1 });
				});
				it('emits a Burn event which burns 0.9 rETH', async () => {
					const logs = await getDecodedLogs({
						hash: burnTx.tx,
						contracts: [rETHRwa],
					});

					decodedEventEqual({
						event: 'Burned',
						emittedFrom: rETHRwa.address,
						args: [account1, burnAmount],
						log: logs.filter(l => !!l).find(({ name }) => name === 'Burned'),
						bnCloseVariance: 0,
					});
				});
			});
		});
	});

	describe('transfer without mint', () => {
		let preTargetIssuedRwas;

		const extraTransferred = toUnit('2');

		before(async () => {
			const amount = toUnit('1');
			await weth.deposit({ from: account1, value: amount.add(extraTransferred) });
			await weth.approve(etherWrapper.address, amount, { from: account1 });
			await etherWrapper.mint(amount, { from: account1 });

			// wipe fees
			await wrapperFactory.distributeFees();

			preTargetIssuedRwas = await etherWrapper.targetRwaIssued();

			await weth.transfer(etherWrapper.address, extraTransferred, { from: account1 });
		});

		addSnapshotBeforeRestoreAfterEach();

		describe('before mint or burn', () => {
			it('totalIssuedRwas is unaffected', async () => {
				assert.bnEqual(await etherWrapper.targetRwaIssued(), preTargetIssuedRwas);
			});

			it('does not escrow extra', async () => {
				assert.bnEqual(await wrapperFactory.feesEscrowed(), toUnit(0));
			});
		});

		describe('mint after transfer without mint', () => {
			before(async () => {
				const amount = toUnit('1');
				await weth.deposit({ from: account1, value: amount });
				await weth.approve(etherWrapper.address, amount, { from: account1 });
				await etherWrapper.mint(amount, { from: account1 });
			});

			it('issues excess for fee pool', async () => {
				assert.bnGt(await wrapperFactory.feesEscrowed(), extraTransferred);
			});
			it('targetRwaIssued = rETH balance', async () => {
				assert.bnEqual(
					await etherWrapper.targetRwaIssued(),
					await weth.balanceOf(etherWrapper.address)
				);
			});
		});

		describe('burn after transfer without mint', () => {
			before(async () => {
				const amount = toUnit('1');
				await weth.deposit({ from: account1, value: amount });
				await weth.approve(etherWrapper.address, amount, { from: account1 });
				await etherWrapper.mint(amount, { from: account1 });
			});

			it('issues excess for fee pool', async () => {
				assert.bnGt(await wrapperFactory.feesEscrowed(), extraTransferred);
			});
			it('targetRwaIssued = rETH balance', async () => {
				assert.bnEqual(
					await etherWrapper.targetRwaIssued(),
					await weth.balanceOf(etherWrapper.address)
				);
			});
		});
	});
});
