'use strict';

const { gray } = require('chalk');

module.exports = async ({ addressOf, deployer, runStep, rwasToAdd }) => {
	console.log(gray(`\n------ ADD RWAS TO ISSUER ------\n`));

	const { Issuer } = deployer.deployedContracts;

	// Set up the connection to the Issuer for each Rwa (requires FlexibleStorage to have been configured)

	// First filter out all those rwas which are already properly imported
	console.log(gray('Filtering rwas to add to the issuer.'));
	const filteredRwas = [];
	const seen = new Set();
	for (const rwa of rwasToAdd) {
		const issuerRwaAddress = await Issuer.rwas(rwa.currencyKeyInBytes);
		const currentRwaAddress = addressOf(rwa.rwa);
		if (issuerRwaAddress === currentRwaAddress) {
			console.log(gray(`${currentRwaAddress} requires no action`));
		} else if (!seen.has(rwa.currencyKeyInBytes)) {
			console.log(gray(`${currentRwaAddress} will be added to the issuer.`));
			filteredRwas.push(rwa);
		}
		seen.add(rwa.currencyKeyInBytes);
	}

	const rwaChunkSize = 15;
	let batchCounter = 1;
	for (let i = 0; i < filteredRwas.length; i += rwaChunkSize) {
		const chunk = filteredRwas.slice(i, i + rwaChunkSize);
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'getRwas',
			readArg: [chunk.map(rwa => rwa.currencyKeyInBytes)],
			expected: input =>
				input.length === chunk.length &&
				input.every((cur, idx) => cur === addressOf(chunk[idx].rwa)),
			write: 'addRwas',
			writeArg: [chunk.map(rwa => addressOf(rwa.rwa))],
			gasLimit: 1e5 * rwaChunkSize,
			comment: `Add rwas to the Issuer contract - batch ${batchCounter++}`,
		});
	}
};
