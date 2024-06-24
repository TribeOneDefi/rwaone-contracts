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
	if (symbol === 'wRWAX') {
		await _getRWAX({ ctx, user, amount });
	} else if (symbol === 'WETH') {
		await _getWETH({ ctx, user, amount });
	} else if (symbol === 'rUSD') {
		await _getrUSD({ ctx, user, amount });
	} else if (symbol === 'ETH') {
		await _getETHFromOtherUsers({ ctx, user, amount });
	} else {
		throw new Error(
			`Symbol ${symbol} not yet supported. TODO: Support via exchanging rUSD to other Tribes.`
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

async function _getRWAX({ ctx, user, amount }) {
	let { Rwaone } = ctx.contracts;

	const ownerTransferable = await Rwaone.transferableRwaone(ctx.users.owner.address);
	if (ownerTransferable.lt(amount)) {
		await _getRWAXForOwner({ ctx, amount: amount.sub(ownerTransferable) });
	}

	Rwaone = Rwaone.connect(ctx.users.owner);
	const tx = await Rwaone.transfer(user.address, amount);
	await tx.wait();
}

async function _getRWAXForOwner({ ctx, amount }) {
	if (!ctx.useOvm) {
		throw new Error('There is no more wRWAX!');
	} else {
		await _getRWAXForOwnerOnL2ByHackMinting({ ctx, amount });
	}
}

async function _getRWAXForOwnerOnL2ByHackMinting({ ctx, amount }) {
	const owner = ctx.users.owner;

	let { Rwaone, AddressResolver } = ctx.contracts;

	const bridgeName = toBytes32('RwaoneBridgeToBase');
	const bridgeAddress = await AddressResolver.getAddress(bridgeName);

	let tx;

	AddressResolver = AddressResolver.connect(owner);
	tx = await AddressResolver.importAddresses([bridgeName], [owner.address]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Rwaone.address]);
	await tx.wait();

	Rwaone = Rwaone.connect(owner);
	tx = await Rwaone.mintSecondary(owner.address, amount);
	await tx.wait();

	tx = await AddressResolver.importAddresses([bridgeName], [bridgeAddress]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Rwaone.address]);
	await tx.wait();
}

async function _getrUSD({ ctx, user, amount }) {
	let { Rwaone, TriberUSD } = ctx.contracts;

	let tx;

	const requiredRWAX = await _getRWAXAmountRequiredForrUSDAmount({ ctx, amount });
	// TODO: mul(12) is a temp workaround for "Amount too large" error.
	await ensureBalance({ ctx, symbol: 'wRWAX', user: ctx.users.owner, balance: requiredRWAX.mul(12) });

	Rwaone = Rwaone.connect(ctx.users.owner);
	tx = await Rwaone.issueTribes(amount);
	await tx.wait();

	TriberUSD = TriberUSD.connect(ctx.users.owner);
	tx = await TriberUSD.transfer(user.address, amount);
	await tx.wait();
}

async function _getRWAXAmountRequiredForrUSDAmount({ ctx, amount }) {
	const { Exchanger, SystemSettings } = ctx.contracts;

	const ratio = await SystemSettings.issuanceRatio();
	const collateral = ethers.utils.parseEther(amount.div(ratio).toString());

	const [expectedAmount, ,] = await Exchanger.getAmountsForExchange(
		collateral,
		toBytes32('rUSD'),
		toBytes32('wRWAX')
	);

	return expectedAmount;
}

function _getTokenFromSymbol({ ctx, symbol }) {
	if (symbol === 'wRWAX') {
		return ctx.contracts.Rwaone;
	} else if (symbol === 'WETH') {
		return ctx.contracts.WETH;
	} else {
		return ctx.contracts[`Tribe${symbol}`];
	}
}

module.exports = {
	ensureBalance,
};
