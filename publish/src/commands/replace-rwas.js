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

const replaceRwas = async ({
	network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	maxFeePerGas,
	maxPriorityFeePerGas = DEFAULTS.priorityGasPrice,
	subclass,
	rwasToReplace,
	privateKey,
	yes,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	const { getTarget } = wrap({ network, fs, path });

	const {
		configFile,
		rwas,
		rwasFile,
		deployment,
		deploymentFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (rwasToReplace.length < 1) {
		console.log(yellow('No rwas provided. Please use --rwas-to-replace option'));
		return;
	}

	if (!subclass) {
		console.log(yellow('Please provide a valid Rwa subclass'));
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

	// sanity-check the rwa list
	for (const rwa of rwasToReplace) {
		if (rwas.filter(({ name }) => name === rwa).length < 1) {
			console.error(red(`Rwa ${rwa} not found!`));
			process.exitCode = 1;
			return;
		} else if (['rUSD'].indexOf(rwa) >= 0) {
			console.error(red(`Rwa ${rwa} cannot be replaced`));
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

	// convert the list of rwas into a list of deployed contracts
	const deployedRwas = rwasToReplace.map(currencyKey => {
		const { address: rwaAddress, source: rwaSource } = deployment.targets[
			`Rwa${currencyKey}`
		];
		const { address: proxyAddress, source: proxySource } = deployment.targets[
			`Proxy${currencyKey}`
		];
		const { address: tokenStateAddress, source: tokenStateSource } = deployment.targets[
			`TokenState${currencyKey}`
		];

		const { abi: rwaABI } = deployment.sources[rwaSource];
		const { abi: tokenStateABI } = deployment.sources[tokenStateSource];
		const { abi: proxyABI } = deployment.sources[proxySource];

		const Rwa = new ethers.Contract(rwaAddress, rwaABI, provider);
		const TokenState = new ethers.Contract(tokenStateAddress, tokenStateABI, provider);
		const Proxy = new ethers.Contract(proxyAddress, proxyABI, provider);

		return {
			Rwa,
			TokenState,
			Proxy,
			currencyKey,
			rwaAddress,
		};
	});

	const totalSupplies = {};
	try {
		const totalSupplyList = await Promise.all(
			deployedRwas.map(({ Rwa }) => Rwa.totalSupply())
		);
		totalSupplyList.forEach(
			(supply, i) => (totalSupplies[rwasToReplace[i]] = totalSupplyList[i])
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
					)}: This action will replace the following rwas into ${subclass} on ${network}:\n- ${rwasToReplace
						.map(
							rwa =>
								rwa + ' (totalSupply of: ' + ethers.utils.formatEther(totalSupplies[rwa]) + ')'
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
	const updatedRwas = JSON.parse(fs.readFileSync(rwasFile));

	const runStep = async opts =>
		performTransactionalStep({
			...opts,
			deployer,
			signer,
			explorerLinkPrefix,
		});

	for (const { currencyKey, Rwa, Proxy, TokenState } of deployedRwas) {
		const currencyKeyInBytes = toBytes32(currencyKey);
		const rwaContractName = `Rwa${currencyKey}`;

		// STEPS
		// 1. set old ExternTokenState.setTotalSupply(0) // owner
		await runStep({
			contract: rwaContractName,
			target: Rwa,
			read: 'totalSupply',
			expected: input => input === '0',
			write: 'setTotalSupply',
			writeArg: '0',
		});

		// 2. invoke Issuer.removeRwa(currencyKey) // owner
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'rwas',
			readArg: currencyKeyInBytes,
			expected: input => input === ZERO_ADDRESS,
			write: 'removeRwa',
			writeArg: currencyKeyInBytes,
		});

		// 3. use Deployer to deploy
		const replacementRwa = await deployer.deployContract({
			name: rwaContractName,
			source: subclass,
			force: true,
			args: [
				Proxy.address,
				TokenState.address,
				`Rwa ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				totalSupplies[currencyKey], // ensure new Rwa gets totalSupply set from old Rwa
				resolverAddress,
			],
		});

		// Ensure this new rwa has its resolver cache set
		const overrides = await assignGasOptions({
			tx: {},
			provider,
			maxFeePerGas,
			maxPriorityFeePerGas,
		});

		const tx = await replacementRwa.rebuildCache(overrides);
		await tx.wait();

		// 4. Issuer.addRwa(newone) // owner
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'rwas',
			readArg: currencyKeyInBytes,
			expected: input => input === replacementRwa.address,
			write: 'addRwa',
			writeArg: replacementRwa.address,
		});

		// 5. old TokenState.setAssociatedContract(newone) // owner
		await runStep({
			contract: `TokenState${currencyKey}`,
			target: TokenState,
			read: 'associatedContract',
			expected: input => input === replacementRwa.address,
			write: 'setAssociatedContract',
			writeArg: replacementRwa.address,
		});

		// 6. old Proxy.setTarget(newone) // owner
		await runStep({
			contract: `Proxy${currencyKey}`,
			target: Proxy,
			read: 'target',
			expected: input => input === replacementRwa.address,
			write: 'setTarget',
			writeArg: replacementRwa.address,
		});

		// Update the rwas.json file
		const rwaToUpdateInJSON = updatedRwas.find(({ name }) => name === currencyKey);
		rwaToUpdateInJSON.subclass = subclass;
		fs.writeFileSync(rwasFile, stringify(updatedRwas));
	}
};

module.exports = {
	replaceRwas,
	cmd: program =>
		program
			.command('replace-rwas')
			.description('Replaces a number of existing rwas with a subclass')
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
				'-s, --rwas-to-replace <value>',
				'The list of rwas to replace',
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
			.option('-x, --max-supply-to-purge-in-usd [value]', 'For PurgeableRwa, max supply', 1000)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.action(replaceRwas),
};
