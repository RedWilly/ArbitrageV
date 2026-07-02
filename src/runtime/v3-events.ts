import { parseAbiItem } from 'viem';

export const V3_SWAP_EVENT_ABI = [
  parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
];

export const V3_LIQUIDITY_EVENT_ABI = [
  parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
];

export const V3_POOL_EVENT_ABI = [
  ...V3_SWAP_EVENT_ABI,
  ...V3_LIQUIDITY_EVENT_ABI,
  parseAbiItem('event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'),
];
