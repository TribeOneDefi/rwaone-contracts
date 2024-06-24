'use strict';

const { artifacts, web3, log, ethers } = require('hardhat');

const { toWei, toBN } = web3.utils;
const { toUnit } = require('../utils')();
const { setupPriceAggregators, updateAggregatorRates } = require('./helpers');

const {
	toBytes32,
	fromBytes32,
	getUsers,
	constants: { ZERO_ADDRESS },
	defaults: {
		WAITING_PERIOD_SECS,
		PRICE_DEVIATION_THRESHOLD_FACTOR,
		ISSUANCE_RATIO,
		FEE_PERIOD_DURATION,
		TARGET_THRESHOLD,
		LIQUIDATION_DELAY,
		LIQUIDATION_RATIO,
		LIQUIDATION_ESCROW_DURATION,
		LIQUIDATION_PENALTY,
		RWAX_LIQUIDATION_PENALTY,
		SELF_LIQUIDATION_PENALTY,
		FLAG_REWARD,
		LIQUIDATE_REWARD,
		RATE_STALE_PERIOD,
		// EXCHANGE_DYNAMIC_FEE_THRESHOLD, // overridden
		// EXCHANGE_DYNAMIC_FEE_WEIGHT_DECAY, // overridden
		// EXCHANGE_DYNAMIC_FEE_ROUNDS, // overridden
		// EXCHANGE_MAX_DYNAMIC_FEE, // overridden
		MINIMUM_STAKE_TIME,
		DEBT_SNAPSHOT_STALE_TIME,
		ATOMIC_MAX_VOLUME_PER_BLOCK,
		ATOMIC_TWAP_WINDOW,
		CROSS_DOMAIN_DEPOSIT_GAS_LIMIT,
		CROSS_DOMAIN_REWARD_GAS_LIMIT,
		CROSS_DOMAIN_ESCROW_GAS_LIMIT,
		CROSS_DOMAIN_WITHDRAWAL_GAS_LIMIT,
		ETHER_WRAPPER_MAX_ETH,
		ETHER_WRAPPER_MINT_FEE_RATE,
		ETHER_WRAPPER_BURN_FEE_RATE,
		// FUTURES_MIN_KEEPER_FEE, // overridden
		FUTURES_LIQUIDATION_FEE_RATIO,
		FUTURES_LIQUIDATION_BUFFER_RATIO,
		FUTURES_MIN_INITIAL_MARGIN,
		PERPSV2_KEEPER_LIQUIDATION_FEE,
	},
} = require('../../');

const SUPPLY_100M = toWei((1e8).toString()); // 100M

// constants overrides for testing (to avoid having to update tests for config changes)
const constantsOverrides = {
	EXCHANGE_DYNAMIC_FEE_ROUNDS: '10',
	EXCHANGE_DYNAMIC_FEE_WEIGHT_DECAY: toWei('0.95'),
	EXCHANGE_DYNAMIC_FEE_THRESHOLD: toWei('0.004'),
	EXCHANGE_MAX_DYNAMIC_FEE: toWei('0.05'),
	FUTURES_MIN_KEEPER_FEE: toWei('20'),
	FUTURES_MAX_KEEPER_FEE: toWei('1000'),
};

/**
 * Create a mock ExternStateToken - useful to mock Rwaone or a tribe
 */
const mockToken = async ({
	accounts,
	tribe = undefined,
	name = 'name',
	symbol = 'ABC',
	supply = 1e8,
	skipInitialAllocation = false,
}) => {
	const [deployerAccount, owner] = accounts;

	const totalSupply = toWei(supply.toString());

	const proxy = await artifacts.require('ProxyERC20').new(owner, { from: deployerAccount });
	// set associated contract as deployerAccount so we can setBalanceOf to the owner below
	const tokenState = await artifacts
		.require('TokenState')
		.new(owner, deployerAccount, { from: deployerAccount });

	if (!skipInitialAllocation && supply > 0) {
		await tokenState.setBalanceOf(owner, totalSupply, { from: deployerAccount });
	}

	const token = await artifacts.require(tribe ? 'MockTribe' : 'PublicEST').new(
		...[proxy.address, tokenState.address, name, symbol, totalSupply, owner]
			// add tribe as currency key if needed
			.concat(tribe ? toBytes32(tribe) : [])
			.concat({
				from: deployerAccount,
			})
	);
	await Promise.all([
		tokenState.setAssociatedContract(token.address, { from: owner }),
		proxy.setTarget(token.address, { from: owner }),
	]);

	return { token, tokenState, proxy };
};

const mockGenericContractFnc = async ({ instance, fncName, mock, returns = [] }) => {
	// Adapted from: https://github.com/EthWorks/Doppelganger/blob/master/lib/index.ts
	const abiEntryForFnc = artifacts.require(mock).abi.find(({ name }) => name === fncName);

	if (!fncName || !abiEntryForFnc) {
		throw new Error(`Cannot find function "${fncName}" in the ABI of contract "${mock}"`);
	}
	const signature = web3.eth.abi.encodeFunctionSignature(abiEntryForFnc);

	const outputTypes = abiEntryForFnc.outputs.map(({ type }) => type);

	const responseAsEncodedData = web3.eth.abi.encodeParameters(outputTypes, returns);

	if (process.env.DEBUG) {
		log(`Mocking ${mock}.${fncName} to return ${returns.join(',')}`);
	}

	await instance.mockReturns(signature, responseAsEncodedData);
};

// Perps V2 Proxy
const excludedFunctions = [
	// Owned
	'nominateNewOwner',
	'acceptOwnership',
	'nominatedOwner',
	'owner',
	// MixinResolver
	'resolver',
	'resolverAddressesRequired',
	'rebuildCache',
	'isResolverCached',
	// ProxyPerpsV2
	'addRoute',
	'removeRoute',
	'getRoutesPage',
	'getRoutesLength',
	'getRoutesPage',
	'getAllTargets',
	// Proxyable
	'messageSender',
	'setMessageSender',
	'proxy',
	'setProxy',
	// PerpsV2MarketBase
	'marketState',
];
const excludedTestableFunctions = [
	// Delayed orders
	'submitDelayedOrder',
	'submitDelayedOrderWithTracking',
	'cancelDelayedOrder',
	'executeDelayedOrder',
	// Off-chain delayed orders
	'submitOffchainDelayedOrder',
	'submitOffchainDelayedOrderWithTracking',
	'cancelOffchainDelayedOrder',
	'executeOffchainDelayedOrder',
	// Market views
	'marketKey',
	'baseAsset',
	'marketSize',
	'marketSkew',
	'fundingLastRecomputed',
	'fundingSequence',
	'positions',
	'assetPrice',
	'marketSizes',
	'marketDebt',
	'currentFundingRate',
	'currentFundingVelocity',
	'unrecordedFunding',
	'fundingSequenceLength',
	'notionalValue',
	'profitLoss',
	'accruedFunding',
	'remainingMargin',
	'accessibleMargin',
	'liquidationPrice',
	'liquidationFee',
	'canLiquidate',
	'orderFee',
	'postTradeDetails',
];

const getFunctionSignatures = (instance, excludedFunctions) => {
	const contractInterface = new ethers.utils.Interface(instance.abi);
	const signatures = [];
	const funcNames = Object.keys(contractInterface.functions);
	for (const funcName of funcNames) {
		const signature = {
			signature: contractInterface.getSighash(contractInterface.functions[funcName]),
			functionName: contractInterface.functions[funcName].name,
			stateMutability: contractInterface.functions[funcName].stateMutability,
			isView: contractInterface.functions[funcName].stateMutability === 'view',
		};
		signatures.push(signature);
	}
	return signatures.filter(f => !excludedFunctions.includes(f.functionName));
};

/**
 * Setup an individual contract. Note: will fail if required dependencies aren't provided in the cache.
 */
