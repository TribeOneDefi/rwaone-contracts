'use strict';

const fs = require('fs');
const { gray, yellow, red, cyan, green } = require('chalk');
const ethers = require('ethers');

const {
	toBytes32,
	getUsers,
	constants: { CONFIG_FILENAME, DEPLOYMENT_FILENAME, ZERO_ADDRESS },
} = require('../../..');

const { getContract } = require('../command-utils/contract');
const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
} = require('../util');

const { performTransactionalStep } = require('../command-utils/transact');

const DEFAULTS = {
	network: 'goerli',
	gasLimit: 3e5,
	priorityGasPrice: '1',
};

const removeTribes = async ({
	network = DEFAULTS.network,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
	gasLimit = DEFAULTS.gasLimit,
	tribesToRemove = [],
	yes,
	useOvm,
	useFork,
	dryRun = false,
	privateKey,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network, useOvm });
	ensureDeploymentPath(deploymentPath);

	const {
		tribes,
		tribesFile,
		deployment,
		deploymentFile,
		config,
		configFile,
		ownerActions,
		ownerActionsFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (tribesToRemove.length < 1) {
		console.log(gray('No tribes provided. Please use --tribes-to-remove option'));
		return;
	}

	// sanity-check the tribe list
	for (const tribe of tribesToRemove) {
		if (tribes.filter(({ name }) => name === tribe).length < 1) {
			console.error(red(`Tribe ${tribe} not found!`));
			process.exitCode = 1;
			return;
		} else if (['rUSD'].indexOf(tribe) >= 0) {
			console.error(red(`Tribe ${tribe} cannot be removed`));
			process.exitCode = 1;
			return;
		}
	}

	const { providerUrl, privateKey: envPrivateKey, explorerLinkPrefix } = loadConnections({
		network,
		useFork,
		useOvm,
	});

	// if not specified, or in a local network, override the private key passed as a CLI option, with the one specified in .env
	if (network !== 'local' && !privateKey && !useFork) {
		privateKey = envPrivateKey;
	}

	const provider = new ethers.providers.JsonRpcProvider(providerUrl);
	let wallet;
	if (!privateKey) {
		const account = getUsers({ network, useOvm, user: 'owner' }).address; // protocolDAO on L1, Owner Relay on L2
		wallet = provider.getSigner(account);
		wallet.address = await wallet.getAddress();
	} else {
		wallet = new ethers.Wallet(privateKey, provider);
	}

	console.log(gray(`Using account with public key ${wallet.address}`));
	console.log(
		gray(
			`Using max base gas of ${maxFeePerGas} GWEI, miner tip ${maxPriorityFeePerGas} GWEI with a gas limit of ${gasLimit}`
		)
	);

	console.log(gray('Dry-run:'), dryRun ? green('yes') : yellow('no'));

	if (!yes) {
		try {
			await confirmAction(
				cyan(
					`${yellow(
						'⚠ WARNING'
					)}: This action will remove the following tribes from the Rwaone contract on ${network}:\n- ${tribesToRemove.join(
						'\n- '
					)}`
				) + '\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	const Rwaone = getContract({
		contract: 'Rwaone',
		network,
		deploymentPath,
		wallet,
	});

	const Issuer = getContract({
		contract: 'Issuer',
		network,
		deploymentPath,
		wallet,
	});

	const ExchangeRates = getContract({
		contract: 'ExchangeRates',
		network,
		deploymentPath,
		wallet,
	});

	const SystemStatus = getContract({
		contract: 'SystemStatus',
		network,
		deploymentPath,
		wallet,
	});

	// deep clone these configurations so we can mutate and persist them
	const updatedConfig = JSON.parse(JSON.stringify(config));
	const updatedDeployment = JSON.parse(JSON.stringify(deployment));
	let updatedTribes = JSON.parse(fs.readFileSync(tribesFile));

	for (const currencyKey of tribesToRemove) {
		const { address: tribeAddress, source: tribeSource } = deployment.targets[
			`Tribe${currencyKey}`
		];
		const { abi: tribeABI } = deployment.sources[tribeSource];
		const Tribe = new ethers.Contract(tribeAddress, tribeABI, wallet);

		const currentTribeInRWAX = await Rwaone.tribes(toBytes32(currencyKey));

		if (tribeAddress !== currentTribeInRWAX) {
			console.error(
				red(
					`Tribe address in Rwaone for ${currencyKey} is different from what's deployed in Rwaone to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
						currentTribeInRWAX
					)}\nlocal:    ${yellow(tribeAddress)}`
				)
			);
			process.exitCode = 1;
			return;
		}

		// now check total supply (is required in Rwaone.removeTribe)
		const totalSupply = ethers.utils.formatEther(await Tribe.totalSupply());
		if (Number(totalSupply) > 0) {
			const totalSupplyInUSD = ethers.utils.formatEther(
				await ExchangeRates.effectiveValue(
					toBytes32(currencyKey),
					ethers.utils.parseEther(totalSupply),
					toBytes32('rUSD')
				)
			);
			try {
				await confirmAction(
					cyan(
						`Tribe${currencyKey}.totalSupply is non-zero: ${yellow(totalSupply)} which is $${yellow(
							totalSupplyInUSD
						)}\n${red(`THIS WILL DEPRECATE THE TRIBE BY ITS PROXY. ARE YOU SURE???.`)}`
					) + '\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		// perform transaction if owner of Rwaone or append to owner actions list
		if (dryRun) {
			console.log(green('Would attempt to remove the tribe:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'Issuer',
				target: Issuer,
				write: 'removeTribe',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				maxFeePerGas,
				maxPriorityFeePerGas,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});

			// now update the config and deployment JSON files
			const contracts = ['Proxy', 'TokenState', 'Tribe'].map(name => `${name}${currencyKey}`);
			for (const contract of contracts) {
				delete updatedConfig[contract];
				delete updatedDeployment.targets[contract];
			}
			fs.writeFileSync(configFile, stringify(updatedConfig));
			fs.writeFileSync(deploymentFile, stringify(updatedDeployment));

			// and update the tribes.json file
			updatedTribes = updatedTribes.filter(({ name }) => name !== currencyKey);
			fs.writeFileSync(tribesFile, stringify(updatedTribes));
		}

		// now try to remove rate
		if (dryRun) {
			console.log(green('Would attempt to remove the aggregator:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'ExchangeRates',
				target: ExchangeRates,
				read: 'aggregators',
				readArg: toBytes32(currencyKey),
				expected: input => input === ZERO_ADDRESS,
				write: 'removeAggregator',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});
		}

		// now try to unsuspend the tribe
		if (dryRun) {
			console.log(green('Would attempt to remove the tribe:', currencyKey));
		} else {
			await performTransactionalStep({
				signer: wallet,
				contract: 'SystemStatus',
				target: SystemStatus,
				read: 'tribeSuspension',
				readArg: toBytes32(currencyKey),
				expected: input => !input.suspended,
				write: 'resumeTribe',
				writeArg: toBytes32(currencyKey),
				gasLimit,
				explorerLinkPrefix,
				ownerActions,
				ownerActionsFile,
				encodeABI: network === 'mainnet',
			});
		}
	}
};

module.exports = {
	removeTribes,
	cmd: program =>
		program
			.command('remove-tribes')
			.description('Remove a number of tribes from the system')
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --max-fee-per-gas <value>', 'Maximum base gas fee price in GWEI')
			.option(
				'--max-priority-fee-per-gas <value>',
				'Priority gas fee price in GWEI',
				DEFAULTS.priorityGasPrice
			)
			.option('-l, --gas-limit <value>', 'Gas limit', 1e6)
			.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'goerli')
			.option('-r, --dry-run', 'Dry run - no changes transacted')
			.option(
				'-k, --use-fork',
				'Perform the deployment on a forked chain running on localhost (see fork command).',
				false
			)
			.option('-z, --use-ovm', 'Target deployment for the OVM (Optimism).')
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.option(
				'-s, --tribes-to-remove <value>',
				'The list of tribes to remove',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.action(removeTribes),
};
