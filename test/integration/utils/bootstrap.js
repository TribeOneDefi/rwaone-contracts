const hre = require('hardhat');
const ethers = require('ethers');
const { loadUsers } = require('./users');
const { connectContracts } = require('./contracts');
const { increaseStalePeriodAndCheckRatesAndCache } = require('./rates');
const { ensureBalance } = require('./balances');
const { setupOptimismWatchers, approveBridge } = require('./optimism');
const { ensureIssuance } = require('./issuance');

// const { startOpsHeartbeat } = require('./optimism-temp');

function bootstrapL1({ ctx }) {
	before('bootstrap layer 1 instance', async () => {
		ctx.useOvm = false;
		ctx.fork = hre.config.fork;

		ctx.addedRwas = hre.config.addedRwas || [];

		ctx.provider = _setupProvider({ url: `${hre.config.providerUrl}:${hre.config.providerPort}` });

		await loadUsers({ ctx });

		connectContracts({ ctx });

		if (ctx.fork) {
			for (const user of Object.values(ctx.users)) {
				await ensureBalance({ ctx, symbol: 'ETH', user, balance: ethers.utils.parseEther('50') });
			}
		}

		// Ensure issuance is not suspended for any reason
		await ensureIssuance({ ctx });

		if (ctx.fork) {
			await increaseStalePeriodAndCheckRatesAndCache({ ctx });
		}
	});
}

function bootstrapL2({ ctx }) {
	before('bootstrap layer 2 instance', async () => {
		ctx.useOvm = true;
		ctx.fork = hre.config.fork;

		ctx.addedRwas = hre.config.addedRwas || [];

		ctx.provider = _setupProvider({
			url: `${hre.config.providerUrl}:${hre.config.providerPortL2}`,
		});

		await loadUsers({ ctx });

		connectContracts({ ctx });

		// Ensure issuance is not suspended for any reason
		await ensureIssuance({ ctx });

		await increaseStalePeriodAndCheckRatesAndCache({ ctx });

		await ensureBalance({
			ctx,
			symbol: 'wRWAX',
			user: ctx.users.owner,
			balance: ethers.utils.parseEther('1000000'),
		});

		// this causes spurious nonce issues and should only be used when needed
		// if (!ctx.fork) {
		// 	startOpsHeartbeat({
		// 		l1Wallet: ctx.l1mock.users.user9,
		// 		l2Wallet: ctx.users.user9,
		// 	});
		// }
	});
}

function bootstrapDual({ ctx }) {
	before('bootstrap layer 1 and layer 2 instances', async () => {
		const addedRwas = hre.config.addedRwas || [];

		ctx.l1 = { useOvm: false, addedRwas };
		ctx.l2 = { useOvm: true, addedRwas };

		ctx.l2.l1 = ctx.l1;

		ctx.l1.provider = _setupProvider({
			url: `${hre.config.providerUrl}:${hre.config.providerPortL1}`,
		});
		ctx.l2.provider = _setupProvider({
			url: `${hre.config.providerUrl}:${hre.config.providerPortL2}`,
		});

		await setupOptimismWatchers({ ctx, providerUrl: hre.config.providerUrl });

		await loadUsers({ ctx: ctx.l1 });
		await loadUsers({ ctx: ctx.l2 });

		connectContracts({ ctx: ctx.l1 });
		connectContracts({ ctx: ctx.l2 });

		await increaseStalePeriodAndCheckRatesAndCache({ ctx: ctx.l1 });
		await increaseStalePeriodAndCheckRatesAndCache({ ctx: ctx.l2 });

		await approveBridge({ ctx: ctx.l1, amount: ethers.utils.parseEther('100000000') });

		await ensureBalance({
			ctx: ctx.l2,
			symbol: 'wRWAX',
			user: ctx.l2.users.owner,
			balance: ethers.utils.parseEther('1000000'),
		});

		// this causes spurious nonce issues and should only be used when needed
		/* await startOpsHeartbeat({
			l1Wallet: ctx.l1.users.user9,
			l2Wallet: ctx.l2.users.user9,
		}); */
	});
}

function _setupProvider({ url }) {
	return new ethers.providers.JsonRpcProvider({
		url,
		pollingInterval: 50,
		timeout: 1200000, // 20 minutes
	});
}

module.exports = {
	bootstrapL1,
	bootstrapL2,
	bootstrapDual,
};
