'use strict';

const { gray, yellow } = require('chalk');

const { confirmAction } = require('../../util');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../../../..');

module.exports = async ({
	account,
	addressOf,
	addNewRwas,
	config,
	deployer,
	freshDeploy,
	generateSolidity,
	network,
	rwas,
	systemSuspended,
	useFork,
	yes,
}) => {
	// ----------------
	// Rwas
	// ----------------
	console.log(gray(`\n------ DEPLOY RWAS ------\n`));

	const { Issuer, ReadProxyAddressResolver } = deployer.deployedContracts;

	// The list of rwa to be added to the Issuer once dependencies have been set up
	const rwasToAdd = [];

	for (const { name: currencyKey, subclass } of rwas) {
		console.log(gray(`\n   --- RWA ${currencyKey} ---\n`));

		const tokenStateForRwa = await deployer.deployContract({
			name: `TokenState${currencyKey}`,
			source: 'TokenState',
			args: [account, ZERO_ADDRESS],
			force: addNewRwas,
		});

		const proxyForRwa = await deployer.deployContract({
			name: `Proxy${currencyKey}`,
			source: 'ProxyERC20',
			args: [account],
			force: addNewRwas,
		});

		const currencyKeyInBytes = toBytes32(currencyKey);

		const rwaConfig = config[`Rwa${currencyKey}`] || {};

		// track the original supply if we're deploying a new rwa contract for an existing rwa
		let originalTotalSupply = 0;
		if (rwaConfig.deploy) {
			try {
				const oldRwa = deployer.getExistingContract({ contract: `Rwa${currencyKey}` });
				originalTotalSupply = await oldRwa.totalSupply();
			} catch (err) {
				if (!freshDeploy) {
					// only throw if not local - allows local environments to handle both new
					// and updating configurations
					throw err;
				}
			}
		}

		// user confirm totalSupply is correct for oldRwa before deploy new Rwa
		if (rwaConfig.deploy && originalTotalSupply > 0) {
			if (!systemSuspended && !generateSolidity && !useFork) {
				console.log(
					yellow(
						'⚠⚠⚠ WARNING: The system is not suspended! Adding a rwa here without using a migration contract is potentially problematic.'
					) +
					yellow(
						`⚠⚠⚠ Please confirm - ${network}:\n` +
						`Rwa${currencyKey} totalSupply is ${originalTotalSupply} \n` +
						'NOTE: Deploying with this amount is dangerous when the system is not already suspended'
					),
					gray('-'.repeat(50)) + '\n'
				);

				if (!yes) {
					try {
						await confirmAction(gray('Do you want to continue? (y/n) '));
					} catch (err) {
						console.log(gray('Operation cancelled'));
						process.exit();
					}
				}
			}
		}

		const sourceContract = subclass || 'Rwa';
		const rwa = await deployer.deployContract({
			name: `Rwa${currencyKey}`,
			source: sourceContract,
			deps: [`TokenState${currencyKey}`, `Proxy${currencyKey}`, 'Rwaone', 'FeePool'],
			args: [
				addressOf(proxyForRwa),
				addressOf(tokenStateForRwa),
				`Rwa ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				originalTotalSupply,
				addressOf(ReadProxyAddressResolver),
			],
			force: addNewRwas,
		});

		// Save the rwa to be added once the AddressResolver has been synced.
		if (rwa && Issuer) {
			rwasToAdd.push({
				rwa,
				currencyKeyInBytes,
			});
		}
	}

	return {
		rwasToAdd,
	};
};
