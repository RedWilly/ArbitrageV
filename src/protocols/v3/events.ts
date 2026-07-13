import { decodeEventLog, parseAbiItem } from 'viem';
import { type V3PoolUpdate } from './types';

export const V3_POOL_EVENT_ABI = [
  parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
  parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  parseAbiItem('event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'),
];

export type DecodedV3PoolEvent =
  | { kind: 'swap'; update: Omit<V3PoolUpdate, 'poolAddress'> }
  | { kind: 'liquidity'; update: { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint } }
  | { kind: 'collect' };

export function decodeV3PoolEvent(log: any): DecodedV3PoolEvent | null {
  try {
    const decoded = decodeEventLog({ abi: V3_POOL_EVENT_ABI, data: log.data, topics: log.topics });
    if (decoded.eventName === 'Swap') {
      return {
        kind: 'swap',
        update: {
          sqrtPriceX96: decoded.args.sqrtPriceX96,
          liquidity: decoded.args.liquidity,
          tick: Number(decoded.args.tick),
        },
      };
    }
    if (decoded.eventName === 'Mint' || decoded.eventName === 'Burn') {
      return {
        kind: 'liquidity',
        update: {
          kind: decoded.eventName === 'Mint' ? 'mint' : 'burn',
          tickLower: Number(decoded.args.tickLower),
          tickUpper: Number(decoded.args.tickUpper),
          amount: decoded.args.amount,
        },
      };
    }
    return { kind: 'collect' };
  } catch {
    return null;
  }
}
