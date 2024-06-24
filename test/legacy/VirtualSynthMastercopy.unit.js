'use strict';

const { artifacts, contract } = require('hardhat');

const { assert } = require('../contracts/common');

const {
	ensureOnlyExpectedMutativeFunctions,
	trimUtf8EscapeChars,
} = require('../contracts/helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS, ZERO_BYTES32 },
} = require('../..');

const VirtualTribe = artifacts.require('VirtualTribe');
const VirtualTribeMastercopy = artifacts.require('VirtualTribeMastercopy');

contract('VirtualTribeMastercopy (unit tests)', async accounts => {
	const [, owner, mockResolver, mockTribe] = accounts;

	it('ensure same functions as VirtualTribe are mutative', () => {
		for (const abi of [VirtualTribe.abi, VirtualTribeMastercopy.abi]) {
			ensureOnlyExpectedMutativeFunctions({
				abi,
				ignoreParents: ['ERC20'],
				expected: ['initialize', 'settle'],
			});
		}
	});

	describe('with instance', () => {
		let instance;

		before(async () => { });

		beforeEach(async () => {
			instance = await VirtualTribeMastercopy.new();
		});

		it('is initialized', async () => {
			assert.isTrue(await instance.initialized());
		});

		it('and the instance cannot be initialized again', async () => {
			await assert.revert(
				instance.initialize(mockTribe, mockResolver, owner, '10', toBytes32('rUSD')),
				'vTribe already initialized'
			);
		});

		it('and the state is empty', async () => {
			assert.equal(await instance.tribe(), ZERO_ADDRESS);
			assert.equal(await instance.resolver(), ZERO_ADDRESS);
			assert.equal(await instance.totalSupply(), '0');
			assert.equal(await instance.balanceOf(owner), '0');
			assert.equal(await instance.balanceOfUnderlying(owner), '0');
			assert.equal(await instance.currencyKey(), ZERO_BYTES32);
			assert.equal(trimUtf8EscapeChars(await instance.name()), 'Virtual Tribe ');
			assert.equal(trimUtf8EscapeChars(await instance.symbol()), 'v');
		});

		it('and state-dependent functions fail', async () => {
			await assert.revert(instance.secsLeftInWaitingPeriod());
			await assert.revert(instance.readyToSettle());
		});
	});
});
