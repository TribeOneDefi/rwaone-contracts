const { bootstrapL1 } = require('../utils/bootstrap');
const { itCanRedeem } = require('../behaviors/redeem.behavior');

describe('Redemption integration tests (L1)', () => {
	const ctx = this;
	bootstrapL1({ ctx });

	before('check fork', async function () {
		if (ctx.fork) {
			// this will fail on a fork since rBTC or rETH can't be removed because
			// the debt may be too large for removeRwa to not underflow during debt update
			this.skip();
		}
	});

	itCanRedeem({ ctx });
});
