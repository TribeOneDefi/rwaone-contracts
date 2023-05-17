# Tribeone

[![CircleCI](https://circleci.com/gh/Tribeoneio/tribeone.svg?style=svg)](https://circleci.com/gh/Tribeoneio/tribeone)
[![codecov](https://codecov.io/gh/Tribeoneio/tribeone/branch/develop/graph/badge.svg)](https://codecov.io/gh/Tribeoneio/tribeone)
[![npm version](https://badge.fury.io/js/tribeone.svg)](https://badge.fury.io/js/tribeone)
[![Discord](https://img.shields.io/discord/413890591840272394.svg?color=768AD4&label=discord&logo=https%3A%2F%2Fdiscordapp.com%2Fassets%2F8c9701b98ad4372b58f13fd9f65f966e.svg)](https://discord.com/invite/Tribeone)
[![Twitter Follow](https://img.shields.io/twitter/follow/tribeetix_io.svg?label=tribeetix_io&style=social)](https://twitter.com/tribeetix_io)

Tribeone is a crypto-backed tribeetic asset platform.

It is a multi-token system, powered by HAKA, the Tribeone Network Token. HAKA holders can stake HAKA to issue Tribes, on-chain tribeetic assets via the [Staking dApp](https://staking.tribeone.io) The network currently supports an ever-growing [list of tribeetic assets](https://www.tribeone.io/tribes/). Please see the [list of the deployed contracts on MAIN and TESTNETS](https://docs.tribeone.io/addresses/)
Tribes can be traded using [Kwenta](https://kwenta.io)

Tribeone uses a proxy system so that upgrades will not be disruptive to the functionality of the contract. This smooths user interaction, since new functionality will become available without any interruption in their experience. It is also transparent to the community at large, since each upgrade is accompanied by events announcing those upgrades. New releases are managed via the [Tribeone Improvement Proposal (SIP)](https://sips.tribeone.io/all-sip) system similar to the [EIPs](https://eips.ethereum.org/all)

Prices are committed on-chain by a trusted oracle provided by [Chainlink](https://feeds.chain.link/).

Please note that this repository is under development.

For the latest system documentation see [docs.tribeone.io](https://docs.tribeone.io)

## DApps

- [staking.tribeone.io](https://staking.tribeone.io)
- [kwenta.io](https://kwenta.io)
- [stats.tribeone.io](https://stats.tribeone.io)

### Community

[![Discord](https://img.shields.io/discord/413890591840272394.svg?color=768AD4&label=discord&logo=https%3A%2F%2Fdiscordapp.com%2Fassets%2F8c9701b98ad4372b58f13fd9f65f966e.svg)](https://discordapp.com/channels/413890591840272394/) [![Twitter Follow](https://img.shields.io/twitter/follow/tribeetix_io.svg?label=tribeetix_io&style=social)](https://twitter.com/tribeetix_io)

For a guide from the community, see [tribeone.community](https://tribeone.community)

---

## Repo Guide

### Branching

A note on the branches used in this repo.

- `master` represents the contracts live on `mainnet` and all testnets.

When a new version of the contracts makes its way through all testnets, it eventually becomes promoted in `master`, with [semver](https://semver.org/) reflecting contract changes in the `major` or `minor` portion of the version (depending on backwards compatibility). `patch` changes are simply for changes to the JavaScript interface.

### Testing

[![CircleCI](https://circleci.com/gh/Tribeoneio/tribeone.svg?style=svg)](https://circleci.com/gh/Tribeoneio/tribeone)
[![codecov](https://codecov.io/gh/Tribeoneio/tribeone/branch/develop/graph/badge.svg)](https://codecov.io/gh/Tribeoneio/tribeone)

Please see [docs.tribeone.io/contracts/testing](https://docs.tribeone.io/contracts/testing) for an overview of the automated testing methodologies.

## Module Usage

[![npm version](https://badge.fury.io/js/tribeone.svg)](https://badge.fury.io/js/tribeone)

This repo may be installed via `npm install` to support both node.js scripting applications and Solidity contract development.

### Examples

:100: Please see our walkthroughs for code examples in both JavaScript and Solidity: [docs.tribeone.io/integrations](https://docs.tribeone.io/integrations/)

### Solidity API

All interfaces are available via the path [`tribeone/contracts/interfaces`](./contracts/interfaces/).

:zap: In your code, the key is to use `IAddressResolver` which can be tied to the immutable proxy: [`ReadProxyAddressResolver`](https://contracts.tribeone.io/ReadProxyAddressResolver) ([introduced in SIP-57](https://sips.tribeone.io/sips/sip-57)). You can then fetch `Tribeone`, `FeePool`, `Depot`, et al via `IAddressResolver.getAddress(bytes32 name)` where `name` is the `bytes32` version of the contract name (case-sensitive). Or you can fetch any tribe using `IAddressResolver.getTribe(bytes32 tribe)` where `tribe` is the `bytes32` name of the tribe (e.g. `iETH`, `hUSD`, `sDEFI`).

E.g.

`npm install tribeone`

then you can write Solidity as below (using a compiler that links named imports via `node_modules`):

```solidity
pragma solidity ^0.5.16;

import 'tribeone/contracts/interfaces/IAddressResolver.sol';
import 'tribeone/contracts/interfaces/ITribeone.sol';

contract MyContract {
  // This should be instantiated with our ReadProxyAddressResolver
  // it's a ReadProxy that won't change, so safe to code it here without a setter
  // see https://docs.tribeone.io/addresses for addresses in mainnet and testnets
  IAddressResolver public tribeetixResolver;

  constructor(IAddressResolver _snxResolver) public {
    tribeetixResolver = _snxResolver;
  }

  function tribeetixIssue() external {
    ITribeone tribeone = tribeetixResolver.getAddress('Tribeone');
    require(tribeone != address(0), 'Tribeone is missing from Tribeone resolver');

    // Issue for msg.sender = address(MyContract)
    tribeone.issueMaxTribes();
  }

  function tribeetixIssueOnBehalf(address user) external {
    ITribeone tribeone = tribeetixResolver.getAddress('Tribeone');
    require(tribeone != address(0), 'Tribeone is missing from Tribeone resolver');

    // Note: this will fail if `DelegateApprovals.approveIssueOnBehalf(address(MyContract))` has
    // not yet been invoked by the `user`
    tribeone.issueMaxTribesOnBehalf(user);
  }
}
```

### Node.js API

- `getAST({ source, match = /^contracts\// })` Returns the Abstract Syntax Tree (AST) for all compiled sources. Optionally add `source` to restrict to a single contract source, and set `match` to an empty regex if you'd like all source ASTs including third-party contracts
- `getPathToNetwork({ network, file = '' })` Returns the path to the folder (or file within the folder) for the given network
- `getSource({ network })` Return `abi` and `bytecode` for a contract `source`
- `getSuspensionReasons({ code })` Return mapping of `SystemStatus` suspension codes to string reasons
- `getStakingRewards({ network })` Return the list of staking reward contracts available.
- `getTribes({ network })` Return the list of tribes for a network
- `getTarget({ network })` Return the information about a contract's `address` and `source` file. The contract names are those specified in [docs.tribeone.io/addresses](https://docs.tribeone.io/addresses)
- `getTokens({ network })` Return the list of tokens (tribes and `HAKA`) used in the system, along with their addresses.
- `getUsers({ network })` Return the list of user accounts within the Tribeone protocol (e.g. `owner`, `fee`, etc)
- `getVersions({ network, byContract = false })` Return the list of deployed versions to the network keyed by tagged version. If `byContract` is `true`, it keys by `contract` name.
- `networks` Return the list of supported networks
- `toBytes32` Convert any string to a `bytes32` value

#### Via code

```javascript
const snx = require('tribeone');

snx.getAST();
/*
{ 'contracts/AddressResolver.sol':
   { imports:
      [ 'contracts/Owned.sol',
        'contracts/interfaces/IAddressResolver.sol',
        'contracts/interfaces/ITribeone.sol' ],
     contracts: { AddressResolver: [Object] },
     interfaces: {},
     libraries: {} },
  'contracts/Owned.sol':
   { imports: [],
     contracts: { Owned: [Object] },
     interfaces: {},
     libraries: {} },
*/

snx.getAST({ source: 'Tribeone.sol' });
/*
{ imports:
   [ 'contracts/ExternStateToken.sol',
     'contracts/MixinResolver.sol',
     'contracts/interfaces/ITribeone.sol',
     'contracts/TokenState.sol',
     'contracts/interfaces/ITribe.sol',
     'contracts/interfaces/IERC20.sol',
     'contracts/interfaces/ISystemStatus.sol',
     'contracts/interfaces/IExchanger.sol',
     'contracts/interfaces/IIssuer.sol',
     'contracts/interfaces/ITribeoneState.sol',
     'contracts/interfaces/IExchangeRates.sol',
     'contracts/SupplySchedule.sol',
     'contracts/interfaces/IRewardEscrow.sol',
     'contracts/interfaces/IHasBalance.sol',
     'contracts/interfaces/IRewardsDistribution.sol' ],
  contracts:
   { Tribeone:
      { functions: [Array],
        events: [Array],
        variables: [Array],
        modifiers: [Array],
        structs: [],
        inherits: [Array] } },
  interfaces: {},
  libraries: {} }
*/

// Get the path to the network
snx.getPathToNetwork({ network: 'mainnet' });
//'.../Tribeoneio/tribeone/publish/deployed/mainnet'

// retrieve an object detailing the contract ABI and bytecode
snx.getSource({ network: 'goerli', contract: 'Proxy' });
/*
{
  bytecode: '0..0',
  abi: [ ... ]
}
*/

snx.getSuspensionReasons();
/*
{
	1: 'System Upgrade',
	2: 'Market Closure',
	3: 'Circuit breaker',
	99: 'Emergency',
};
*/

// retrieve the array of tribes used
snx.getTribes({ network: 'goerli' }).map(({ name }) => name);
// ['hUSD', 'sEUR', ...]

// retrieve an object detailing the contract deployed to the given network.
snx.getTarget({ network: 'goerli', contract: 'ProxyTribeone' });
/*
{
	name: 'ProxyTribeone',
  address: '0x322A3346bf24363f451164d96A5b5cd5A7F4c337',
  source: 'Proxy',
  link: 'https://goerli.etherscan.io/address/0x322A3346bf24363f451164d96A5b5cd5A7F4c337',
  timestamp: '2019-03-06T23:05:43.914Z',
  txn: '',
	network: 'goerli'
}
*/

// retrieve the list of system user addresses
snx.getUsers({ network: 'mainnet' });
/*
[ { name: 'owner',
    address: '0xEb3107117FEAd7de89Cd14D463D340A2E6917769' },
  { name: 'deployer',
    address: '0x302d2451d9f47620374B54c521423Bf0403916A2' },
  { name: 'marketClosure',
    address: '0xC105Ea57Eb434Fbe44690d7Dec2702e4a2FBFCf7' },
  { name: 'oracle',
    address: '0xaC1ED4Fabbd5204E02950D68b6FC8c446AC95362' },
  { name: 'fee',
    address: '0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF' },
  { name: 'zero',
    address: '0x0000000000000000000000000000000000000000' } ]
*/

snx.getVersions();
/*
{ 'v2.21.12-107':
   { tag: 'v2.21.12-107',
     fulltag: 'v2.21.12-107',
     release: 'Hadar',
     network: 'goerli',
     date: '2020-05-08T12:52:06-04:00',
     commit: '19997724bc7eaceb902c523a6742e0bd74fc75cb',
		 contracts: { ReadProxyAddressResolver: [Object] }
		}
}
*/

snx.networks;
// [ 'local', 'goerli', 'mainnet' ]

snx.toBytes32('hUSD');
// '0x7355534400000000000000000000000000000000000000000000000000000000'
```

#### As a CLI tool

Same as above but as a CLI tool that outputs JSON, using names without the `get` prefixes:

```bash
$ npx tribeone ast contracts/Tribe.sol
{
  "imports": [
    "contracts/Owned.sol",
    "contracts/ExternStateToken.sol",
    "contracts/MixinResolver.sol",
    "contracts/interfaces/ITribe.sol",
    "contracts/interfaces/IERC20.sol",
    "contracts/interfaces/ISystemStatus.sol",
    "contracts/interfaces/IFeePool.sol",
    "contracts/interfaces/ITribeone.sol",
    "contracts/interfaces/IExchanger.sol",
    "contracts/interfaces/IIssue"
    # ...
  ]
}

$ npx tribeone bytes32 hUSD
0x7355534400000000000000000000000000000000000000000000000000000000

$ npx tribeone networks
[ 'local', 'goerli', 'mainnet' ]

$ npx tribeone source --network goerli --contract Proxy
{
  "bytecode": "0..0",
  "abi": [ ... ]
}

$ npx tribeone suspension-reason --code 2
Market Closure

$ npx tribeone tribes --network goerli --key name
["hUSD", "sEUR", ... ]

$ npx tribeone target --network goerli --contract ProxyTribeone
{
  "name": "ProxyTribeone",
  "address": "0x322A3346bf24363f451164d96A5b5cd5A7F4c337",
  "source": "Proxy",
  "link": "https://goerli.etherscan.io/address/0x322A3346bf24363f451164d96A5b5cd5A7F4c337",
  "timestamp": "2019-03-06T23:05:43.914Z",
  "network": "goerli"
}

$ npx tribeone users --network mainnet --user oracle
{
  "name": "oracle",
  "address": "0xaC1ED4Fabbd5204E02950D68b6FC8c446AC95362"
}

$ npx tribeone versions
{
  "v2.0-19": {
    "tag": "v2.0-19",
    "fulltag": "v2.0-19",
    "release": "",
    "network": "mainnet",
    "date": "2019-03-11T18:17:52-04:00",
    "commit": "eeb271f4fdd2e615f9dba90503f42b2cb9f9716e",
    "contracts": {
      "Depot": {
        "address": "0x172E09691DfBbC035E37c73B62095caa16Ee2388",
        "status": "replaced",
        "replaced_in": "v2.18.1"
      },
      "ExchangeRates": {
        "address": "0x73b172756BD5DDf0110Ba8D7b88816Eb639Eb21c",
        "status": "replaced",
        "replaced_in": "v2.1.11"
      },

      # ...

    }
  }
}

$ npx tribeone versions --by-contract
{
  "Depot": [
    {
      "address": "0x172E09691DfBbC035E37c73B62095caa16Ee2388",
      "status": "replaced",
      "replaced_in": "v2.18.1"
    },
    {
      "address": "0xE1f64079aDa6Ef07b03982Ca34f1dD7152AA3b86",
      "status": "current"
    }
  ],
  "ExchangeRates": [
    {
      "address": "0x73b172756BD5DDf0110Ba8D7b88816Eb639Eb21c",
      "status": "replaced",
      "replaced_in": "v2.1.11"
    },

    # ...
  ],

  # ...
}
```
