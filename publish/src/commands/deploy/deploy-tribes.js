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
	addNewTribes,
	config,
	deployer,
	freshDeploy,
	generateSolidity,
	network,
	tribes,
	systemSuspended,
	useFork,
	yes,
}) => {
	// ----------------
	// Tribes
	// ----------------
	console.log(gray(`\n------ DEPLOY TRIBES ------\n`));

	const { Issuer, ReadProxyAddressResolver } = deployer.deployedContracts;

	// The list of tribe to be added to the Issuer once dependencies have been set up
	const tribesToAdd = [];

	for (const { name: currencyKey, subclass } of tribes) {
		console.log(gray(`\n   --- TRIBE ${currencyKey} ---\n`));

		const tokenStateForTribe = await deployer.deployContract({
			name: `TokenState${currencyKey}`,
			source: 'TokenState',
			args: [account, ZERO_ADDRESS],
			force: addNewTribes,
		});

		const proxyForTribe = await deployer.deployContract({
			name: `Proxy${currencyKey}`,
			source: 'ProxyERC20',
			args: [account],
			force: addNewTribes,
		});

		const currencyKeyInBytes = toBytes32(currencyKey);

		const tribeConfig = config[`Tribe${currencyKey}`] || {};

		// track the original supply if we're deploying a new tribe contract for an existing tribe
		let originalTotalSupply = 0;
		if (tribeConfig.deploy) {
			try {
				const oldTribe = deployer.getExistingContract({ contract: `Tribe${currencyKey}` });
				originalTotalSupply = await oldTribe.totalSupply();
			} catch (err) {
				if (!freshDeploy) {
					// only throw if not local - allows local environments to handle both new
					// and updating configurations
					throw err;
				}
			}
		}

		// user confirm totalSupply is correct for oldTribe before deploy new Tribe
		if (tribeConfig.deploy && originalTotalSupply > 0) {
			if (!systemSuspended && !generateSolidity && !useFork) {
				console.log(
					yellow(
						'⚠⚠⚠ WARNING: The system is not suspended! Adding a tribe here without using a migration contract is potentially problematic.'
					) +
					yellow(
						`⚠⚠⚠ Please confirm - ${network}:\n` +
						`Tribe${currencyKey} totalSupply is ${originalTotalSupply} \n` +
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

		const sourceContract = subclass || 'Tribe';
		const tribe = await deployer.deployContract({
			name: `Tribe${currencyKey}`,
			source: sourceContract,
			deps: [`TokenState${currencyKey}`, `Proxy${currencyKey}`, 'Rwaone', 'FeePool'],
			args: [
				addressOf(proxyForTribe),
				addressOf(tokenStateForTribe),
				`Tribe ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				originalTotalSupply,
				addressOf(ReadProxyAddressResolver),
			],
			force: addNewTribes,
		});

		// Save the tribe to be added once the AddressResolver has been synced.
		if (tribe && Issuer) {
			tribesToAdd.push({
				tribe,
				currencyKeyInBytes,
			});
		}
	}

	return {
		tribesToAdd,
	};
};
