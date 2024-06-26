'use strict';

const { gray } = require('chalk');

module.exports = async ({ account, addressOf, deployer }) => {
	console.log(gray(`\n------ DEPLOY DAPP UTILITIES ------\n`));

	const { ReadProxyAddressResolver } = deployer.deployedContracts;

	await deployer.deployContract({
		name: 'RwaUtil',
		deps: ['ReadProxyAddressResolver'],
		args: [addressOf(ReadProxyAddressResolver)],
	});

	await deployer.deployContract({
		name: 'DappMaintenance',
		args: [account],
	});
};
