'use strict';

const { gray, green, yellow, red, cyan } = require('chalk');
const ethers = require('ethers');
const axios = require('axios');

const {
	toBytes32,
	getUsers,
	constants: { CONFIG_FILENAME, DEPLOYMENT_FILENAME },
} = require('../../..');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
} = require('../util');

const { performTransactionalStep } = require('../command-utils/transact');

const DEFAULTS = {
	network: 'goerli',
	priorityGasPrice: '1',
	batchSize: 15,
};

const purgeRwas = async ({
	network = DEFAULTS.network,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
	rwasToPurge = [],
	dryRun = false,
	yes,
	privateKey,
	addresses = [],
	batchSize = DEFAULTS.batchSize,
	proxyAddress,
	useFork,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	const { rwas, deployment } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (rwasToPurge.length < 1) {
		console.log(gray('No rwas provided. Please use --rwas-to-purge option'));
		return;
	}

	// sanity-check the rwa list
	for (const rwa of rwasToPurge) {
		if (rwas.filter(({ name }) => name === rwa).length < 1) {
			console.error(red(`Rwa ${rwa} not found!`));
			process.exitCode = 1;
			return;
		} else if (['rUSD'].indexOf(rwa) >= 0) {
			console.error(red(`Rwa ${rwa} cannot be purged`));
			process.exitCode = 1;
			return;
		}
	}

	if (rwasToPurge.length > 1 && proxyAddress) {
		console.error(red(`Cannot provide a proxy address with multiple rwas`));
		process.exitCode = 1;
		return;
	}

	const { providerUrl, privateKey: envPrivateKey, explorerLinkPrefix } = loadConnections({
		network,
		useFork,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	console.log(gray(`Provider url: ${providerUrl}`));
	const provider = new ethers.providers.JsonRpcProvider(providerUrl);

	let wallet;
	if (!privateKey) {
		const account = getUsers({ network, user: 'owner' }).address; // protocolDAO
		wallet = provider.getSigner(account);
		wallet.address = await wallet.getAddress();
	} else {
		wallet = new ethers.Wallet(privateKey, provider);
	}

	console.log(gray(`Using account with public key ${wallet.address}`));
	console.log(
		gray(`Using max base fee of ${maxFeePerGas} GWEI miner tip ${maxPriorityFeePerGas} GWEI`)
	);

	console.log(gray('Dry-run:'), dryRun ? green('yes') : yellow('no'));

	if (!yes) {
		try {
			await confirmAction(
				cyan(
					`${yellow(
						'⚠ WARNING'
					)}: This action will purge the following rwas from the Rwaone contract on ${network}:\n- ${rwasToPurge.join(
						'\n- '
					)}`
				) + '\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	const { address: rwaoneAddress, source } = deployment.targets['Rwaone'];
	const { abi: rwaoneABI } = deployment.sources[source];
	const Rwaone = new ethers.Contract(rwaoneAddress, rwaoneABI, wallet);

	let totalBatches = 0;
	for (const currencyKey of rwasToPurge) {
		const { address: rwaAddress, source: rwaSource } = deployment.targets[
			`Rwa${currencyKey}`
		];

		const { abi: rwaABI } = deployment.sources[rwaSource];
		const Rwa = new ethers.Contract(rwaAddress, rwaABI, wallet);
		proxyAddress = proxyAddress || deployment.targets[`Proxy${currencyKey}`].address;

		console.log(
			gray(
				'For',
				currencyKey,
				'using source of',
				rwaSource,
				'at address',
				rwaAddress,
				'proxy',
				proxyAddress
			)
		);

		const currentRwaInRWAX = await Rwaone.rwas(toBytes32(currencyKey));

		if (rwaAddress !== currentRwaInRWAX) {
			console.error(
				red(
					`Rwa address in Rwaone for ${currencyKey} is different from what's deployed in Rwaone to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
						currentRwaInRWAX
					)}\nlocal:    ${yellow(rwaAddress)}`
				)
			);
			process.exitCode = 1;
			return;
		}

		// step 1. fetch all holders via ethplorer api
		if (network === 'mainnet') {
			const topTokenHoldersUrl = `http://api.ethplorer.io/getTopTokenHolders/${proxyAddress}`;
			const response = await axios.get(topTokenHoldersUrl, {
				params: {
					apiKey: process.env.ETHPLORER_API_KEY || 'freekey',
					limit: 1000,
				},
			});

			const topTokenHolders = response.data.holders.map(({ address }) => address);
			console.log(gray(`Found ${topTokenHolders.length} possible holders of ${currencyKey}`));
			// Filter out any 0 holder
			const supplyPerEntry = await Promise.all(
				topTokenHolders.map(entry => Rwa.balanceOf(entry))
			);
			addresses = topTokenHolders.filter((e, i) => supplyPerEntry[i] !== '0');
			console.log(gray(`Filtered to ${addresses.length} with supply`));
		}

		const totalSupplyBefore = ethers.utils.formatEther(await Rwa.totalSupply());

		if (Number(totalSupplyBefore) === 0) {
			console.log(gray('Total supply is 0, exiting.'));
			continue;
		} else {
			console.log(gray('Total supply before purge is:', totalSupplyBefore));
		}

		// Split the addresses into batch size
		// step 2. start the purge
		for (let batch = 0; batch * batchSize < addresses.length; batch++) {
			const start = batch * batchSize;
			const end = Math.min((batch + 1) * batchSize, addresses.length);
			const entries = addresses.slice(start, end);

			totalBatches++;

			console.log(`batch: ${batch} of addresses with ${entries.length} entries`);

			if (dryRun) {
				console.log(green('Would attempt to purge:', entries));
			} else {
				await performTransactionalStep({
					signer: wallet,
					contract: `Rwa${currencyKey}`,
					target: Rwa,
					write: 'purge',
					writeArg: [entries], // explicitly pass array of args so array not splat as params
					maxFeePerGas,
					maxPriorityFeePerGas,
					explorerLinkPrefix,
					encodeABI: network === 'mainnet',
				});
			}
		}

		// step 3. confirmation
		const totalSupply = ethers.utils.formatEther(await Rwa.totalSupply());
		if (Number(totalSupply) > 0) {
			console.log(
				yellow(
					`⚠⚠⚠ WARNING: totalSupply is not 0 after purge of ${currencyKey}. It is ${totalSupply}. ` +
					`Were there 100 or 1000 holders noted above? If so then we have likely hit the tokenHolder ` +
					`API limit; another purge is required for this rwa.`
				)
			);
		}
	}
	console.log(`Total number of batches: ${totalBatches}`);
};

module.exports = {
	purgeRwas,
	cmd: program =>
		program
			.command('purge-rwas')
			.description('Purge a number of rwas from the system')
			.option(
				'-a, --addresses <value>',
				'The list of holder addresses (use in testnets when Ethplorer API does not return holders)',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
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
			.option(
				'-n, --network [value]',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option('-r, --dry-run', 'Dry run - no changes transacted')
			.option(
				'-v, --private-key [value]',
				'The private key to transact with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-bs, --batch-size [value]',
				'Batch size for the addresses to be split into',
				DEFAULTS.batchSize
			)
			.option(
				'-p, --proxy-address <value>',
				'Override the proxy address for the token (only works with a single rwa given)'
			)
			.option(
				'-k, --use-fork',
				'Perform the deployment on a forked chain running on localhost (see fork command).',
				false
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.option(
				'-s, --rwas-to-purge <value>',
				'The list of rwas to purge',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.action(purgeRwas),
};
