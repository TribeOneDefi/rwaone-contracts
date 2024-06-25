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

const VirtualRwa = artifacts.require('VirtualRwa');
const VirtualRwaMastercopy = artifacts.require('VirtualRwaMastercopy');

contract('VirtualRwaMastercopy (unit tests)', async accounts => {
	const [, owner, mockResolver, mockRwa] = accounts;

	it('ensure same functions as VirtualRwa are mutative', () => {
		for (const abi of [VirtualRwa.abi, VirtualRwaMastercopy.abi]) {
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
			instance = await VirtualRwaMastercopy.new();
		});

		it('is initialized', async () => {
			assert.isTrue(await instance.initialized());
		});

		it('and the instance cannot be initialized again', async () => {
			await assert.revert(
				instance.initialize(mockRwa, mockResolver, owner, '10', toBytes32('rUSD')),
				'vRwa already initialized'
			);
		});

		it('and the state is empty', async () => {
			assert.equal(await instance.rwa(), ZERO_ADDRESS);
			assert.equal(await instance.resolver(), ZERO_ADDRESS);
			assert.equal(await instance.totalSupply(), '0');
			assert.equal(await instance.balanceOf(owner), '0');
			assert.equal(await instance.balanceOfUnderlying(owner), '0');
			assert.equal(await instance.currencyKey(), ZERO_BYTES32);
			assert.equal(trimUtf8EscapeChars(await instance.name()), 'Virtual Rwa ');
			assert.equal(trimUtf8EscapeChars(await instance.symbol()), 'v');
		});

		it('and state-dependent functions fail', async () => {
			await assert.revert(instance.secsLeftInWaitingPeriod());
			await assert.revert(instance.readyToSettle());
		});
	});
});
