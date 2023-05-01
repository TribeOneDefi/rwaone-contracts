const { bootstrapL1 } = require('../utils/bootstrap');
const { itBehavesLikeAnERC20 } = require('../behaviors/erc20.behavior');

describe('SynthuUSD integration tests (L1)', () => {
	const ctx = this;
	bootstrapL1({ ctx });

	itBehavesLikeAnERC20({ ctx, contract: 'SynthuUSD' });
});
