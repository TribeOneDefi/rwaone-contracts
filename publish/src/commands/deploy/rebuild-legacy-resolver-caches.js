'use strict';

const ethers = require('ethers');
const { gray } = require('chalk');

module.exports = async ({ addressOf, compiled, deployer, network, runStep, useOvm }) => {
	console.log(gray(`\n------ REBUILD LEGACY RESOLVER CACHES ------\n`));

	const { AddressResolver, ReadProxyAddressResolver } = deployer.deployedContracts;

	// Legacy contracts.
	if (network === 'mainnet') {
		console.log(gray('Checking all legacy contracts using isResolverCached() return true'));

		let legacyContracts = {};
		if (!useOvm) {
			// Get legacy contracts for L1.
			legacyContracts = {
				// v2.35.2 contracts, replaced in v2.36.
				// These still hold some funds, so need to ensure they are up to date
				CollateralEth: '0x3FF5c0A14121Ca39211C95f6cEB221b86A90729E',
				CollateralErc20: '0x3B3812BB9f6151bEb6fa10783F1ae848a77a0d46', // REN
				CollateralShort: '0x188C2274B04Ea392B21487b5De299e382Ff84246',

				// Rwas deprecated during Wezen (v2.49)
				// It's necessary to keep these up to date as when someone attempts to redeem one,
				// it will invoke the Issuer which will then attempt to call Rwa.burn. If the
				// Rwa isn't updated to understand the latest Issuer, it will revert the attempted burn
				// Note: the rwas with 0 supply have been removed as this is no longer required
				RwaiAAVE: '0x1cB27Ac646afAE192dF9928A2808C0f7f586Af7d',
				RwaiBNB: '0xf7B8dF8b16dA302d85603B8e7F95111a768458Cc',
				RwaiBTC: '0x8350d1b2d6EF5289179fe49E5b0F208165B4e32e',
				RwaiCEX: '0x6Dc6a64724399524184C2c44a526A2cff1BaA507',
				RwaiDASH: '0x947d5656725fB9A8f9c826A91b6082b07E2745B7',
				RwaiDEFI: '0x87eb6e935e3C7E3E3A0E31a5658498bC87dE646E',
				RwaiDOT: '0xF6ce55E09De0F9F97210aAf6DB88Ed6b6792Ca1f',
				RwaiEOS: '0x806A599d60B2FdBda379D5890287D2fba1026cC0',
				RwaiETH: '0x29DD4A59F4D339226867e77aF211724eaBb45c02',
				RwaiOIL: '0x53869BDa4b8d85aEDCC9C6cAcf015AF9447Cade7',
				RwaiXRP: '0x19cC1f63e344D74A87D955E3F3E95B28DDDc61d8',
				Rwas1INCH: '0x0E8Fa2339314AB7E164818F26207897bBe29C3af',
				RwasAAPL: '0x815CeF3b7773f35428B4353073B086ecB658f73C',
				RwasAMZN: '0x9530FA32a3059114AC20A5812870Da12D97d1174',
				RwasBNB: '0xda3c83750b1FA31Fda838136ef3f853b41cb7a5a',
				RwasCEX: '0x2acfe6265D358d982cB1c3B521199973CD443C71',
				RwasCOIN: '0x249612F641111022f2f48769f3Df5D85cb3E26a2',
				RwasCOMP: '0x34c76BC146b759E58886e821D62548AC1e0BA7Bc',
				RwasCRV: '0x13D0F5B8630520eA04f694F17A001fb95eaFD30E',
				RwasDASH: '0xcb6Cb218D558ae7fF6415f95BDA6616FCFF669Cb',
				RwasEOS: '0xAf090d6E583C082f2011908cf95c2518BE7A53ac',
				RwasETC: '0x21ee4afBd6c151fD9A69c1389598170B1d45E0e3',
				RwasFB: '0xb0e0BA880775B7F2ba813b3800b3979d719F0379',
				RwasFTSE: '0x3E2dA260B4A85782A629320EB027A3B7c28eA9f1',
				RwasGOOG: '0x8e082925e78538955bC0e2F363FC5d1Ab3be739b',
				RwasLTC: '0xA962208CDC8588F9238fae169d0F63306c353F4F',
				RwasMSFT: '0x04720DbBD4599aD26811545595d97fB813E84964',
				RwasNFLX: '0x399BA516a6d68d6Ad4D5f3999902D0DeAcaACDdd',
				RwasNIKKEI: '0xc02DD182Ce029E6d7f78F37492DFd39E4FEB1f8b',
				RwasOIL: '0x2962EA4E749e54b10CFA557770D597027BA67cB3',
				RwasREN: '0x4287dac1cC7434991119Eba7413189A66fFE65cF',
				RwasRUNE: '0xe615Df79AC987193561f37E77465bEC2aEfe9aDb',
				RwasTRX: '0x47bD14817d7684082E04934878EE2Dd3576Ae19d',
				RwasTSLA: '0x0d1c4e5C07B071aa4E6A14A604D4F6478cAAC7B4',
				RwasUNI: '0xAa1b12E3e5F70aBCcd1714F4260A74ca21e7B17b',
				RwasXAG: '0x9745606DA6e162866DAD7bF80f2AbF145EDD7571',
				RwasXAU: '0x5eDf7dd83fE2889D264fa9D3b93d0a6e6A45D6C6',
				RwasXMR: '0x7B29C9e188De18563B19d162374ce6836F31415a',
				RwasXRP: '0xe3D5E1c1bA874C0fF3BA31b999967F24d5ca04e5',
				RwasXTZ: '0x6F927644d55E32318629198081923894FbFe5c07',
				RwasYFI: '0x0F393ce493d8FB0b83915248a21a3104932ed97c',

				// Rwas deprecated during Denebola (v2.73)
				RwasDEFI: '0x918b1dbf0917FdD74D03fB9434915E2ECEc89286',

				// Rwas deprecated during Sadr (v2.81)
				RwasAAVE: '0x942Eb6e8c029EB22103743C99985aF4F4515a559',
				RwasLINK: '0xDF69bC4541b86Aa4c5A470B4347E730c38b2c3B2',
				RwasDOT: '0x75A0c1597137AA36B40b6a515D997F9a6c6eefEB',
				RwasADA: '0x91b82d62Ff322b8e02b86f33E9A99a813437830d',
			};
		} else if (useOvm) {
			// Get legacy contracts for L2.
			legacyContracts = {
				// Sargas v2.50 CollateralShort contract, replaced in Kochab v2.71.
				// This still holds some funds, so ensure its cache is up to date.
				CollateralShortLegacy: '0xEbCe9728E2fDdC26C9f4B00df5180BdC5e184953',

				// Rwas deprecated during Sadr (v2.81)
				RwasAAVE: '0x34783A738DdC355cD7c737D4101b20622681332a',
				RwasLINK: '0x0F6877e0Bb54a0739C6173A814B39D5127804123',
				RwasMATIC: '0xf49C194954b6B91855aC06D6C88Be316da60eD96',
				RwasUNI: '0xcF2E165D2359E3C4dFF1E10eC40dBB5a745223A9',
				RwasAVAX: '0x368A5126fF8e659004b6f9C9F723E15632e2B428',
				RwasSOL: '0x04B50a5992Ea2281E14d43494d656698EA9C24dD',
			};
		}

		const legacyContractsToRebuildCache = [];
		// determine which need resolver caching
		for (const [name, address] of Object.entries(legacyContracts)) {
			const { abi } = compiled['MixinResolver'];

			const target = new ethers.Contract(address, abi, deployer.provider);

			const response = await target.isResolverCached();

			if (!response) {
				console.log(gray(name, 'is legacy and requires caching', address));
				legacyContractsToRebuildCache.push(address);
			}
		}

		const addressesChunkSize = 20;
		let batchCounter = 1;
		for (let i = 0; i < legacyContractsToRebuildCache.length; i += addressesChunkSize) {
			const chunk = legacyContractsToRebuildCache.slice(i, i + addressesChunkSize);
			await runStep({
				gasLimit: 7e6,
				contract: `AddressResolver`,
				target: AddressResolver,
				publiclyCallable: true, // does not require owner
				write: 'rebuildCaches',
				writeArg: [chunk],
				comment: `Rebuild the resolver caches of legacy contracts - batch ${batchCounter++}`,
				// these updates are tricky to Soliditize, and aren't
				// owner required and aren't critical to the core, so
				// let's skip them in the migration script
				// and a re-run of the deploy script will catch them
				skipSolidity: true,
			});
		}
	}

	const filterTargetsWith = ({ prop }) =>
		Object.entries(deployer.deployedContracts).filter(([, target]) => {
			return target.functions[prop] !== undefined;
		});

	// Now perform a sync of legacy contracts that have not been replaced in Shaula (v2.35.x)
	// EtherCollateral, EtherCollateralrUSD
	console.log(gray('Checking all legacy contracts with setResolverAndSyncCache() are rebuilt...'));
	const contractsWithLegacyResolverCaching = filterTargetsWith({
		prop: 'setResolverAndSyncCache',
	});
	for (const [contract, target] of contractsWithLegacyResolverCaching) {
		await runStep({
			gasLimit: 500e3, // higher gas required
			contract,
			target,
			read: 'isResolverCached',
			readArg: addressOf(ReadProxyAddressResolver),
			expected: input => input,
			write: 'setResolverAndSyncCache',
			writeArg: addressOf(ReadProxyAddressResolver),
			comment:
				'Rebuild the resolver cache of contracts that use the legacy "setResolverAndSyncCache" function',
		});
	}

	// Finally set resolver on contracts even older than legacy (Depot)
	console.log(gray('Checking all legacy contracts with setResolver() are rebuilt...'));
	const contractsWithLegacyResolverNoCache = filterTargetsWith({
		prop: 'setResolver',
	});
	for (const [contract, target] of contractsWithLegacyResolverNoCache) {
		await runStep({
			gasLimit: 500e3, // higher gas required
			contract,
			target,
			read: 'resolver',
			expected: input => addressOf(ReadProxyAddressResolver),
			write: 'setResolver',
			writeArg: addressOf(ReadProxyAddressResolver),
			comment: 'Rebuild the resolver cache of contracts that use the legacy "setResolver" function',
		});
	}

	console.log(gray('All legacy caches are rebuilt. '));
};
