'use strict';

const { contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupContract } = require('./setup');

const { toUnit, toPreciseUnit } = require('../utils')();

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const { smock } = require('@defi-wonderland/smock');

const { toBytes32 } = require('../..');

const ethers = require('ethers');

contract('OneNetAggregators', async accounts => {
	const [owner] = accounts;

	let addressResolver, aggregatorDebtRatio, aggregatorIssuedRwas;

	let mockRwaoneDebtShare, mockIssuer;

	before(async () => {
		addressResolver = await setupContract({
			accounts,
			args: [owner],
			contract: 'AddressResolver',
		});

		aggregatorDebtRatio = await setupContract({
			accounts,
			args: [addressResolver.address],
			contract: 'OneNetAggregatorDebtRatio',
		});

		aggregatorIssuedRwas = await setupContract({
			accounts,
			args: [addressResolver.address],
			contract: 'OneNetAggregatorIssuedRwas',
		});

		mockIssuer = await smock.fake('Issuer');
		mockRwaoneDebtShare = await smock.fake('RwaoneDebtShare');

		mockIssuer.totalIssuedRwas.returns(ethers.utils.parseEther('500'));
		mockRwaoneDebtShare.totalSupply.returns(ethers.utils.parseEther('1000'));

		await addressResolver.importAddresses(
			[toBytes32('Issuer'), toBytes32('RwaoneDebtShare')],
			[mockIssuer.address, mockRwaoneDebtShare.address]
		);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: aggregatorDebtRatio.abi,
			ignoreParents: ['Owned'],
			expected: ['setOverrideTimestamp'],
		});
	});
	it('should set constructor params on deployment', async () => {
		const instance = await setupContract({
			accounts,
			contract: 'RwaoneDebtShare',
			args: [owner, addressResolver.address],
		});

		assert.equal(await instance.owner(), owner);
		assert.equal(await instance.resolver(), addressResolver.address);
	});

	describe('setOverrideTimestamp()', () => {
		it('only callable by owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: aggregatorDebtRatio.setOverrideTimestamp,
				args: [123456789],
				accounts,
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await aggregatorDebtRatio.setOverrideTimestamp(1000);
			});

			it('changes timestmap returned by the oracle', async () => {
				assert.bnEqual((await aggregatorDebtRatio.getRoundData(1234))[2], 1000);
			});
		});
	});

	describe('decimals()', async () => {
		it('returns 0', async () => {
			assert.bnEqual(await aggregatorDebtRatio.decimals(), 0);
		});
	});

	describe('latestRound()', () => {
		it('returns 1', async () => {
			assert.bnEqual(await aggregatorDebtRatio.latestRound(), 1);
		});
	});

	describe('getTimestamp()', async () => {
		it('returns same value as getRoundData', async () => {
			assert.bnEqual(
				await aggregatorDebtRatio.getTimestamp(1),
				(await aggregatorDebtRatio.getRoundData(1))[2]
			);
		});
	});

	describe('latestRound()', async () => {
		it('returns 1', async () => {
			assert.bnEqual(await aggregatorDebtRatio.latestRound(), 1);
		});
	});

	describe('OneNetAggregatorIssuedRwas', () => {
		describe('getRoundData(uint80)', () => {
			it('gets current issued rwas', async () => {
				assert.bnEqual((await aggregatorIssuedRwas.getRoundData(0))[1], toUnit(500));
			});
		});
	});

	describe('OneNetAggregatorDebtRatio', () => {
		describe('getRoundData(uint80)', async () => {
			it('gets current issued rwas', async () => {
				assert.bnEqual((await aggregatorDebtRatio.getRoundData(0))[1], toPreciseUnit('0.5'));
			});
		});
	});
});