const setupContract = async ({
	accounts,
	contract,
	source = undefined, // if a separate source file should be used
	mock = undefined, // if contract is GenericMock, this is the name of the contract being mocked
	forContract = undefined, // when a contract is deployed for another (like Proxy for FeePool)
	cache = {},
	args = [],
	skipPostDeploy = false,
	properties = {},
}) => {
	const [deployerAccount, owner, , fundsWallet] = accounts;

	const artifact = artifacts.require(source || contract);

	const create = ({ constructorArgs }) => {
		return artifact.new(
			...constructorArgs.concat({
				from: deployerAccount,
			})
		);
	};

	// if it needs library linking
	if (Object.keys((await artifacts.readArtifact(source || contract)).linkReferences).length > 0) {
		const safeDecimalMath = await artifacts.require('SafeDecimalMath').new();

		if (
			artifact._json.contractName === 'Exchanger' ||
			artifact._json.contractName === 'ExchangerWithFeeRecAlternatives'
		) {
			// SafeDecimalMath -> ExchangeSettlementLib -> Exchanger*
			const ExchangeSettlementLib = artifacts.require('ExchangeSettlementLib');
			ExchangeSettlementLib.link(safeDecimalMath);
			artifact.link(await ExchangeSettlementLib.new());
			artifact.link(await safeDecimalMath);
		} else if (artifact._json.contractName === 'SystemSettings') {
			// SafeDecimalMath -> SystemSettingsLib -> SystemSettings
			const SystemSettingsLib = artifacts.require('SystemSettingsLib');
			SystemSettingsLib.link(safeDecimalMath);
			artifact.link(await SystemSettingsLib.new());
		} else {
			// SafeDecimalMath -> anything else that expects linking
			artifact.link(safeDecimalMath);
		}
	}

	const tryGetAddressOf = name => (cache[name] ? cache[name].address : ZERO_ADDRESS);

	const tryGetProperty = ({ property, otherwise }) =>
		property in properties ? properties[property] : otherwise;

	const tryInvocationIfNotMocked = ({ name, fncName, args, user = owner }) => {
		if (name in cache && fncName in cache[name]) {
			if (process.env.DEBUG) {
				log(`Invoking ${name}.${fncName}(${args.join(',')})`);
			}

			return cache[name][fncName](...args.concat({ from: user }));
		}
	};

	const perpSuffix = tryGetProperty({ property: 'perpSuffix', otherwise: '' });

	const defaultArgs = {
		GenericMock: [],
		TradingRewards: [owner, owner, tryGetAddressOf('AddressResolver')],
		AddressResolver: [owner],
		OneNetAggregatorIssuedTribes: [tryGetAddressOf('AddressResolver')],
		OneNetAggregatorDebtRatio: [tryGetAddressOf('AddressResolver')],
		SystemStatus: [owner],
		FlexibleStorage: [tryGetAddressOf('AddressResolver')],
		ExchangeRates: [owner, tryGetAddressOf('AddressResolver')],
		ExchangeRatesWithDexPricing: [owner, tryGetAddressOf('AddressResolver')],
		RwaoneState: [owner, ZERO_ADDRESS],
		SupplySchedule: [owner, 0, 0],
		Proxy: [owner],
		ProxyERC20: [owner],
		ProxyRwaone: [owner],
		Depot: [owner, fundsWallet, tryGetAddressOf('AddressResolver')],
		TribeUtil: [tryGetAddressOf('AddressResolver')],
		DappMaintenance: [owner],
		DebtCache: [owner, tryGetAddressOf('AddressResolver')],
		Issuer: [owner, tryGetAddressOf('AddressResolver')],
		Exchanger: [owner, tryGetAddressOf('AddressResolver')],
		CircuitBreaker: [owner, tryGetAddressOf('AddressResolver')],
		ExchangeCircuitBreaker: [owner, tryGetAddressOf('AddressResolver')],
		ExchangerWithFeeRecAlternatives: [owner, tryGetAddressOf('AddressResolver')],
		SystemSettings: [owner, tryGetAddressOf('AddressResolver')],
		DirectIntegrationManager: [owner, tryGetAddressOf('AddressResolver')],
		ExchangeState: [owner, tryGetAddressOf('Exchanger')],
		RwaoneDebtShare: [owner, tryGetAddressOf('AddressResolver')],
		BaseRwaone: [
			tryGetAddressOf('ProxyERC20BaseRwaone'),
			tryGetAddressOf('TokenStateBaseRwaone'),
			owner,
			SUPPLY_100M,
			tryGetAddressOf('AddressResolver'),
		],
		Rwaone: [
			tryGetAddressOf('ProxyERC20Rwaone'),
			tryGetAddressOf('TokenStateRwaone'),
			owner,
			SUPPLY_100M,
			tryGetAddressOf('AddressResolver'),
		],
		MintableRwaone: [
			tryGetAddressOf('ProxyERC20MintableRwaone'),
			tryGetAddressOf('TokenStateMintableRwaone'),
			owner,
			SUPPLY_100M,
			tryGetAddressOf('AddressResolver'),
		],
		RwaoneBridgeToOptimism: [owner, tryGetAddressOf('AddressResolver')],
		RwaoneBridgeToBase: [owner, tryGetAddressOf('AddressResolver')],
		RwaoneBridgeEscrow: [owner],
		RewardsDistribution: [
			owner,
			tryGetAddressOf('Rwaone'),
			tryGetAddressOf('ProxyERC20Rwaone'),
			tryGetAddressOf('RewardEscrowV2'),
			tryGetAddressOf('ProxyFeePool'),
		],
		RewardEscrow: [owner, tryGetAddressOf('Rwaone'), tryGetAddressOf('FeePool')],
		BaseRewardEscrowV2Frozen: [owner, tryGetAddressOf('AddressResolver')],
		RewardEscrowV2Frozen: [owner, tryGetAddressOf('AddressResolver')],
		RewardEscrowV2Storage: [owner, ZERO_ADDRESS],
		BaseRewardEscrowV2: [owner, tryGetAddressOf('AddressResolver')],
		RewardEscrowV2: [owner, tryGetAddressOf('AddressResolver')],
		ImportableRewardEscrowV2: [owner, tryGetAddressOf('AddressResolver')],
		RwaoneEscrow: [owner, tryGetAddressOf('Rwaone')],
		// use deployerAccount as associated contract to allow it to call setBalanceOf()
		TokenState: [owner, deployerAccount],
		EtherWrapper: [owner, tryGetAddressOf('AddressResolver'), tryGetAddressOf('WETH')],
		NativeEtherWrapper: [owner, tryGetAddressOf('AddressResolver')],
		WrapperFactory: [owner, tryGetAddressOf('AddressResolver')],
		FeePool: [tryGetAddressOf('ProxyFeePool'), owner, tryGetAddressOf('AddressResolver')],
		Tribe: [
			tryGetAddressOf('ProxyERC20Tribe'),
			tryGetAddressOf('TokenStateTribe'),
			tryGetProperty({ property: 'name', otherwise: 'RwaOne rUSD' }),
			tryGetProperty({ property: 'symbol', otherwise: 'rUSD' }),
			owner,
			tryGetProperty({ property: 'currencyKey', otherwise: toBytes32('rUSD') }),
			tryGetProperty({ property: 'totalSupply', otherwise: '0' }),
			tryGetAddressOf('AddressResolver'),
		],
		EternalStorage: [owner, tryGetAddressOf(forContract)],
		FeePoolEternalStorage: [owner, tryGetAddressOf('FeePool')],
		DelegateApprovals: [owner, tryGetAddressOf('EternalStorageDelegateApprovals')],
		Liquidator: [owner, tryGetAddressOf('AddressResolver')],
		LiquidatorRewards: [owner, tryGetAddressOf('AddressResolver')],
		DebtMigratorOnEthereum: [owner, tryGetAddressOf('AddressResolver')],
		DebtMigratorOnOptimism: [owner, tryGetAddressOf('AddressResolver')],
		CollateralManagerState: [owner, tryGetAddressOf('CollateralManager')],
		CollateralManager: [
			tryGetAddressOf('CollateralManagerState'),
			owner,
			tryGetAddressOf('AddressResolver'),
			toUnit(50000000),
			0,
			0,
			0,
		],
		CollateralUtil: [tryGetAddressOf('AddressResolver')],
		Collateral: [
			owner,
			tryGetAddressOf('CollateralManager'),
			tryGetAddressOf('AddressResolver'),
			toBytes32('rUSD'),
			toUnit(1.3),
			toUnit(100),
		],
		CollateralEth: [
			owner,
			tryGetAddressOf('CollateralManager'),
			tryGetAddressOf('AddressResolver'),
			toBytes32('rETH'),
			toUnit(1.3),
			toUnit(2),
		],
		CollateralShort: [
			owner,
			tryGetAddressOf('CollateralManager'),
			tryGetAddressOf('AddressResolver'),
			toBytes32('rUSD'),
			toUnit(1.2),
			toUnit(100),
		],
		WETH: [],
		TribeRedeemer: [tryGetAddressOf('AddressResolver')],
		FuturesMarketManager: [owner, tryGetAddressOf('AddressResolver')],
		FuturesMarketSettings: [owner, tryGetAddressOf('AddressResolver')],
		FuturesMarketBTC: [
			tryGetAddressOf('AddressResolver'),
			toBytes32('hBTC'), // base asset
			toBytes32('hBTC' + perpSuffix), // market key
		],
		FuturesMarketETH: [
			tryGetAddressOf('AddressResolver'),
			toBytes32('rETH'), // base asset
			toBytes32('rETH' + perpSuffix), // market key
		],
		FuturesMarketData: [tryGetAddressOf('AddressResolver')],
		// Perps V2
		MockPyth: [60, 1],
		PerpsV2ExchangeRate: [owner, tryGetAddressOf('AddressResolver')],
		PerpsV2MarketSettings: [owner, tryGetAddressOf('AddressResolver')],
		PerpsV2MarketData: [tryGetAddressOf('AddressResolver')],
		PerpsV2MarketStateBTC: [
			owner,
			[deployerAccount],
			toBytes32('hBTC'), // base asset
			toBytes32('hBTC' + perpSuffix), // market key
			ethers.constants.AddressZero,
		],
		PerpsV2MarketStateETH: [
			owner,
			[deployerAccount],
			toBytes32('rETH'), // base asset
			toBytes32('rETH' + perpSuffix), // market key
			ethers.constants.AddressZero,
		],
		ProxyPerpsV2MarketBTC: [owner],
		ProxyPerpsV2MarketETH: [owner],
		PerpsV2MarketViewhBTC: [
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketViewrETH: [
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],

		PerpsV2MarketDelayedIntentBTC: [
			tryGetAddressOf('ProxyPerpsV2MarketBTC'),
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketDelayedExecutionBTC: [
			tryGetAddressOf('ProxyPerpsV2MarketBTC'),
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketLiquidateBTC: [
			tryGetAddressOf('ProxyPerpsV2MarketBTC'),
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketBTC: [
			tryGetAddressOf('ProxyPerpsV2MarketBTC'),
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		TestablePerpsV2MarketBTC: [
			tryGetAddressOf('ProxyPerpsV2MarketBTC'),
			tryGetAddressOf('PerpsV2MarketStateBTC'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],

		PerpsV2MarketDelayedIntentETH: [
			tryGetAddressOf('ProxyPerpsV2MarketETH'),
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketDelayedExecutionETH: [
			tryGetAddressOf('ProxyPerpsV2MarketETH'),
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketLiquidateETH: [
			tryGetAddressOf('ProxyPerpsV2MarketETH'),
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		PerpsV2MarketETH: [
			tryGetAddressOf('ProxyPerpsV2MarketETH'),
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
		TestablePerpsV2MarketETH: [
			tryGetAddressOf('ProxyPerpsV2MarketETH'),
			tryGetAddressOf('PerpsV2MarketStateETH'),
			owner,
			tryGetAddressOf('AddressResolver'),
		],
	};

	let instance;
	try {
		instance = await create({
			constructorArgs: args.length > 0 ? args : defaultArgs[contract],
		});
		// Show contracts creating for debugging purposes
		if (process.env.DEBUG) {
			log(
				'Deployed',
				contract + (source ? ` (${source})` : '') + (forContract ? ' for ' + forContract : ''),
				mock ? 'mock of ' + mock : '',
				'to',
				instance.address
			);
			if (contract.startsWith('PerpsV2Market') || contract.startsWith('ProxyPerpsV2Market')) {
				log('Deployed with default args:', defaultArgs[contract], 'and args:', args);
			}
		}
	} catch (err) {
		throw new Error(
			`Failed to deploy ${contract}. Does it have defaultArgs setup?\n\t└─> Caused by ${err.toString()}`
		);
	}

	const postDeployTasks = {
		async Rwaone() {
			// first give all wRWAX supply to the owner (using the hack that the deployerAccount was setup as the associatedContract via
			// the constructor args)
			await cache['TokenStateRwaone'].setBalanceOf(owner, SUPPLY_100M, {
				from: deployerAccount,
			});

			// then configure everything else (including setting the associated contract of TokenState back to the Rwaone contract)
			await Promise.all(
				[
					(cache['TokenStateRwaone'].setAssociatedContract(instance.address, { from: owner }),
						cache['ProxyRwaone'].setTarget(instance.address, { from: owner }),
						cache['ProxyERC20Rwaone'].setTarget(instance.address, { from: owner }),
						instance.setProxy(cache['ProxyERC20Rwaone'].address, {
							from: owner,
						})),
				]
					.concat(
						// If there's a SupplySchedule and it has the method we need (i.e. isn't a mock)
						tryInvocationIfNotMocked({
							name: 'SupplySchedule',
							fncName: 'setRwaoneProxy',
							args: [cache['ProxyERC20Rwaone'].address],
						}) || []
					)
					.concat(
						// If there's an escrow that's not a mock
						tryInvocationIfNotMocked({
							name: 'RwaoneEscrow',
							fncName: 'setRwaone',
							args: [instance.address],
						}) || []
					)
					.concat(
						// If there's a reward escrow that's not a mock
						tryInvocationIfNotMocked({
							name: 'RewardEscrow',
							fncName: 'setRwaone',
							args: [instance.address],
						}) || []
					)
					.concat(
						// If there's a rewards distribution that's not a mock
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setAuthority',
							args: [instance.address],
						}) || []
					)
					.concat(
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setRwaoneProxy',
							args: [cache['ProxyERC20Rwaone'].address], // will fail if no Proxy instantiated for Rwaone
						}) || []
					)
			);
		},
		async BaseRwaone() {
			// first give all wRWAX supply to the owner (using the hack that the deployerAccount was setup as the associatedContract via
			// the constructor args)
			await cache['TokenStateBaseRwaone'].setBalanceOf(owner, SUPPLY_100M, {
				from: deployerAccount,
			});

			// then configure everything else (including setting the associated contract of TokenState back to the Rwaone contract)
			await Promise.all(
				[
					(cache['TokenStateBaseRwaone'].setAssociatedContract(instance.address, {
						from: owner,
					}),
						cache['ProxyBaseRwaone'].setTarget(instance.address, { from: owner }),
						cache['ProxyERC20BaseRwaone'].setTarget(instance.address, { from: owner }),
						instance.setProxy(cache['ProxyERC20BaseRwaone'].address, {
							from: owner,
						})),
				]
					.concat(
						// If there's a rewards distribution that's not a mock
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setAuthority',
							args: [instance.address],
						}) || []
					)
					.concat(
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setRwaoneProxy',
							args: [cache['ProxyERC20BaseRwaone'].address], // will fail if no Proxy instantiated for BaseRwaone
						}) || []
					)
			);
		},
		async MintableRwaone() {
			// first give all wRWAX supply to the owner (using the hack that the deployerAccount was setup as the associatedContract via
			// the constructor args)
			await cache['TokenStateMintableRwaone'].setBalanceOf(owner, SUPPLY_100M, {
				from: deployerAccount,
			});

			// then configure everything else (including setting the associated contract of TokenState back to the Rwaone contract)
			await Promise.all(
				[
					(cache['TokenStateMintableRwaone'].setAssociatedContract(instance.address, {
						from: owner,
					}),
						cache['ProxyMintableRwaone'].setTarget(instance.address, { from: owner }),
						cache['ProxyERC20MintableRwaone'].setTarget(instance.address, { from: owner }),
						instance.setProxy(cache['ProxyERC20MintableRwaone'].address, {
							from: owner,
						})),
				]
					.concat(
						// If there's a rewards distribution that's not a mock
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setAuthority',
							args: [instance.address],
						}) || []
					)
					.concat(
						tryInvocationIfNotMocked({
							name: 'RewardsDistribution',
							fncName: 'setRwaoneProxy',
							args: [cache['ProxyERC20MintableRwaone'].address], // will fail if no Proxy instantiated for MintableRwaone
						}) || []
					)
			);
		},
		async Tribe() {
			await Promise.all(
				[
					cache['TokenStateTribe'].setAssociatedContract(instance.address, { from: owner }),
					cache['ProxyERC20Tribe'].setTarget(instance.address, { from: owner }),
				] || []
			);
		},
		async FeePool() {
			await Promise.all(
				[]
					.concat(
						tryInvocationIfNotMocked({
							name: 'ProxyFeePool',
							fncName: 'setTarget',
							args: [instance.address],
						}) || []
					)
					.concat(
						tryInvocationIfNotMocked({
							name: 'FeePoolEternalStorage',
							fncName: 'setAssociatedContract',
							args: [instance.address],
						}) || []
					)
					.concat(
						tryInvocationIfNotMocked({
							name: 'RewardEscrow',
							fncName: 'setFeePool',
							args: [instance.address],
						}) || []
					)
			);
		},
		async Issuer() {
			await Promise.all([
				cache['SystemStatus'].updateAccessControl(
					toBytes32('Issuance'),
					instance.address,
					true,
					false,
					{ from: owner }
				),
			]);
		},
		async DelegateApprovals() {
			await cache['EternalStorageDelegateApprovals'].setAssociatedContract(instance.address, {
				from: owner,
			});
		},
		async Exchanger() {
			await Promise.all([
				cache['ExchangeState'].setAssociatedContract(instance.address, { from: owner }),
			]);
		},
		async ExchangeCircuitBreaker() {
			await Promise.all([
				cache['SystemStatus'].updateAccessControl(
					toBytes32('Tribe'),
					instance.address,
					true,
					false,
					{ from: owner }
				),
			]);
		},
		async ExchangerWithFeeRecAlternatives() {
			await Promise.all([
				cache['ExchangeState'].setAssociatedContract(instance.address, { from: owner }),

				cache['SystemStatus'].updateAccessControl(
					toBytes32('Tribe'),
					instance.address,
					true,
					false,
					{ from: owner }
				),
			]);
		},

		async CollateralManager() {
			await cache['CollateralManagerState'].setAssociatedContract(instance.address, {
				from: owner,
			});
		},

		async RewardEscrowV2() {
			await Promise.all([
				cache['RewardEscrowV2Storage'].setAssociatedContract(instance.address, { from: owner }),
				cache['RewardEscrowV2Storage'].setFallbackRewardEscrow(
					cache['RewardEscrowV2Frozen'].address,
					{ from: owner }
				),
			]);
		},

		async ImportableRewardEscrowV2() {
			await Promise.all([
				cache['RewardEscrowV2Storage'].setAssociatedContract(instance.address, { from: owner }),
				cache['RewardEscrowV2Storage'].setFallbackRewardEscrow(
					cache['RewardEscrowV2Frozen'].address,
					{ from: owner }
				),
			]);
		},

		async SystemStatus() {
			// ensure the owner has suspend/resume control over everything
			await instance.updateAccessControls(
				['System', 'Issuance', 'Exchange', 'TribeExchange', 'Tribe', 'Futures'].map(toBytes32),
				[owner, owner, owner, owner, owner, owner],
				[true, true, true, true, true, true],
				[true, true, true, true, true, true],
				{ from: owner }
			);
		},
		async FuturesMarketBTC() {
			await Promise.all([
				cache['FuturesMarketManager'].addMarkets([instance.address], { from: owner }),
			]);
		},
		async FuturesMarketETH() {
			await Promise.all([
				cache['FuturesMarketManager'].addMarkets([instance.address], { from: owner }),
			]);
		},
		async PerpsV2MarketViewhBTC() {
			const filteredFunctions = getFunctionSignatures(instance, excludedFunctions);

			await Promise.all(
				filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				)
			);
		},
		async PerpsV2MarketViewrETH() {
			const filteredFunctions = getFunctionSignatures(instance, excludedFunctions);

			await Promise.all(
				filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketETH'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				)
			);
		},

		async PerpsV2MarketDelayedIntentBTC() {
			const filteredFunctions = getFunctionSignatures(instance, excludedFunctions);

			await Promise.all([
				cache['PerpsV2MarketStateBTC'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateBTC'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketBTC'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
			]);
		},
		async PerpsV2MarketDelayedExecutionBTC() {
			const filteredFunctions = getFunctionSignatures(instance, excludedFunctions);

			await Promise.all([
				cache['PerpsV2MarketStateBTC'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateBTC'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketBTC'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
			]);
		},
		async PerpsV2MarketLiquidateBTC() {
			const filteredFunctions = getFunctionSignatures(instance, [
				...excludedTestableFunctions,
				...excludedFunctions.filter(e => e !== 'marketState'),
			]);

			await Promise.all([
				cache['PerpsV2MarketStateBTC'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateBTC'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketBTC'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
			]);
		},
		async PerpsV2MarketBTC() {
			const filteredFunctions = getFunctionSignatures(instance, [
				...excludedTestableFunctions,
				...excludedFunctions.filter(e => e !== 'marketState'),
			]);

			await Promise.all([
				cache['PerpsV2MarketStateBTC'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateBTC'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketBTC'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
				cache['FuturesMarketManager'].addProxiedMarkets([cache['ProxyPerpsV2MarketBTC'].address], {
					from: owner,
				}),
			]);
		},
		async PerpsV2MarketLiquidateETH() {
			const filteredFunctions = getFunctionSignatures(instance, [
				...excludedTestableFunctions,
				...excludedFunctions.filter(e => e !== 'marketState'),
			]);

			await Promise.all([
				cache['PerpsV2MarketStateETH'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateETH'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketETH'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketETH'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
			]);
		},

		async PerpsV2MarketStateETH() {
			await Promise.all([instance.linkOrInitializeState({ from: owner })]);
		},
		async PerpsV2MarketStateBTC() {
			await Promise.all([instance.linkOrInitializeState({ from: owner })]);
		},
		async PerpsV2MarketETH() {
			const filteredFunctions = getFunctionSignatures(instance, [
				...excludedTestableFunctions,
				...excludedFunctions.filter(e => e !== 'marketState'),
			]);

			await Promise.all([
				cache['PerpsV2MarketStateETH'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateETH'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketETH'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketETH'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
				cache['FuturesMarketManager'].addProxiedMarkets([cache['ProxyPerpsV2MarketETH'].address], {
					from: owner,
				}),
			]);
		},
		async TestablePerpsV2MarketBTC() {
			const filteredFunctions = getFunctionSignatures(
				{
					abi: [
						'function entryDebtCorrection() external view returns (int)',
						'function proportionalSkew() view returns (int)',
						'function maxOrderSizes() view returns (uint, uint, bool)',
						'function liquidationMargin(address) view returns (uint)',
						'function currentLeverage(address) view returns (int, bool)',
						// 'function maxFundingVelocity() view returns (uint)',
						'function fillPriceWithMeta(int, uint, uint) view returns (uint, uint, bool)',
						'function netFundingPerUnit(address account) external view returns (int)',
					],
				},
				excludedFunctions.filter(e => e !== 'marketState')
			);

			await Promise.all([
				cache['PerpsV2MarketStateBTC'].removeAssociatedContracts([deployerAccount], {
					from: owner,
				}),
				cache['PerpsV2MarketStateBTC'].addAssociatedContracts([instance.address], {
					from: owner,
				}),
				instance.setProxy(cache['ProxyPerpsV2MarketBTC'].address, { from: owner }),
				...filteredFunctions.map(e =>
					cache['ProxyPerpsV2MarketBTC'].addRoute(e.signature, instance.address, e.isView, {
						from: owner,
					})
				),
			]);
		},
		async GenericMock() {
			if (mock === 'RewardEscrow' || mock === 'RwaoneEscrow') {
				await mockGenericContractFnc({ instance, mock, fncName: 'balanceOf', returns: ['0'] });
			} else if (mock === 'EtherWrapper') {
				await mockGenericContractFnc({
					instance,
					mock,
					fncName: 'totalIssuedTribes',
					returns: ['0'],
				});
			} else if (mock === 'WrapperFactory') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'isWrapper',
						returns: [false],
					}),
				]);
			} else if (mock === 'FeePool') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'FEE_ADDRESS',
						returns: [getUsers({ network: 'mainnet', user: 'fee' }).address],
					}),
				]);
			} else if (mock === 'Exchanger') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'feeRateForExchange',
						returns: [toWei('0.0030')],
					}),
				]);
			} else if (mock === 'Issuer') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'debtBalanceOf',
						returns: [toWei('0')],
					}),
				]);
			} else if (mock === 'ExchangeState') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'getLengthOfEntries',
						returns: ['0'],
					}),
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'getMaxTimestamp',
						returns: ['0'],
					}),
				]);
			} else if (mock === 'CollateralManager') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'isTribeManaged',
						returns: [false],
					}),
				]);
			} else if (mock === 'FuturesMarketManager') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'totalDebt',
						returns: ['0', false],
					}),
				]);
			} else if (mock === 'FuturesMarket') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'recomputeFunding',
						returns: ['0'],
					}),
				]);
			} else if (mock === 'PerpsV2Market') {
				await Promise.all([
					mockGenericContractFnc({
						instance,
						mock,
						fncName: 'recomputeFunding',
						returns: ['0'],
					}),
				]);
			}
		},
	};

	// now run any postDeploy tasks (connecting contracts together)
	if (!skipPostDeploy && postDeployTasks[contract]) {
		await postDeployTasks[contract]();
	}

	return instance;
};

