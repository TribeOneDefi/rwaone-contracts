'use strict';

const { gray } = require('chalk');
const {
	utils: { isAddress },
} = require('ethers');
const { toBytes32 } = require('../../../..');

module.exports = async ({
	addressOf,
	deployer,
	explorerLinkPrefix,
	feeds,
	generateSolidity,
	network,
	runStep,
	rwas,
}) => {
	// now configure rwas
	console.log(gray(`\n------ CONFIGURE RWAS ------\n`));

	const { ExchangeRates } = deployer.deployedContracts;

	for (const { name: currencyKey, asset } of rwas) {
		console.log(gray(`\n   --- RWA ${currencyKey} ---\n`));

		const currencyKeyInBytes = toBytes32(currencyKey);

		const rwa = deployer.deployedContracts[`Rwa${currencyKey}`];
		const tokenStateForRwa = deployer.deployedContracts[`TokenState${currencyKey}`];
		const proxyForRwa = deployer.deployedContracts[`Proxy${currencyKey}`];

		let ExistingRwa;
		try {
			ExistingRwa = deployer.getExistingContract({ contract: `Rwa${currencyKey}` });
		} catch (err) {
			// ignore error as there is no existing rwa to copy from
		}
		// when generating solidity only, ensure that this is run to copy across rwa supply
		if (rwa && generateSolidity && ExistingRwa && ExistingRwa.address !== rwa.address) {
			const generateExplorerComment = ({ address }) =>
				`// ${explorerLinkPrefix}/address/${address}`;

			await runStep({
				contract: `Rwa${currencyKey}`,
				target: rwa,
				write: 'setTotalSupply',
				writeArg: addressOf(rwa),
				comment: `Ensure the new rwa has the totalSupply from the previous one`,
				customSolidity: {
					name: `copyTotalSupplyFrom_${currencyKey}`,
					instructions: [
						generateExplorerComment({ address: ExistingRwa.address }),
						`Rwa existingRwa = Rwa(${ExistingRwa.address})`,
						generateExplorerComment({ address: rwa.address }),
						`Rwa newRwa = Rwa(${rwa.address})`,
						`newRwa.setTotalSupply(existingRwa.totalSupply())`,
					],
				},
			});
		}

		if (tokenStateForRwa && rwa) {
			await runStep({
				contract: `TokenState${currencyKey}`,
				target: tokenStateForRwa,
				read: 'associatedContract',
				expected: input => input === addressOf(rwa),
				write: 'setAssociatedContract',
				writeArg: addressOf(rwa),
				comment: `Ensure the ${currencyKey} rwa can write to its TokenState`,
			});
		}

		// Setup proxy for rwa
		if (proxyForRwa && rwa) {
			await runStep({
				contract: `Proxy${currencyKey}`,
				target: proxyForRwa,
				read: 'target',
				expected: input => input === addressOf(rwa),
				write: 'setTarget',
				writeArg: addressOf(rwa),
				comment: `Ensure the ${currencyKey} rwa Proxy is correctly connected to the Rwa`,
			});

			await runStep({
				contract: `Rwa${currencyKey}`,
				target: rwa,
				read: 'proxy',
				expected: input => input === addressOf(proxyForRwa),
				write: 'setProxy',
				writeArg: addressOf(proxyForRwa),
				comment: `Ensure the ${currencyKey} rwa is connected to its Proxy`,
			});
		}

		const { feed } = feeds[asset] || {};

		// now setup price aggregator if any for the rwa
		if (isAddress(feed) && ExchangeRates) {
			await runStep({
				contract: `ExchangeRates`,
				target: ExchangeRates,
				read: 'aggregators',
				readArg: currencyKeyInBytes,
				expected: input => input === feed,
				write: 'addAggregator',
				writeArg: [currencyKeyInBytes, feed],
				comment: `Ensure the ExchangeRates contract has the feed for ${currencyKey}`,
			});
		}
	}
};
