const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ethers = require('ethers');
const uniq = require('lodash.uniq');
const {
	wrap,
	toBytes32,
	constants: { CONFIG_FILENAME, RWAONES_FILENAME, DEPLOYMENT_FILENAME },
} = require('../../..');
const { red, gray, yellow } = require('chalk');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadConnections,
} = require('../util');

const DEFAULTS = {
	network: 'goerli',
};

async function extractStakingBalances({
	network = DEFAULTS.network,
	deploymentPath,
	useOvm,
	rwa,
}) {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network });
	ensureDeploymentPath(deploymentPath);

	// We're just using the ERC20 members `balanceOf` and `Transfer`, so any ERC20 contract will do.
	const { getSource, getTarget, getVersions } = wrap({
		network,
		deploymentPath,
		fs,
		path,
	});

	const { abi: snxABI } = getSource({ contract: 'Rwaone' });

	/** *********** Replace Settings Here *********** **/

	// The RPC endpoint that the results will be retrieved from. Preferably this is an archive node.
	const { providerUrl, etherscanUrl } = loadConnections({
		network,
	});

	// The filename the results will be saved to.
	const owedFile = 'owedBalances.csv';

	// The address of the inverse rwa that is about to be purged.
	// Note that this must be the PROXY address, where Transfer events are emitted from.
	const iRwaContract = getTarget({ contract: `Proxy${rwa === 'rUSD' ? 'ERC20rUSD' : rwa}` });

	if (!iRwaContract) {
		throw new Error(`Cannot find rwa contract for rwa: "${rwa}"`);
	}

	const iRwaAddress = iRwaContract.address;
	console.log(gray(`Using Proxy${rwa} address of`), yellow(iRwaAddress));

	// Address of the staking contract, which we will retrieve staked balances from.
	// Note: this only works before it is released
	const lastStakingVersionThatsCurrent = getVersions({ byContract: true })[
		`StakingRewards${rwa}`
	].find(({ status }) => status === 'current');

	const stakingAddress = lastStakingVersionThatsCurrent.address;
	console.log(gray(`Using StakingRewards${rwa} address of`), yellow(stakingAddress));

	const result = await axios.get(etherscanUrl, {
		params: {
			module: 'account',
			action: 'txlist',
			address: stakingAddress,
			apikey: useOvm ? process.env.OVM_ETHERSCAN_KEY : process.env.ETHERSCAN_KEY,
		},
	});

	// The block that the staking contract was deployed, for filtering transfers into it.
	const deploymentBlock = +result.data.result[0].blockNumber;

	console.log(`Loading rewards for rwa ${rwa} on network ${network}`);

	console.log(
		gray(`Staking rewards StakingRewards${rwa} deployed at block`),
		yellow(deploymentBlock)
	);

	const provider = new ethers.providers.JsonRpcProvider(providerUrl);

	const ExchangeRates = new ethers.Contract(
		getTarget({ contract: 'ExchangeRates' }).address,
		getSource({ contract: 'ExchangeRates' }).abi,
		provider
	);

	// The price at which the inverse rwa was frozen, to compute how much users are owed after purging
	const frozenPrice = await ExchangeRates.rateForCurrency(toBytes32(rwa));

	console.log(`${rwa} current price is `, yellow(ethers.utils.formatEther(frozenPrice)));

	const isFrozen = await ExchangeRates.rateIsFrozen(toBytes32(rwa));

	if (!isFrozen) {
		throw new Error(`Error: ${rwa} not frozen`);
	}

	const SystemSettings = new ethers.Contract(
		getTarget({ contract: 'SystemSettings' }).address,
		getSource({ contract: 'SystemSettings' }).abi,
		provider
	);

	// The exchange fee incurred when users are purged into rUSD
	const exchangeFee = await SystemSettings.exchangeFeeRate(toBytes32('rUSD'));

	console.log(gray(`Exchange fee of rUSD is`), yellow(ethers.utils.formatEther(exchangeFee)));

	/** *********** --------------------- *********** **/

	// Fixed point multiplication utilities
	function multiplyDecimal(x, y) {
		const xBN = ethers.BigNumber.isBigNumber(x) ? x : ethers.BigNumber.from(x);
		const yBN = ethers.BigNumber.isBigNumber(y) ? y : ethers.BigNumber.from(y);

		const unit = ethers.utils.parseEther('1');
		return xBN.mul(yBN).div(unit);
	}

	// Retrieves a user's staking balance from the staking contract
	async function getStakingBalance(stakingContract, account) {
		return {
			address: account,
			balance: await stakingContract.balanceOf(account),
		};
	}

	function formatDate(timestamp) {
		const date = new Date(timestamp);
		return `${date.getUTCFullYear()}/${date.getUTCMonth()}/${date.getUTCDate()} ${date.getUTCHours()}:${date.getUTCMinutes()}:${date.getUTCSeconds()} UTC`;
	}

	function logProgress(i, total) {
		const fillChar = '█';
		const progress = i / total;
		const length = 50;
		const filled = Math.floor(length * progress);
		const bar = `|${fillChar.repeat(filled)}${'-'.repeat(length - filled)}|`;
		const progressString = `    ${bar} - ${i} / ${total} (${Math.round(100 * progress)}%)`;

		process.stdout.clearLine();
		process.stdout.cursorTo(0);
		process.stdout.write(progressString);
	}

	// Looks for all transfers into the staking contract
	async function fetchStakedBalances() {
		const iRwa = new ethers.Contract(iRwaAddress, snxABI, provider);
		const stakingContract = new ethers.Contract(stakingAddress, snxABI, provider);

		const currentBlock = await provider.getBlockNumber();
		const deploymentBlockDetails = await provider.getBlock(deploymentBlock);

		console.log(`Querying all transfers into the staking contract to find candidate stakers.\n`);
		console.log(`    Staking Contract: ${stakingAddress}`);
		console.log(`    Rwa: ${iRwaAddress}`);
		console.log(
			`    Starting Block: ${deploymentBlock} (${currentBlock -
			deploymentBlock} blocks ago at ${formatDate(deploymentBlockDetails.timestamp * 1000)})\n`
		);

		const transferEvents = await iRwa.queryFilter(
			{
				topics: [
					ethers.utils.id('Transfer(address,address,uint256)'),
					null,
					ethers.utils.hexZeroPad(stakingAddress, 32),
				],
			},
			deploymentBlock - 1
		);

		const candidates = uniq(transferEvents.map(e => e.args.from));

		const nonzero = [];

		console.log(`${candidates.length} candidate holders found. Querying their balances.\n`);
		let i = 0;

		for (const candidate of candidates) {
			const stakerAndBalance = await getStakingBalance(stakingContract, candidate);
			if (stakerAndBalance.balance.toString() !== '0') {
				nonzero.push(stakerAndBalance);
			}

			i += 1;
			// Log our progress
			logProgress(i, candidates.length);
		}

		console.log(`\n\n${nonzero.length} active stakers found.`);

		return nonzero;
	}

	// Computes the balances owed to each account
	function computeOwedBalances(balances) {
		console.log(`\nComputing owed rUSD balances for accounts using parameters:`);
		console.log(`    Price: ${ethers.utils.formatEther(frozenPrice)}`);
		console.log(
			`    Exchange Fee: ${ethers.utils.formatEther(
				multiplyDecimal(exchangeFee, ethers.utils.parseEther('100'))
			)}%`
		);

		const feeMultiplier = ethers.utils.parseEther('1').sub(exchangeFee);
		const result = balances.map(b => {
			const owed = multiplyDecimal(multiplyDecimal(b.balance, frozenPrice), feeMultiplier);

			return {
				address: b.address,
				balance: b.balance,
				owed: owed.toString(),
				readableBalance: ethers.utils.formatEther(b.balance),
				readableOwed: ethers.utils.formatEther(owed),
			};
		});

		const totalStaked = result.reduce(
			(total, curr) => total.add(curr.balance),
			ethers.constants.Zero
		);
		const totalOwed = result.reduce((total, curr) => total.add(curr.owed), ethers.constants.Zero);

		console.log(`\n${ethers.utils.formatEther(totalStaked, 'ether')} staked in total.`);
		console.log(`${ethers.utils.formatEther(totalOwed, 'ether')} total rUSD owed.\n`);
		return result;
	}

	function saveOwedBalances(owedRUSDBalances) {
		let csvString = 'Address,Staked Balance,Owed rUSD,Readable Staked Balance,Readable Owed rUSD\n';

		for (const balance of owedRUSDBalances) {
			const line = `${balance.address},${balance.balance},${balance.owed},${balance.readableBalance},${balance.readableOwed}\n`;
			csvString = csvString.concat(line);
		}

		csvString = csvString.concat(`\nPrice,${ethers.utils.formatEther(frozenPrice)}\n`);
		csvString = csvString.concat(`Exchange Fee,${ethers.utils.formatEther(exchangeFee)}\n`);

		console.log(`Saving results to ${owedFile}...`);
		fs.writeFileSync(owedFile, csvString);
	}

	const nonzeroBalances = await fetchStakedBalances();
	const owedRUSDBalances = computeOwedBalances(nonzeroBalances);

	saveOwedBalances(owedRUSDBalances);
}

module.exports = {
	extractStakingBalances,
	cmd: program =>
		program
			.command('extract-staking-balances')
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME}, the rwa list ${RWAONES_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-z, --use-ovm', 'Target deployment for the OVM (Optimism).')
			.option('-s, --rwa <value>', 'The rwa to extract from')
			.description('Extracts staking reward balances')
			.action(async (...args) => {
				try {
					await extractStakingBalances(...args);
				} catch (err) {
					console.error(red(err));
					console.log(err.stack);
					process.exitCode = 1;
				}
			}),
};
