'use strict';

const { artifacts, contract } = require('hardhat');
const { assert } = require('./common');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');
const { onlyGivenAddressCanInvoke } = require('./helpers');
const { mockGenericContractFnc, setupAllContracts } = require('./setup');

const AddressResolver = artifacts.require('AddressResolver');

contract('AddressResolver', accounts => {
	const [deployerAccount, owner, account1, account2, account3, account4] = accounts;

	let resolver;
	beforeEach(async () => {
		// the owner is the associated contract, so we can simulate
		resolver = await AddressResolver.new(owner, {
			from: deployerAccount,
		});
	});

	describe('importAddresses()', () => {
		it('can only be invoked by the owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: resolver.importAddresses,
				args: [[toBytes32('something')], [account1]],
				address: owner,
				accounts,
			});
		});
		describe('when a different number of names are given to addresses', () => {
			it('then it reverts', async () => {
				await assert.revert(
					resolver.importAddresses([], [account1], { from: owner }),
					'Input lengths must match'
				);
				await assert.revert(
					resolver.importAddresses([toBytes32('test')], [account1, account2], { from: owner }),
					'Input lengths must match'
				);
				await assert.revert(
					resolver.importAddresses([toBytes32('test')], [], { from: owner }),
					'Input lengths must match'
				);
			});
		});
		describe('when three separate addresses are given', () => {
			beforeEach(async () => {
				await resolver.importAddresses(
					['first', 'second', 'third'].map(toBytes32),
					[account1, account2, account3],
					{ from: owner }
				);
			});
			it('then it can verify the imported set of addresses', async () => {
				assert.equal(
					await resolver.areAddressesImported(['first', 'second', 'third'].map(toBytes32), [
						account1,
						account2,
						account3,
					]),
					true
				);
				assert.equal(
					await resolver.areAddressesImported(
						['first', 'second', 'third'].map(toBytes32),
						[account1, account3, account2] // Reversed
					),
					false
				);
			});
			it('then each can be looked up in turn', async () => {
				assert.equal(await resolver.getAddress(toBytes32('first')), account1);
				assert.equal(await resolver.getAddress(toBytes32('second')), account2);
				assert.equal(await resolver.getAddress(toBytes32('third')), account3);
			});
			describe('when two are overridden', () => {
				beforeEach(async () => {
					await resolver.importAddresses(['second', 'third'].map(toBytes32), [account3, account4], {
						from: owner,
					});
				});
				it('then the first remains the same while the other two are updated', async () => {
					assert.equal(await resolver.getAddress(toBytes32('first')), account1);
					assert.equal(await resolver.getAddress(toBytes32('second')), account3);
					assert.equal(await resolver.getAddress(toBytes32('third')), account4);
				});
			});
		});
	});

	describe('getAddress()', () => {
		it('when invoked with no entries, returns 0 address', async () => {
			assert.equal(await resolver.getAddress(toBytes32('first')), ZERO_ADDRESS);
		});
		describe('when three separate addresses are given', () => {
			beforeEach(async () => {
				await resolver.importAddresses(
					['first', 'second', 'third'].map(toBytes32),
					[account1, account2, account3],
					{ from: owner }
				);
			});
			it('then getAddress returns the same as the public mapping', async () => {
				assert.equal(await resolver.getAddress(toBytes32('third')), account3);
				assert.equal(await resolver.repository(toBytes32('second')), account2);
			});
		});
	});

	describe('requireAndGetAddress()', () => {
		it('when invoked with no entries, reverts', async () => {
			await assert.revert(
				resolver.requireAndGetAddress(toBytes32('first'), 'Some error'),
				'Some error'
			);
		});
		describe('when three separate addresses are given', () => {
			beforeEach(async () => {
				await resolver.importAddresses(
					['first', 'second', 'third'].map(toBytes32),
					[account1, account2, account3],
					{ from: owner }
				);
			});
			it('then requireAndGetAddress() returns the same as the public mapping', async () => {
				assert.equal(await resolver.requireAndGetAddress(toBytes32('third'), 'Error'), account3);
				assert.equal(await resolver.requireAndGetAddress(toBytes32('second'), 'Error'), account2);
			});
			it('when invoked with an unknown entry, reverts', async () => {
				await assert.revert(
					resolver.requireAndGetAddress(toBytes32('other'), 'Some error again'),
					'Some error again'
				);
			});
		});
	});

	describe('getTribe()', () => {
		describe('when a mock for Issuer is added', () => {
			let mock;
			beforeEach(async () => {
				// mock a Rwaone
				mock = await artifacts.require('GenericMock').new();

				// add it to the resolver
				await resolver.importAddresses([toBytes32('Issuer')], [mock.address], { from: owner });

				// now instruct the mock Issuer that tribes(any) must return "account4"
				await mockGenericContractFnc({
					instance: mock,
					mock: 'Issuer',
					fncName: 'tribes',
					returns: [account4],
				});
			});

			it('when getTribe() is invoked', async () => {
				const tribe = await resolver.getTribe(toBytes32('hUSD'));
				assert.equal(tribe, account4);
			});
		});
		describe('when a Rwaone is created with a few added tribes', () => {
			let hETHContract;
			let hUSDContract;
			beforeEach(async () => {
				({ TribehETH: hETHContract, TribehUSD: hUSDContract } = await setupAllContracts({
					accounts,
					existing: {
						AddressResolver: resolver,
					},
					tribes: ['hUSD', 'hETH', 'sEUR', 'sAUD'],
					contracts: ['Rwaone'],
				}));
			});
			it('when getTribe() is invoked with these tribe keys, they are returned correctly', async () => {
				assert.equal(await resolver.getTribe(toBytes32('hUSD')), hUSDContract.address);
				assert.equal(await resolver.getTribe(toBytes32('hETH')), hETHContract.address);
			});
		});
	});
});
