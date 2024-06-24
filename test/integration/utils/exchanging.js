const ethers = require('ethers');
const { ensureBalance } = require('./balances');
const { toBytes32 } = require('../../../index');
const { updateCache } = require('../utils/rates');
const { skipWaitingPeriod } = require('../utils/skip');

async function exchangeSomething({ ctx }) {
	let { Rwaone } = ctx.contracts;
	Rwaone = Rwaone.connect(ctx.users.owner);

	const rUSDAmount = ethers.utils.parseEther('10');
	await ensureBalance({ ctx, symbol: 'rUSD', user: ctx.users.owner, balance: rUSDAmount });

	await updateCache({ ctx });

	const tx = await Rwaone.exchange(toBytes32('rUSD'), rUSDAmount, toBytes32('rETH'));
	await tx.wait();
}

async function exchangeTribes({ ctx, src, dest, amount, user }) {
	let { Rwaone, CircuitBreaker } = ctx.contracts;
	const { ExchangeRates } = ctx.contracts;
	Rwaone = Rwaone.connect(user);
	CircuitBreaker = CircuitBreaker.connect(ctx.users.owner);

	await ensureBalance({ ctx, symbol: src, user, balance: amount });

	// ensure that circuit breaker wont get in he way
	const oracles = [
		await ExchangeRates.aggregators(toBytes32(src)),
		await ExchangeRates.aggregators(toBytes32(dest)),
	].filter(o => o !== ethers.constants.AddressZero);
	let tx = await CircuitBreaker.resetLastValue(
		oracles,
		oracles.map(() => 0)
	);

	tx = await Rwaone.exchange(toBytes32(src), amount, toBytes32(dest));
	await tx.wait();

	await skipWaitingPeriod({ ctx });

	tx = await Rwaone.settle(toBytes32(dest));
	await tx.wait();
}

module.exports = {
	exchangeSomething,
	exchangeTribes,
};
