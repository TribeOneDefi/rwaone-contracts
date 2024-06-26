const fs = require('fs');
const hre = require('hardhat');

const path = require('path');

const rwaone = require('..');

const commands = {
	build: require('./src/commands/build').build,
	deploy: require('./src/commands/deploy').deploy,
	prepareDeploy: require('./src/commands/prepare-deploy').prepareDeploy,
	connectBridge: require('./src/commands/connect-bridge').connectBridge,
};

async function deployInstance({
	addNewRwas,
	buildPath,
	signer,
	freshDeploy,
	generateSolidity = false,
	ignoreCustomParameters = false,
	network,
	skipFeedChecks = true,
	useFork = false,
	useOvm,
	provider,
}) {
	await commands.deploy({
		addNewRwas,
		buildPath,
		concurrency: 1,
		freshDeploy: freshDeploy,
		generateSolidity,
		ignoreCustomParameters,
		network,
		signer: signer,
		skipFeedChecks,
		useFork,
		useOvm,
		provider,
		maxFeePerGas: 100,
		maxPriorityFeePerGas: 2,
		yes: true,
	});
}

async function deploy(runtime, networkVariant) {
	if (
		networkVariant !== 'local' &&
		networkVariant !== 'local-ovm' &&
		networkVariant !== hre.network.name
	) {
		throw new Error(
			`Wrong network: set to "${networkVariant}". It should be "${hre.network.name}".`
		);
	}

	let network = networkVariant;
	let useOvm = false;
	if (networkVariant.endsWith('-ovm')) {
		useOvm = true;
		network = networkVariant.slice(0, networkVariant.length - 4);
	}
	const buildPath = path.join(__dirname, '..', rwaone.constants.BUILD_FOLDER);

	// get the signer that we want to have for the deployer
	let signer = await runtime.getDefaultSigner({});
	try {
		// if cannon can give us the signer for the owner address, we should use that
		const ownerAddress = rwaone.getUsers({ network, useOvm, user: 'owner' }).address;
		signer = await runtime.getSigner(ownerAddress);
	} catch (err) {
		// otherwise we want to use the cannon default signer, which is set above
		console.log(err);
	}

	await deployInstance({
		addNewRwas: true,
		buildPath,
		useOvm,
		network,
		freshDeploy: networkVariant.startsWith('local'),
		provider: runtime.provider,
		signer,
	});

	// pull deployed contract information

	const allTargets = rwaone.getTarget({ fs, path, network, useOvm });

	const contracts = {};
	for (const [name, target] of Object.entries(allTargets)) {
		try {
			const artifactData = await runtime.getArtifact(target.source);
			contracts[name] = {
				address: target.address,
				sourceName: artifactData.sourceName,
				contractName: artifactData.contractName,
				abi: rwaone.getSource({ fs, path, network, useOvm, contract: target.source }).abi,
				deployTxn: target.txn,
			};
		} catch (e) {
			console.log(e);
		}
	}

	return { contracts };
}

if (module === require.main) {
	deploy();
}

module.exports = {
	deploy,
};
