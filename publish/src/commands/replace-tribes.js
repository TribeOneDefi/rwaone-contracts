'use strict';

const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { gray, yellow, red, cyan } = require('chalk');

const { loadCompiledFiles } = require('../solidity');
const Deployer = require('../Deployer');

const {
	toBytes32,
	constants: { CONFIG_FILENAME, COMPILED_FOLDER, DEPLOYMENT_FILENAME, BUILD_FOLDER, ZERO_ADDRESS },
	wrap,
} = require('../../..');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
	assignGasOptions,
} = require('../util');
const { performTransactionalStep } = require('../command-utils/transact');

const DEFAULTS = {
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
	priorityGasPrice: '1',
};

const replaceTribes = async ({
	network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
	subclass,
	tribesToReplace,
	privateKey,
	yes,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	const { getTarget } = wrap({ network, fs, path });

	const {
		configFile,
		tribes,
		tribesFile,
		deployment,
		deploymentFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (tribesToReplace.length < 1) {
		console.log(yellow('No tribes provided. Please use --tribes-to-replace option'));
		return;
	}

	if (!subclass) {
		console.log(yellow('Please provide a valid Tribe subclass'));
		return;
	}

	// now check the subclass is valud
	const compiledSourcePath = path.join(buildPath, COMPILED_FOLDER);
	const foundSourceFileForSubclass = fs
		.readdirSync(compiledSourcePath)
		.filter(name => /^.+\.json$/.test(name))
		.find(entry => new RegExp(`^${subclass}.json$`).test(entry));

	if (!foundSourceFileForSubclass) {
		console.log(
			yellow(`Cannot find a source file called: ${subclass}.json. Please check the name`)
		);
		return;
	}

	// sanity-check the tribe list
	for (const tribe of tribesToReplace) {
		if (tribes.filter(({ name }) => name === tribe).length < 1) {
			console.error(red(`Tribe ${tribe} not found!`));
			process.exitCode = 1;
			return;
		} else if (['rUSD'].indexOf(tribe) >= 0) {
			console.error(red(`Tribe ${tribe} cannot be replaced`));
			process.exitCode = 1;
			return;
		}
	}

	const { providerUrl, privateKey: envPrivateKey, explorerLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	console.log(gray('Loading the compiled contracts locally...'));
	const { compiled } = loadCompiledFiles({ buildPath });

	const deployer = new Deployer({
		compiled,
		config: {},
		configFile,
		deployment,
		deploymentFile,
		maxFeePerGas,
		maxPriorityFeePerGas,
		network,
		privateKey,
		providerUrl,
		dryRun: false,
	});

	// TODO - this should be fixed in Deployer
	deployer.deployedContracts.SafeDecimalMath = {
		address: getTarget({ contract: 'SafeDecimalMath' }).address,
	};

	const { account, signer } = deployer;
	const provider = deployer.provider;

	console.log(gray(`Using account with public key ${account}`));
	console.log(gray(`Using max base fee of ${maxFeePerGas} GWEI`));

	const currentGasPrice = await provider.getGasPrice();
	console.log(
		gray(`Current gas price is approx: ${ethers.utils.formatUnits(currentGasPrice, 'gwei')} GWEI`)
	);

	// convert the list of tribes into a list of deployed contracts
	const deployedTribes = tribesToReplace.map(currencyKey => {
		const { address: tribeAddress, source: tribeSource } = deployment.targets[
			`Tribe${currencyKey}`
		];
		const { address: proxyAddress, source: proxySource } = deployment.targets[
			`Proxy${currencyKey}`
		];
		const { address: tokenStateAddress, source: tokenStateSource } = deployment.targets[
			`TokenState${currencyKey}`
		];

		const { abi: tribeABI } = deployment.sources[tribeSource];
		const { abi: tokenStateABI } = deployment.sources[tokenStateSource];
		const { abi: proxyABI } = deployment.sources[proxySource];

		const Tribe = new ethers.Contract(tribeAddress, tribeABI, provider);
		const TokenState = new ethers.Contract(tokenStateAddress, tokenStateABI, provider);
		const Proxy = new ethers.Contract(proxyAddress, proxyABI, provider);

		return {
			Tribe,
			TokenState,
			Proxy,
			currencyKey,
			tribeAddress,
		};
	});

	const totalSupplies = {};
	try {
		const totalSupplyList = await Promise.all(
			deployedTribes.map(({ Tribe }) => Tribe.totalSupply())
		);
		totalSupplyList.forEach(
			(supply, i) => (totalSupplies[tribesToReplace[i]] = totalSupplyList[i])
		);
	} catch (err) {
		console.error(
			red(
				'Cannot connect to existing contracts. Please double check the deploymentPath is correct for the network allocated'
			)
		);
		process.exitCode = 1;
		return;
	}
	if (!yes) {
		try {
			await confirmAction(
				cyan(
					`${yellow(
						'⚠ WARNING'
					)}: This action will replace the following tribes into ${subclass} on ${network}:\n- ${tribesToReplace
						.map(
							tribe =>
								tribe + ' (totalSupply of: ' + ethers.utils.formatEther(totalSupplies[tribe]) + ')'
						)
						.join('\n- ')}`
				) + '\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	const { address: issuerAddress, source } = deployment.targets['Issuer'];
	const { abi: issuerABI } = deployment.sources[source];
	const Issuer = new ethers.Contract(issuerAddress, issuerABI, provider);

	const resolverAddress = await Issuer.resolver();
	const updatedTribes = JSON.parse(fs.readFileSync(tribesFile));

	const runStep = async opts =>
		performTransactionalStep({
			...opts,
			deployer,
			signer,
			explorerLinkPrefix,
		});

	for (const { currencyKey, Tribe, Proxy, TokenState } of deployedTribes) {
		const currencyKeyInBytes = toBytes32(currencyKey);
		const tribeContractName = `Tribe${currencyKey}`;

		// STEPS
		// 1. set old ExternTokenState.setTotalSupply(0) // owner
		await runStep({
			contract: tribeContractName,
			target: Tribe,
			read: 'totalSupply',
			expected: input => input === '0',
			write: 'setTotalSupply',
			writeArg: '0',
		});

		// 2. invoke Issuer.removeTribe(currencyKey) // owner
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'tribes',
			readArg: currencyKeyInBytes,
			expected: input => input === ZERO_ADDRESS,
			write: 'removeTribe',
			writeArg: currencyKeyInBytes,
		});

		// 3. use Deployer to deploy
		const replacementTribe = await deployer.deployContract({
			name: tribeContractName,
			source: subclass,
			force: true,
			args: [
				Proxy.address,
				TokenState.address,
				`Tribe ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				totalSupplies[currencyKey], // ensure new Tribe gets totalSupply set from old Tribe
				resolverAddress,
			],
		});

		// Ensure this new tribe has its resolver cache set
		const overrides = await assignGasOptions({
			tx: {},
			provider,
			maxFeePerGas,
			maxPriorityFeePerGas,
		});

		const tx = await replacementTribe.rebuildCache(overrides);
		await tx.wait();

		// 4. Issuer.addTribe(newone) // owner
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'tribes',
			readArg: currencyKeyInBytes,
			expected: input => input === replacementTribe.address,
			write: 'addTribe',
			writeArg: replacementTribe.address,
		});

		// 5. old TokenState.setAssociatedContract(newone) // owner
		await runStep({
			contract: `TokenState${currencyKey}`,
			target: TokenState,
			read: 'associatedContract',
			expected: input => input === replacementTribe.address,
			write: 'setAssociatedContract',
			writeArg: replacementTribe.address,
		});

		// 6. old Proxy.setTarget(newone) // owner
		await runStep({
			contract: `Proxy${currencyKey}`,
			target: Proxy,
			read: 'target',
			expected: input => input === replacementTribe.address,
			write: 'setTarget',
			writeArg: replacementTribe.address,
		});

		// Update the tribes.json file
		const tribeToUpdateInJSON = updatedTribes.find(({ name }) => name === currencyKey);
		tribeToUpdateInJSON.subclass = subclass;
		fs.writeFileSync(tribesFile, stringify(updatedTribes));
	}
};

module.exports = {
	replaceTribes,
	cmd: program =>
		program
			.command('replace-tribes')
			.description('Replaces a number of existing tribes with a subclass')
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				DEFAULTS.buildPath
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
			.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'goerli')
			.option(
				'-s, --tribes-to-replace <value>',
				'The list of tribes to replace',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.option('-u, --subclass <value>', 'Subclass to switch into')
			.option(
				'-v, --private-key [value]',
				'The private key to transact with (only works in local mode, otherwise set in .env).'
			)
			.option('-x, --max-supply-to-purge-in-usd [value]', 'For PurgeableTribe, max supply', 1000)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.action(replaceTribes),
};
