const { contract, web3 } = require('hardhat');
const { setupAllContracts } = require('./setup');
const { assert } = require('./common');
const { artifacts } = require('hardhat');
const { toBN } = web3.utils;

contract('RwaoneBridgeEscrow (spec tests) @ovm-skip', accounts => {
	const [, owner, snxBridgeToOptimism, user] = accounts;

	let rwaone, tribeetixProxy, tribeetixBridgeEscrow;

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				Rwaone: rwaone,
				ProxyERC20Rwaone: tribeetixProxy,
				RwaoneBridgeEscrow: tribeetixBridgeEscrow,
			} = await setupAllContracts({
				accounts,
				contracts: ['Rwaone', 'RwaoneBridgeEscrow'],
			}));

			// use implementation ABI on the proxy address to simplify calling
			rwaone = await artifacts.require('Rwaone').at(tribeetixProxy.address);
		});

		describe('approveBridge', () => {
			describe('when invoked by the owner', () => {
				const amount = toBN('1000');

				beforeEach(async () => {
					await rwaone.transfer(tribeetixBridgeEscrow.address, amount, {
						from: owner,
					});
				});

				describe('when there is no approval', () => {
					it(' should fail', async () => {
						await assert.revert(
							rwaone.transferFrom(tribeetixBridgeEscrow.address, user, amount, {
								from: snxBridgeToOptimism,
							}),
							'SafeMath: subtraction overflow'
						);
					});
				});

				describe('when there is approval', () => {
					beforeEach(async () => {
						await tribeetixBridgeEscrow.approveBridge(
							rwaone.address,
							snxBridgeToOptimism,
							amount,
							{
								from: owner,
							}
						);
					});

					describe('when the bridge invokes transferFrom()', () => {
						beforeEach(async () => {
							await rwaone.transferFrom(tribeetixBridgeEscrow.address, user, amount, {
								from: snxBridgeToOptimism,
							});
						});

						it("increases the users's balance", async () => {
							assert.bnEqual(await rwaone.balanceOf(user), amount);
						});
					});
				});
			});
		});
	});
});
