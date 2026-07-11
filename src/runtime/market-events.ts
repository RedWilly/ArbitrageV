import { decodeEventLog, parseAbiItem, type Address } from 'viem';
import { type V3PoolUpdate } from '../market/v3-types';

export const V2_SYNC_EVENT_ABI = [
  parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
  parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)'),
];

const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

const V3_SWAP_EVENT_ABI = [
  parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
];

const V3_LIQUIDITY_EVENT_ABI = [
  parseAbiItem('event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
  parseAbiItem('event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'),
];

export const V3_POOL_EVENT_ABI = [
  ...V3_SWAP_EVENT_ABI,
  ...V3_LIQUIDITY_EVENT_ABI,
  parseAbiItem('event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)'),
];

export const CARBON_CONTROLLER_EVENT_ABI = [
  parseAbiItem('event StrategyCreated(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)'),
  parseAbiItem('event StrategyDeleted(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)'),
  parseAbiItem('event StrategyUpdated(uint256 indexed id, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1, uint8 reason)'),
];

export type DecodedV3PoolEvent =
  | { kind: 'swap'; update: Omit<V3PoolUpdate, 'poolAddress'> }
  | { kind: 'liquidity'; update: { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint } }
  | { kind: 'collect' };

export type ChainCursor = {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
};

export function compareChainLogs(left: any, right: any): number {
  const block = compareLogField(left.blockNumber, right.blockNumber);
  if (block !== 0) return block;
  const transaction = compareLogField(left.transactionIndex, right.transactionIndex);
  return transaction !== 0 ? transaction : compareLogField(left.logIndex, right.logIndex);
}

export function chainLogBlockNumber(log: any): bigint {
  return logFieldToBigInt(log.blockNumber);
}

export function isLogAfterCursor(log: any, cursor: ChainCursor): boolean {
  const block = logFieldToBigInt(log.blockNumber);
  if (block !== cursor.blockNumber) return block > cursor.blockNumber;
  const transaction = logFieldToNumber(log.transactionIndex);
  return transaction !== cursor.transactionIndex
    ? transaction > cursor.transactionIndex
    : logFieldToNumber(log.logIndex) > cursor.logIndex;
}

export function advanceCursor(cursor: ChainCursor | undefined, log: any): ChainCursor {
  if (!cursor) {
    return {
      blockNumber: logFieldToBigInt(log.blockNumber),
      transactionIndex: logFieldToNumber(log.transactionIndex),
      logIndex: logFieldToNumber(log.logIndex),
    };
  }

  cursor.blockNumber = logFieldToBigInt(log.blockNumber);
  cursor.transactionIndex = logFieldToNumber(log.transactionIndex);
  cursor.logIndex = logFieldToNumber(log.logIndex);
  return cursor;
}

export function addressMap(addresses: readonly Address[]): Map<string, Address> {
  return new Map(addresses.map(address => [address.toLowerCase(), address]));
}

export function decodeV2SyncEvent(log: any): { reserve0: bigint; reserve1: bigint } | null {
  try {
    const topic = log.topics?.[0];
    if (topic === SYNC_TOPIC_UINT256) {
      const decoded = decodeEventLog({ abi: [V2_SYNC_EVENT_ABI[1]], data: log.data, topics: log.topics });
      return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
    }
    if (topic === SYNC_TOPIC_UINT112) {
      const decoded = decodeEventLog({ abi: [V2_SYNC_EVENT_ABI[0]], data: log.data, topics: log.topics });
      return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
    }
  } catch {}
  return null;
}

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

function compareLogField(left: unknown, right: unknown): number {
  const a = logFieldToBigInt(left);
  const b = logFieldToBigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function logFieldToBigInt(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(typeof value === 'number' ? value : 0);
}

function logFieldToNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(typeof value === 'bigint' ? value : 0);
}
