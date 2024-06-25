const ethers = require('ethers');
const { deposit } = require('./optimism');
const { toBytes32 } = require('../../..');

async function ensureBalance({ ctx, symbol, user, balance }) {
	const currentBalance = await _readBalance({ ctx, symbol, user });

	if (currentBalance.lt(balance)) {
		const amount = balance.sub(currentBalance);

		await _getAmount({ ctx, symbol, user, amount });
	}
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
	} else if (symbol === 'rETHBTC') {
		await _getRwa({ ctx, symbol, user, amount });
	} else if (symbol === 'rETH') {
		await _getRwa({ ctx, symbol, user, amount });
	} else if (symbol === 'ETH') {
		await _getETHFromOtherUsers({ ctx, user, amount });
	} else {
		throw new Error(
			`Symbol ${symbol} not yet supported. TODO: Support via exchanging rUSD to other Rwas.`
		);
	}

	// sanity check
	const newBalance = await _readBalance({ ctx, symbol, user });
	if (newBalance.lt(amount)) {
		throw new Error(`Failed to get required ${amount} ${symbol} for ${user.address}`);
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
	const { ProxyRwaone } = ctx.contracts;
	let { Rwaone } = ctx.contracts;

	// connect via proxy
	Rwaone = new ethers.Contract(ProxyRwaone.address, Rwaone.interface, ctx.provider);

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
		if (ctx.l1) {
			await _getRWAXForOwnerOnL2ByDepositing({ ctx: ctx.l1, amount });
		} else {
			await _getRWAXForOwnerOnL2ByHackMinting({ ctx, amount });
		}
	}
}

async function _getRWAXForOwnerOnL2ByDepositing({ ctx, amount }) {
	await deposit({ ctx, from: ctx.users.owner, to: ctx.users.owner, amount });
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
	const { ProxyRwaone, ProxyrUSD } = ctx.contracts;
	let { Rwaone, RwarUSD } = ctx.contracts;

	// connect via proxy
	Rwaone = new ethers.Contract(ProxyRwaone.address, Rwaone.interface, ctx.provider);
	RwarUSD = new ethers.Contract(ProxyrUSD.address, RwarUSD.interface, ctx.provider);

	let tx;

	const requiredRWAX = await _getRWAXAmountRequiredForrUSDAmount({ ctx, amount });
	await ensureBalance({ ctx, symbol: 'wRWAX', user, balance: requiredRWAX });

	Rwaone = Rwaone.connect(ctx.users.owner);

	const tmpWallet = await ethers.Wallet.createRandom().connect(ctx.provider);

	await _getETHFromOtherUsers({
		ctx,
		symbol: 'ETH',
		user: tmpWallet,
		amount: ethers.utils.parseEther('1'),
	});

	const availableOwnerRWAX = await Rwaone.transferableRwaone(ctx.users.owner.address);
	if (availableOwnerRWAX.lt(requiredRWAX.mul(2))) {
		await _getRWAXForOwner({ ctx, amount: requiredRWAX.mul(2).sub(availableOwnerRWAX) });
	}

	tx = await Rwaone.transfer(tmpWallet.address, requiredRWAX.mul(2));
	await tx.wait();

	tx = await Rwaone.connect(tmpWallet).issueRwas(amount);
	await tx.wait();

	tx = await RwarUSD.connect(tmpWallet).transfer(user.address, amount);
	await tx.wait();
}

async function _getRwa({ ctx, user, symbol, amount }) {
	let spent = ethers.utils.parseEther('0');
	let partialAmount = ethers.utils.parseEther('1000'); // choose a "reasonable" amount to start with

	let remaining = amount;

	const token = _getTokenFromSymbol({ ctx, symbol });

	// requiring from within function to prevent circular dependency
	const { exchangeRwas } = require('./exchanging');

	while (remaining.gt(0)) {
		await exchangeRwas({
			ctx,
			dest: symbol,
			src: 'rUSD',
			amount: partialAmount,
			user,
		});

		spent = spent.add(partialAmount);
		const newBalance = await token.balanceOf(user.address);

		if (newBalance.eq(0)) {
			throw new Error('received no rwas from exchange, did breaker trip? is rate set?');
		}

		remaining = amount.sub(newBalance);

		// estimate what more to send based on the rate we got for the first exchange
		partialAmount = spent.mul(remaining.add(remaining.div(10))).div(newBalance);
	}
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
		const { ProxyRwaone } = ctx.contracts;
		let { Rwaone } = ctx.contracts;

		// connect via proxy
		Rwaone = new ethers.Contract(ProxyRwaone.address, Rwaone.interface, ctx.provider);

		return Rwaone;
	} else if (symbol === 'WETH') {
		return ctx.contracts.WETH;
	} else {
		return ctx.contracts[`Rwa${symbol}`];
	}
}

module.exports = {
	ensureBalance,
};