const setupAllContracts = async ({
	accounts,
	existing = {},
	mocks = {},
	contracts = [],
	tribes = [],
	feeds = [],
}) => {
	const [, owner] = accounts;

	// Copy mocks into the return object, this allows us to include them in the
	// AddressResolver
	const returnObj = Object.assign({}, mocks, existing);

	// BASE CONTRACTS

	// Note: those with deps need to be listed AFTER their deps
	// Note: deps are based on the contract's resolver name, allowing different contracts to be used
	// for the same dependency (e.g. in l1/l2 configurations)
	const baseContracts = [
		{ contract: 'AddressResolver' },
		{
			contract: 'OneNetAggregatorIssuedTribes',
			resolverAlias: 'ext:AggregatorIssuedTribes',
		},
		{
			contract: 'OneNetAggregatorDebtRatio',
			resolverAlias: 'ext:AggregatorDebtRatio',
		},
		{ contract: 'SystemStatus' },
		{ contract: 'ExchangeState' },
		{ contract: 'FlexibleStorage', deps: ['AddressResolver'] },
		{
			contract: 'SystemSettings',
			deps: ['AddressResolver', 'FlexibleStorage'],
		},
		{
			contract: 'DirectIntegrationManager',
			deps: ['AddressResolver', 'SystemSettings'],
		},
		{
			contract: 'ExchangeRates',
			deps: ['AddressResolver', 'SystemSettings', 'CircuitBreaker'],
			mocks: ['ExchangeCircuitBreaker'],
		},
		{ contract: 'RwaoneDebtShare' },
		{ contract: 'SupplySchedule' },
		{ contract: 'ProxyERC20', forContract: 'Rwaone' },
		{ contract: 'ProxyERC20', forContract: 'MintableRwaone' },
		{ contract: 'ProxyERC20', forContract: 'BaseRwaone' },
		{ contract: 'ProxyERC20', forContract: 'Tribe' }, // for generic tribe
		{ contract: 'Proxy', forContract: 'Rwaone' },
		{ contract: 'Proxy', forContract: 'MintableRwaone' },
		{ contract: 'Proxy', forContract: 'BaseRwaone' },
		{ contract: 'Proxy', forContract: 'FeePool' },
		{ contract: 'TokenState', forContract: 'Rwaone' },
		{ contract: 'TokenState', forContract: 'MintableRwaone' },
		{ contract: 'TokenState', forContract: 'BaseRwaone' },
		{ contract: 'TokenState', forContract: 'Tribe' }, // for generic tribe
		{ contract: 'RewardEscrow' },
		{
			contract: 'BaseRewardEscrowV2Frozen',
			deps: ['AddressResolver'],
			mocks: ['Rwaone', 'FeePool', 'Issuer'],
		},
		{
			contract: 'RewardEscrowV2Frozen',
			deps: ['AddressResolver'],
			mocks: ['Rwaone', 'FeePool', 'Issuer'],
		},
		{
			contract: 'RewardEscrowV2Storage',
			deps: ['RewardEscrowV2Frozen'],
			mocks: ['Rwaone', 'FeePool', 'RewardEscrow', 'RwaoneBridgeToOptimism', 'Issuer'],
		},
		{
			contract: 'BaseRewardEscrowV2',
			deps: ['AddressResolver', 'RewardEscrowV2Storage'],
			mocks: ['Rwaone', 'FeePool', 'Issuer'],
		},
		{
			contract: 'RewardEscrowV2',
			deps: ['AddressResolver', 'SystemStatus', 'RewardEscrowV2Storage'],
			mocks: ['Rwaone', 'FeePool', 'RewardEscrow', 'RwaoneBridgeToOptimism', 'Issuer'],
		},
		{
			contract: 'ImportableRewardEscrowV2',
			resolverAlias: `RewardEscrowV2`,
			deps: ['AddressResolver', 'RewardEscrowV2Storage'],
			mocks: ['Rwaone', 'FeePool', 'RwaoneBridgeToBase', 'Issuer'],
		},
		{ contract: 'RwaoneEscrow' },
		{ contract: 'FeePoolEternalStorage' },
		{ contract: 'EternalStorage', forContract: 'DelegateApprovals' },
		{ contract: 'DelegateApprovals', deps: ['EternalStorage'] },
		{ contract: 'EternalStorage', forContract: 'Liquidator' },
		{
			contract: 'Liquidator',
			deps: ['AddressResolver', 'EternalStorage', 'FlexibleStorage', 'RwaoneEscrow'],
		},
		{
			contract: 'LiquidatorRewards',
			deps: ['AddressResolver', 'Liquidator', 'Issuer', 'RewardEscrowV2', 'Rwaone'],
		},
		{
			contract: 'DebtMigratorOnEthereum',
			deps: [
				'AddressResolver',
				'Liquidator',
				'LiquidatorRewards',
				'Issuer',
				'RewardEscrowV2',
				'Rwaone',
				'RwaoneDebtShare',
				'RwaoneBridgeToOptimism',
				'SystemSettings',
			],
			mocks: ['ext:Messenger', 'ovm:DebtMigratorOnOptimism'],
		},
		{
			contract: 'DebtMigratorOnOptimism',
			deps: ['AddressResolver', 'Issuer', 'RewardEscrowV2', 'Rwaone'],
			mocks: ['ext:Messenger', 'base:DebtMigratorOnEthereum'],
		},
		{
			contract: 'RewardsDistribution',
			mocks: ['Rwaone', 'FeePool', 'RewardEscrow', 'RewardEscrowV2', 'ProxyFeePool'],
		},
		{ contract: 'Depot', deps: ['AddressResolver', 'SystemStatus'] },
		{ contract: 'TribeUtil', deps: ['AddressResolver'] },
		{ contract: 'DappMaintenance' },
		{ contract: 'WETH' },
		{
			contract: 'EtherWrapper',
			mocks: [],
			deps: ['AddressResolver', 'WETH'],
		},
		{
			contract: 'NativeEtherWrapper',
			mocks: [],
			deps: ['AddressResolver', 'EtherWrapper', 'WETH', 'TriberETH'],
		},
		{
			contract: 'WrapperFactory',
			mocks: [],
			deps: ['AddressResolver', 'SystemSettings'],
		},
		{
			contract: 'TribeRedeemer',
			mocks: ['Issuer'],
			deps: ['AddressResolver'],
		},
		{
			contract: 'DebtCache',
			mocks: ['Issuer', 'Exchanger', 'CollateralManager', 'EtherWrapper', 'FuturesMarketManager'],
			deps: ['ExchangeRates', 'SystemStatus'],
		},
		{
			contract: 'Issuer',
			mocks: [
				'CollateralManager',
				'Rwaone',
				'Exchanger',
				'FeePool',
				'DelegateApprovals',
				'FlexibleStorage',
				'WrapperFactory',
				'EtherWrapper',
				'TribeRedeemer',
			],
			deps: [
				'OneNetAggregatorIssuedTribes',
				'OneNetAggregatorDebtRatio',
				'AddressResolver',
				'SystemStatus',
				'FlexibleStorage',
				'DebtCache',
				'RwaoneDebtShare',
			],
		},
		{
			contract: 'CircuitBreaker',
			mocks: ['Issuer', 'ExchangeRates'],
			deps: ['AddressResolver', 'SystemStatus', 'FlexibleStorage'],
		},
		{
			contract: 'ExchangeCircuitBreaker',
			mocks: ['Rwaone', 'FeePool', 'DelegateApprovals', 'VirtualTribeMastercopy'],
			deps: ['AddressResolver', 'SystemStatus', 'ExchangeRates', 'FlexibleStorage', 'Issuer'],
		},
		{
			contract: 'Exchanger',
			mocks: ['Rwaone', 'FeePool', 'DelegateApprovals'],
			deps: [
				'AddressResolver',
				'DirectIntegrationManager',
				'TradingRewards',
				'SystemStatus',
				'ExchangeRates',
				'ExchangeState',
				'FlexibleStorage',
				'DebtCache',
				'CircuitBreaker',
			],
		},
		{
			contract: 'ExchangeRatesWithDexPricing',
			resolverAlias: 'ExchangeRates',
			deps: ['AddressResolver', 'DirectIntegrationManager', 'CircuitBreaker'],
		},
		{
			contract: 'ExchangerWithFeeRecAlternatives',
			resolverAlias: 'Exchanger',
			mocks: [
				'Rwaone',
				'CircuitBreaker',
				'ExchangeRates',
				'FeePool',
				'DelegateApprovals',
				'VirtualTribeMastercopy',
			],
			deps: [
				'AddressResolver',
				'DirectIntegrationManager',
				'TradingRewards',
				'SystemStatus',
				'ExchangeRates',
				'ExchangeState',
				'FlexibleStorage',
				'DebtCache',
				'CircuitBreaker',
			],
		},
		{
			contract: 'Tribe',
			mocks: ['Issuer', 'Exchanger', 'FeePool', 'EtherWrapper', 'WrapperFactory'],
			deps: ['TokenState', 'ProxyERC20', 'SystemStatus', 'AddressResolver'],
		}, // a generic tribe
		{
			contract: 'Rwaone',
			mocks: [
				'Exchanger',
				'SupplySchedule',
				'RewardEscrow',
				'RewardEscrowV2',
				'RwaoneEscrow',
				'RewardsDistribution',
				'Liquidator',
				'LiquidatorRewards',
			],
			deps: ['Issuer', 'Proxy', 'ProxyERC20', 'AddressResolver', 'TokenState', 'SystemStatus'],
		},
		{
			contract: 'BaseRwaone',
			resolverAlias: 'Rwaone',
			mocks: [
				'Exchanger',
				'RewardEscrow',
				'RewardEscrowV2',
				'RwaoneEscrow',
				'RewardsDistribution',
				'Liquidator',
				'LiquidatorRewards',
			],
			deps: ['Issuer', 'Proxy', 'ProxyERC20', 'AddressResolver', 'TokenState', 'SystemStatus'],
		},
		{
			contract: 'MintableRwaone',
			resolverAlias: 'Rwaone',
			mocks: [
				'Exchanger',
				'RwaoneEscrow',
				'Liquidator',
				'LiquidatorRewards',
				'Issuer',
				'SystemStatus',
				'RwaoneBridgeToBase',
			],
			deps: [
				'Proxy',
				'ProxyERC20',
				'AddressResolver',
				'TokenState',
				'RewardsDistribution',
				'RewardEscrow',
				'RewardEscrowV2',
			],
		},
		{
			contract: 'RwaoneBridgeToOptimism',
			mocks: [
				'ext:Messenger',
				'ovm:RwaoneBridgeToBase',
				'FeePool',
				'RwaoneBridgeEscrow',
				'RewardsDistribution',
			],
			deps: ['AddressResolver', 'Issuer', 'RewardEscrowV2', 'Rwaone'],
		},
		{
			contract: 'RwaoneBridgeToBase',
			mocks: ['ext:Messenger', 'base:RwaoneBridgeToOptimism', 'FeePool', 'RewardEscrowV2'],
			deps: ['AddressResolver', 'Rwaone'],
		},
		{
			contract: 'RwaoneBridgeEscrow',
			mocks: [],
			deps: [],
		},
		{ contract: 'TradingRewards', deps: ['AddressResolver', 'Rwaone'] },
		{
			contract: 'FeePool',
			mocks: [
				'Rwaone',
				'Exchanger',
				'Issuer',
				'RewardEscrow',
				'RewardEscrowV2',
				'DelegateApprovals',
				'FeePoolEternalStorage',
				'RewardsDistribution',
				'FlexibleStorage',
				'CollateralManager',
				'EtherWrapper',
				'FuturesMarketManager',
				'WrapperFactory',
				'RwaoneBridgeToOptimism',
			],
			deps: [
				'OneNetAggregatorIssuedTribes',
				'OneNetAggregatorDebtRatio',
				'SystemStatus',
				'RwaoneDebtShare',
				'AddressResolver',
			],
		},
		{
			contract: 'CollateralState',
			deps: [],
		},
		{
			contract: 'CollateralManagerState',
			deps: [],
		},
		{
			contract: 'CollateralUtil',
			deps: ['AddressResolver', 'ExchangeRates'],
		},
		{
			contract: 'CollateralManager',
			deps: [
				'AddressResolver',
				'SystemStatus',
				'Issuer',
				'ExchangeRates',
				'DebtCache',
				'CollateralUtil',
				'CollateralManagerState',
			],
		},
		{
			contract: 'Collateral',
			deps: ['CollateralManager', 'AddressResolver', 'CollateralUtil'],
		},
		{
			contract: 'CollateralEth',
			deps: ['Collateral', 'CollateralManager', 'AddressResolver', 'CollateralUtil'],
		},
		{
			contract: 'CollateralShort',
			deps: ['Collateral', 'CollateralManager', 'AddressResolver', 'CollateralUtil'],
		},
		{
			contract: 'FuturesMarketManager',
			deps: ['AddressResolver', 'Exchanger'],
		},
		{
			contract: 'FuturesMarketSettings',
			deps: ['AddressResolver', 'FlexibleStorage'],
		},
		// perps v1 - "futures"
		{
			contract: 'FuturesMarketBTC',
			source: 'TestableFuturesMarket',
			deps: [
				'AddressResolver',
				'FuturesMarketManager',
				'FuturesMarketSettings',
				'SystemStatus',
				'FlexibleStorage',
				'ExchangeCircuitBreaker',
			],
		},
		{
			contract: 'FuturesMarketETH',
			source: 'TestableFuturesMarket',
			deps: [
				'AddressResolver',
				'FuturesMarketManager',
				'FuturesMarketSettings',
				'SystemStatus',
				'FlexibleStorage',
				'ExchangeCircuitBreaker',
			],
		},
		{ contract: 'FuturesMarketData', deps: ['FuturesMarketSettings'] },

		// Perps v2
		{ contract: 'PerpsV2ExchangeRate', deps: ['AddressResolver', 'FlexibleStorage'] },
		{ contract: 'Proxy', source: 'ProxyPerpsV2', forContract: 'PerpsV2MarketBTC' },
		{ contract: 'Proxy', source: 'ProxyPerpsV2', forContract: 'PerpsV2MarketETH' },
		{
			contract: 'PerpsV2MarketStateBTC',
			source: 'PerpsV2MarketState',
		},
		{
			contract: 'PerpsV2MarketStateETH',
			source: 'PerpsV2MarketState',
		},
		{ contract: 'PerpsV2MarketSettings', deps: ['AddressResolver', 'FlexibleStorage'] },
		{ contract: 'PerpsV2MarketData', deps: ['PerpsV2MarketSettings'] },
		// PerpsV2 BTC
		{
			contract: 'PerpsV2MarketViewhBTC',
			source: 'PerpsV2MarketViews',
			deps: [
				'ProxyPerpsV2MarketBTC',
				'PerpsV2MarketStateBTC',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketDelayedIntentBTC',
			source: 'PerpsV2MarketDelayedIntent',
			deps: [
				'ProxyPerpsV2MarketBTC',
				'PerpsV2MarketStateBTC',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
			],
		},
		{
			contract: 'PerpsV2MarketDelayedExecutionBTC',
			source: 'PerpsV2MarketDelayedExecution',
			deps: [
				'ProxyPerpsV2MarketBTC',
				'PerpsV2MarketStateBTC',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketLiquidateBTC',
			source: 'PerpsV2MarketLiquidate',
			deps: [
				'ProxyPerpsV2MarketBTC',
				'PerpsV2MarketStateBTC',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FuturesMarketManager',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketBTC',
			source: 'PerpsV2Market',
			deps: [
				'ProxyPerpsV2MarketBTC',
				'PerpsV2MarketStateBTC',
				'PerpsV2MarketViewhBTC',
				'PerpsV2MarketLiquidateBTC',
				'PerpsV2MarketDelayedIntentBTC',
				'PerpsV2MarketDelayedExecutionBTC',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FuturesMarketManager',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'TestablePerpsV2MarketBTC',
			source: 'TestablePerpsV2Market',
			deps: ['PerpsV2MarketBTC'],
		},

		// PerpsV2 ETH
		{
			contract: 'PerpsV2MarketViewrETH',
			source: 'PerpsV2MarketViews',
			deps: [
				'ProxyPerpsV2MarketETH',
				'PerpsV2MarketStateETH',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketDelayedIntentETH',
			source: 'PerpsV2MarketDelayedIntent',
			deps: [
				'ProxyPerpsV2MarketETH',
				'PerpsV2MarketStateETH',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
			],
		},
		{
			contract: 'PerpsV2MarketDelayedExecutionETH',
			source: 'PerpsV2MarketDelayedExecution',
			deps: [
				'ProxyPerpsV2MarketETH',
				'PerpsV2MarketStateETH',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketLiquidateETH',
			source: 'PerpsV2MarketLiquidate',
			deps: [
				'ProxyPerpsV2MarketETH',
				'PerpsV2MarketStateETH',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FuturesMarketManager',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'PerpsV2MarketETH',
			source: 'PerpsV2Market',
			deps: [
				'ProxyPerpsV2MarketETH',
				'PerpsV2MarketStateETH',
				'PerpsV2MarketViewrETH',
				'PerpsV2MarketLiquidateETH',
				'PerpsV2MarketDelayedIntentETH',
				'PerpsV2MarketDelayedExecutionETH',
				'PerpsV2MarketSettings',
				'AddressResolver',
				'FuturesMarketManager',
				'FlexibleStorage',
				'ExchangeRates',
				'PerpsV2ExchangeRate',
			],
		},
		{
			contract: 'TestablePerpsV2MarketETH',
			source: 'TestablePerpsV2Market',
			deps: ['PerpsV2MarketETH'],
		},
	];

	// check contract list for contracts with the same address resolver name
	const checkConflictsInDeclaredContracts = ({ contractList }) => {
		// { resolverName: [contract1, contract2, ...], ... }
		const resolverNameToContracts = baseContracts
			.filter(({ contract }) => contractList.includes(contract))
			.filter(({ forContract }) => !forContract) // ignore proxies
			.map(({ contract, resolverAlias }) => [contract, resolverAlias || contract])
			.reduce((memo, [name, resolverName]) => {
				memo[resolverName] = [].concat(memo[resolverName] || [], name);
				return memo;
			}, {});
		// [[resolverName, [contract1, contract2, ...]]]
		const conflicts = Object.entries(resolverNameToContracts).filter(
			([resolverName, contracts]) => contracts.length > 1
		);

		if (conflicts.length) {
			const errorStr = conflicts.map(
				([resolverName, contracts]) => `[${contracts.join(',')}] conflict for ${resolverName}`
			);

			throw new Error(`Conflicting contracts declared in setup: ${errorStr}`);
		}
	};

	// get deduped list of all required base contracts
	const findAllAssociatedContracts = ({ contractList }) => {
		return Array.from(
			new Set(
				baseContracts
					.filter(({ contract }) => contractList.includes(contract))
					.reduce(
						(memo, { contract, deps = [] }) =>
							memo.concat(contract).concat(findAllAssociatedContracts({ contractList: deps })),
						[]
					)
			)
		);
	};

	// contract names the user requested - could be a list of strings or objects with a "contract" property
	const contractNamesRequested = contracts.map(contract => contract.contract || contract);

	// ensure user didn't specify conflicting contracts
	checkConflictsInDeclaredContracts({ contractList: contractNamesRequested });

	// get list of resolver aliases from declared contracts
	const namesResolvedThroughAlias = contractNamesRequested
		.map(contractName => baseContracts.find(({ contract }) => contract === contractName))
		.map(({ resolverAlias }) => resolverAlias)
		.filter(resolverAlias => !!resolverAlias);

	// now go through all contracts and compile a list of them and all nested dependencies
	const contractsRequired = findAllAssociatedContracts({ contractList: contractNamesRequested });

	// now sort in dependency order
	const contractsToFetch = baseContracts.filter(
		({ contract, forContract }) =>
			// keep if contract is required
			contractsRequired.includes(contract) &&
			// ignore if contract has been aliased
			!namesResolvedThroughAlias.includes(contract) &&
			// and either there is no "forContract" or the forContract is itself required
			(!forContract || contractsRequired.includes(forContract)) &&
			// and no entry in the existingContracts object
			!(contract in existing)
	);

	// now setup each contract in serial in case we have deps we need to load
	for (const { contract, source, resolverAlias, mocks = [], forContract } of contractsToFetch) {
		// mark each mock onto the returnObj as true when it doesn't exist, indicating it needs to be
		// put through the AddressResolver
		// for all mocks required for this contract
		await Promise.all(
			mocks
				// if the target isn't on the returnObj (i.e. already mocked / created) and not in the list of contracts
				.filter(mock => !(mock in returnObj) && contractNamesRequested.indexOf(mock) < 0)
				// then setup the contract
				.map(mock =>
					setupContract({
						accounts,
						mock,
						contract: 'GenericMock',
						cache: Object.assign({}, mocks, returnObj),
					}).then(instance => (returnObj[mock] = instance))
				)
		);

		// the name of the contract - the contract plus it's forContract
		// (e.g. Proxy + FeePool)
		const forContractName = forContract || '';

		// some contracts should be registered to the address resolver with a different name
		const contractRegistered = resolverAlias || contract;

		// deploy the contract
		returnObj[contractRegistered + forContractName] = await setupContract({
			accounts,
			contract,
			source,
			forContract,
			// the cache is a combination of the mocks and any return objects
			cache: Object.assign({}, mocks, returnObj),
			// pass through any properties that may be given for this contract
			properties:
				(contracts.find(({ contract: foundContract }) => foundContract === contract) || {})
					.properties || {},
		});
	}

	// TRIBES

	const tribesToAdd = [];

	// now setup each tribe and its deps
	for (const tribe of tribes) {
		const { token, proxy, tokenState } = await mockToken({
			accounts,
			tribe,
			supply: 0, // add tribes with 0 supply initially
			skipInitialAllocation: true,
			name: `Tribe ${tribe}`,
			symbol: tribe,
		});

		returnObj[`ProxyERC20${tribe}`] = proxy;
		returnObj[`TokenState${tribe}`] = tokenState;
		returnObj[`Tribe${tribe}`] = token;

		// We'll defer adding the tokens into the Issuer as it must
		// be synchronised with the FlexibleStorage address first.
		tribesToAdd.push(token.address);
	}

	// now invoke AddressResolver to set all addresses
	if (returnObj['AddressResolver']) {
		if (process.env.DEBUG) {
			log(`Importing into AddressResolver:\n\t - ${Object.keys(returnObj).join('\n\t - ')}`);
		}

		await returnObj['AddressResolver'].importAddresses(
			Object.keys(returnObj).map(toBytes32),
			Object.values(returnObj).map(entry =>
				// use 0x1111 address for any mocks that have no actual deployment
				entry === true ? '0x' + '1'.repeat(40) : entry.address
			),
			{
				from: owner,
			}
		);
	}

	// now rebuild caches for all contracts that need it
	await Promise.all(
		Object.entries(returnObj)
			// keep items not in mocks
			.filter(([name]) => !(name in mocks))
			// and only those with the setResolver function
			.filter(([, instance]) => !!instance.rebuildCache)
			.map(([contract, instance]) => {
				return instance.rebuildCache().catch(err => {
					throw err;
				});
			})
	);

	// if deploying a real Rwaone, then we add the tribes
	if (returnObj['Issuer'] && !mocks['Issuer']) {
		if (returnObj['Tribe']) {
			returnObj['Issuer'].addTribe(returnObj['Tribe'].address, { from: owner });
		}

		for (const tribeAddress of tribesToAdd) {
			await returnObj['Issuer'].addTribe(tribeAddress, { from: owner });
		}
	}

	// now setup defaults for the system (note: this dupes logic from the deploy script)
	if (returnObj['SystemSettings']) {
		await Promise.all([
			returnObj['SystemSettings'].setWaitingPeriodSecs(WAITING_PERIOD_SECS, { from: owner }),
			returnObj['SystemSettings'].setPriceDeviationThresholdFactor(
				PRICE_DEVIATION_THRESHOLD_FACTOR,
				{ from: owner }
			),
			returnObj['SystemSettings'].setIssuanceRatio(ISSUANCE_RATIO, { from: owner }),
			returnObj['SystemSettings'].setCrossDomainMessageGasLimit(0, CROSS_DOMAIN_DEPOSIT_GAS_LIMIT, {
				from: owner,
			}),
			returnObj['SystemSettings'].setCrossDomainMessageGasLimit(1, CROSS_DOMAIN_ESCROW_GAS_LIMIT, {
				from: owner,
			}),
			returnObj['SystemSettings'].setCrossDomainMessageGasLimit(2, CROSS_DOMAIN_REWARD_GAS_LIMIT, {
				from: owner,
			}),
			returnObj['SystemSettings'].setCrossDomainMessageGasLimit(
				3,
				CROSS_DOMAIN_WITHDRAWAL_GAS_LIMIT,
				{
					from: owner,
				}
			),
			returnObj['SystemSettings'].setFeePeriodDuration(FEE_PERIOD_DURATION, { from: owner }),
			returnObj['SystemSettings'].setTargetThreshold(TARGET_THRESHOLD, { from: owner }),
			returnObj['SystemSettings'].setLiquidationDelay(LIQUIDATION_DELAY, { from: owner }),
			returnObj['SystemSettings'].setLiquidationRatio(LIQUIDATION_RATIO, { from: owner }),
			returnObj['SystemSettings'].setLiquidationEscrowDuration(LIQUIDATION_ESCROW_DURATION, {
				from: owner,
			}),
			returnObj['SystemSettings'].setLiquidationPenalty(LIQUIDATION_PENALTY, {
				from: owner,
			}),
			returnObj['SystemSettings'].setSnxLiquidationPenalty(RWAX_LIQUIDATION_PENALTY, {
				from: owner,
			}),
			returnObj['SystemSettings'].setSelfLiquidationPenalty(SELF_LIQUIDATION_PENALTY, {
				from: owner,
			}),
			returnObj['SystemSettings'].setFlagReward(FLAG_REWARD, { from: owner }),
			returnObj['SystemSettings'].setLiquidateReward(LIQUIDATE_REWARD, { from: owner }),
			returnObj['SystemSettings'].setRateStalePeriod(RATE_STALE_PERIOD, { from: owner }),
			returnObj['SystemSettings'].setExchangeDynamicFeeThreshold(
				constantsOverrides.EXCHANGE_DYNAMIC_FEE_THRESHOLD,
				{
					from: owner,
				}
			),
			returnObj['SystemSettings'].setExchangeDynamicFeeWeightDecay(
				constantsOverrides.EXCHANGE_DYNAMIC_FEE_WEIGHT_DECAY,
				{
					from: owner,
				}
			),
			returnObj['SystemSettings'].setExchangeDynamicFeeRounds(
				constantsOverrides.EXCHANGE_DYNAMIC_FEE_ROUNDS,
				{
					from: owner,
				}
			),
			returnObj['SystemSettings'].setExchangeMaxDynamicFee(
				constantsOverrides.EXCHANGE_MAX_DYNAMIC_FEE,
				{
					from: owner,
				}
			),
			returnObj['SystemSettings'].setMinimumStakeTime(MINIMUM_STAKE_TIME, { from: owner }),
			returnObj['SystemSettings'].setDebtSnapshotStaleTime(DEBT_SNAPSHOT_STALE_TIME, {
				from: owner,
			}),
			returnObj['SystemSettings'].setEtherWrapperMaxETH(ETHER_WRAPPER_MAX_ETH, {
				from: owner,
			}),
			returnObj['SystemSettings'].setEtherWrapperMintFeeRate(ETHER_WRAPPER_MINT_FEE_RATE, {
				from: owner,
			}),
			returnObj['SystemSettings'].setEtherWrapperBurnFeeRate(ETHER_WRAPPER_BURN_FEE_RATE, {
				from: owner,
			}),
			returnObj['SystemSettings'].setAtomicMaxVolumePerBlock(ATOMIC_MAX_VOLUME_PER_BLOCK, {
				from: owner,
			}),
			returnObj['SystemSettings'].setAtomicTwapWindow(ATOMIC_TWAP_WINDOW, {
				from: owner,
			}),
		]);

		// legacy futures
		if (returnObj['FuturesMarketSettings']) {
			const promises = [
				returnObj['FuturesMarketSettings'].setMinInitialMargin(FUTURES_MIN_INITIAL_MARGIN, {
					from: owner,
				}),
				returnObj['FuturesMarketSettings'].setMinKeeperFee(
					constantsOverrides.FUTURES_MIN_KEEPER_FEE,
					{
						from: owner,
					}
				),
				returnObj['FuturesMarketSettings'].setLiquidationFeeRatio(FUTURES_LIQUIDATION_FEE_RATIO, {
					from: owner,
				}),
				returnObj['FuturesMarketSettings'].setLiquidationBufferRatio(
					FUTURES_LIQUIDATION_BUFFER_RATIO,
					{
						from: owner,
					}
				),
			];

			// TODO: fetch settings per-market programmatically
			const setupFuturesMarket = async market => {
				const assetKey = await market.baseAsset();
				const marketKey = await market.marketKey();
				await setupPriceAggregators(returnObj['ExchangeRates'], owner, [assetKey]);
				await updateAggregatorRates(returnObj['ExchangeRates'], null, [assetKey], [toUnit('1')]);
				await Promise.all([
					returnObj['FuturesMarketSettings'].setParameters(
						marketKey,
						toWei('0.003'), // 0.3% taker fee
						toWei('0.001'), // 0.1% maker fee
						toWei('0.0005'), // 0.05% taker fee next price
						toWei('0.0001'), // 0.01% maker fee next price
						toBN('2'), // 2 rounds next price confirm window
						toWei('10'), // 10x max leverage
						toWei('100000'), // 100000 max market debt
						toWei('0.1'), // 10% max funding velocity
						toWei('100000'), // 100000 USD skewScaleUSD
						{ from: owner }
					),
				]);
			};

			if (returnObj['FuturesMarketBTC']) {
				promises.push(setupFuturesMarket(returnObj['FuturesMarketBTC']));
			}
			if (returnObj['FuturesMarketETH']) {
				promises.push(setupFuturesMarket(returnObj['FuturesMarketETH']));
			}

			await Promise.all(promises);
		}

		// PerpsV2
		if (returnObj['PerpsV2MarketSettings']) {
			const promises = [
				returnObj['PerpsV2MarketSettings'].setMinInitialMargin(FUTURES_MIN_INITIAL_MARGIN, {
					from: owner,
				}),
				returnObj['PerpsV2MarketSettings'].setMinKeeperFee(
					constantsOverrides.FUTURES_MIN_KEEPER_FEE,
					{
						from: owner,
					}
				),
				returnObj['PerpsV2MarketSettings'].setMaxKeeperFee(
					constantsOverrides.FUTURES_MAX_KEEPER_FEE,
					{
						from: owner,
					}
				),
				returnObj['PerpsV2MarketSettings'].setLiquidationFeeRatio(FUTURES_LIQUIDATION_FEE_RATIO, {
					from: owner,
				}),
				returnObj['PerpsV2MarketSettings'].setKeeperLiquidationFee(PERPSV2_KEEPER_LIQUIDATION_FEE, {
					from: owner,
				}),
			];

			// fetch settings per-market programmatically
			const setupPerpsV2Market = async market => {
				const marketViewsArtifact = artifacts.require('PerpsV2MarketViews');
				const proxiedMarketViews = await marketViewsArtifact.at(market.address);

				const assetKey = await proxiedMarketViews.baseAsset();
				const marketKey = await proxiedMarketViews.marketKey();
				const offchainMarketKey = toBytes32(
					'oc' + fromBytes32(marketKey.replace(/([0\s]+$)/g, ''))
				);
				await setupPriceAggregators(returnObj['ExchangeRates'], owner, [assetKey]);
				await updateAggregatorRates(returnObj['ExchangeRates'], null, [assetKey], [toUnit('1')]);
				await Promise.all([
					returnObj['PerpsV2MarketSettings'].setParameters(
						marketKey,
						[
							toWei('0.003'), // 0.3% taker fee
							toWei('0.001'), // 0.1% maker fee
							toWei('0.0005'), // 0.05% taker fee delayed order
							toWei('0.0001'), // 0.01% maker fee delayed order
							toWei('0.00005'), // 0.005% taker fee offchain delayed order
							toWei('0.00001'), // 0.001% maker fee offchain delayed order

							toWei('10'), // 10x max leverage
							toWei('1000'), // 1000 max market value
							toWei('0.1'), // 10% max funding velocity
							toWei('100000'), // 100k native units skewScale

							toBN('2'), // 2 rounds next price confirm window
							30, // 30s delay confirm window
							60, // 60s minimum delay time in seconds
							120, // 120s maximum delay time in seconds

							15, // 15s offchain min delay window
							60, // 60s offchain max delay window

							offchainMarketKey, // offchain market key
							toUnit('0.06'), // offchain price divergence 6%

							toWei('1'), // 1 liquidation premium multiplier
							FUTURES_LIQUIDATION_BUFFER_RATIO,
							toWei('0'),
							toWei('0'),
						],
						{ from: owner }
					),
				]);
			};

			if (returnObj['PerpsV2MarketBTC']) {
				promises.push(setupPerpsV2Market(returnObj['ProxyPerpsV2MarketBTC']));
			}
			if (returnObj['PerpsV2MarketETH']) {
				promises.push(setupPerpsV2Market(returnObj['ProxyPerpsV2MarketETH']));
			}

			await Promise.all(promises);
		}
	}

	// finally if any of our contracts have setAddressResolver (from MockTribe), then invoke it
	await Promise.all(
		Object.values(returnObj)
			.filter(contract => contract.setAddressResolver)
			.map(mock => mock.setAddressResolver(returnObj['AddressResolver'].address))
	);

	if (returnObj['ExchangeRates']) {
		// setup wRWAX price feed and any other feeds
		const keys = ['wRWAX', ...(feeds || [])].map(toBytes32);
		const prices = ['0.2', ...(feeds || []).map(() => '1.0')].map(toUnit);
		await setupPriceAggregators(returnObj['ExchangeRates'], owner, keys);
		await updateAggregatorRates(
			returnObj['ExchangeRates'],
			returnObj['CircuitBreaker'],
			keys,
			prices
		);
	}

	return returnObj;
};

module.exports = {
	mockToken,
	mockGenericContractFnc,
	setupContract,
	setupAllContracts,
	constantsOverrides,
	excludedFunctions,
	excludedTestableFunctions,
	getFunctionSignatures,
};
