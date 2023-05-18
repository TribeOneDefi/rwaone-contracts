const ethers = require('ethers');
const { toBytes32 } = require('../..');

async function ensureBalance({ ctx, symbol, user, balance }) {
	const currentBalance = await _readBalance({ ctx, symbol, user });
	console.log(`${symbol} old=${ethers.utils.formatEther(currentBalance)}`);

	if (currentBalance.lt(balance)) {
		const amount = balance.sub(currentBalance);

		await _getAmount({ ctx, symbol, user, amount });
	}

	const newBalance = await _readBalance({ ctx, symbol, user });
	console.log(`${symbol} new=${ethers.utils.formatEther(newBalance)}`);
}

async function _readBalance({ ctx, symbol, user }) {
	if (symbol !== 'ETH') {
		const token = _getTokenFromSymbol({ ctx, symbol });

		return token.balanceOf(user.address);
	} else {
		return ctx.provider.getBalance(user.address);
	}
}

async function _getAmount({ ctx, symbol, user, amount }) {
	if (symbol === 'wHAKA') {
		await _getHAKA({ ctx, user, amount });
	} else if (symbol === 'WETH') {
		await _getWETH({ ctx, user, amount });
	} else if (symbol === 'hUSD') {
		await _gethUSD({ ctx, user, amount });
	} else if (symbol === 'ETH') {
		await _getETHFromOtherUsers({ ctx, user, amount });
	} else {
		throw new Error(
			`Symbol ${symbol} not yet supported. TODO: Support via exchanging hUSD to other Tribes.`
		);
	}
}

async function _getETHFromOtherUsers({ ctx, user, amount }) {
	for (const otherUser of Object.values(ctx.users)) {
		if (otherUser.address === user.address) {
			continue;
		}

		const otherUserBalance = await ctx.provider.getBalance(otherUser.address);
		if (otherUserBalance.gte(ethers.utils.parseEther('1000'))) {
			const tx = await otherUser.sendTransaction({
				to: user.address,
				value: amount,
			});

			await tx.wait();

			return;
		}
	}

	throw new Error('Unable to get ETH');
}

async function _getWETH({ ctx, user, amount }) {
	const ethBalance = await ctx.provider.getBalance(user.address);
	if (ethBalance.lt(amount)) {
		const needed = amount.sub(ethBalance);

		await _getETHFromOtherUsers({ ctx, user, amount: needed });
	}

	let { WETH } = ctx.contracts;
	WETH = WETH.connect(user);

	const tx = await WETH.deposit({
		value: amount,
	});

	await tx.wait();
}

async function _getHAKA({ ctx, user, amount }) {
	let { Tribeone } = ctx.contracts;

	const ownerTransferable = await Tribeone.transferableTribeone(ctx.users.owner.address);
	if (ownerTransferable.lt(amount)) {
		await _getHAKAForOwner({ ctx, amount: amount.sub(ownerTransferable) });
	}

	Tribeone = Tribeone.connect(ctx.users.owner);
	const tx = await Tribeone.transfer(user.address, amount);
	await tx.wait();
}

async function _getHAKAForOwner({ ctx, amount }) {
	if (!ctx.useOvm) {
		throw new Error('There is no more wHAKA!');
	} else {
		await _getHAKAForOwnerOnL2ByHackMinting({ ctx, amount });
	}
}

async function _getHAKAForOwnerOnL2ByHackMinting({ ctx, amount }) {
	const owner = ctx.users.owner;

	let { Tribeone, AddressResolver } = ctx.contracts;

	const bridgeName = toBytes32('TribeoneBridgeToBase');
	const bridgeAddress = await AddressResolver.getAddress(bridgeName);

	let tx;

	AddressResolver = AddressResolver.connect(owner);
	tx = await AddressResolver.importAddresses([bridgeName], [owner.address]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Tribeone.address]);
	await tx.wait();

	Tribeone = Tribeone.connect(owner);
	tx = await Tribeone.mintSecondary(owner.address, amount);
	await tx.wait();

	tx = await AddressResolver.importAddresses([bridgeName], [bridgeAddress]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Tribeone.address]);
	await tx.wait();
}

async function _gethUSD({ ctx, user, amount }) {
	let { Tribeone, TribehUSD } = ctx.contracts;

	let tx;

	const requiredHAKA = await _getHAKAAmountRequiredForhUSDAmount({ ctx, amount });
	// TODO: mul(12) is a temp workaround for "Amount too large" error.
	await ensureBalance({ ctx, symbol: 'wHAKA', user: ctx.users.owner, balance: requiredHAKA.mul(12) });

	Tribeone = Tribeone.connect(ctx.users.owner);
	tx = await Tribeone.issueTribes(amount);
	await tx.wait();

	TribehUSD = TribehUSD.connect(ctx.users.owner);
	tx = await TribehUSD.transfer(user.address, amount);
	await tx.wait();
}

async function _getHAKAAmountRequiredForhUSDAmount({ ctx, amount }) {
	const { Exchanger, SystemSettings } = ctx.contracts;

	const ratio = await SystemSettings.issuanceRatio();
	const collateral = ethers.utils.parseEther(amount.div(ratio).toString());

	const [expectedAmount, ,] = await Exchanger.getAmountsForExchange(
		collateral,
		toBytes32('hUSD'),
		toBytes32('wHAKA')
	);

	return expectedAmount;
}

function _getTokenFromSymbol({ ctx, symbol }) {
	if (symbol === 'wHAKA') {
		return ctx.contracts.Tribeone;
	} else if (symbol === 'WETH') {
		return ctx.contracts.WETH;
	} else {
		return ctx.contracts[`Tribe${symbol}`];
	}
}

module.exports = {
	ensureBalance,
};
