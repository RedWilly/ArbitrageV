import { decodeEventLog, parseAbiItem, type Address, type PublicClient } from 'viem';
import { RUNTIME } from '../constants';
import { type ReserveUpdate } from '../market/v2-types';
import { type V3PoolUpdate } from '../market/v3-types';

const SYNC_EVENT_ABI = [
  parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
  parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)'),
];

const V3_SWAP_EVENT_ABI = [
  parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
];

const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

export type BufferedStartupEvents = {
  v2ReserveUpdates: ReserveUpdate[];
  v3PoolUpdates: V3PoolUpdate[];
};

export class StartupEventBuffer {
  private readonly client: PublicClient;
  private readonly v2Updates = new Map<string, ReserveUpdate>();
  private readonly v3Updates = new Map<string, V3PoolUpdate>();
  private readonly unwatchFns: Array<() => void | Promise<void>> = [];

  constructor(networkConfig: any) {
    this.client = networkConfig.wsClient ?? networkConfig.client;
  }

  async watchV2Pairs(pairAddresses: Address[]): Promise<void> {
    if (pairAddresses.length === 0) return;

    const addressMap = this.addressMap(pairAddresses);
    const unwatch = await this.client.watchContractEvent({
      address: pairAddresses,
      abi: SYNC_EVENT_ABI,
      strict: true,
      onLogs: logs => {
        for (const log of logs) {
          const pairAddress = addressMap.get(log.address?.toLowerCase() ?? '');
          const decoded = pairAddress ? this.decodeSync(log) : null;
          if (pairAddress && decoded) {
            this.v2Updates.set(pairAddress.toLowerCase(), { pairAddress, ...decoded });
          }
        }
      },
      onError: error => console.error('Startup V2 event buffer error:', error),
    });

    this.unwatchFns.push(unwatch);
    if (RUNTIME.debug) console.log(`Startup buffer watching ${pairAddresses.length} V2 pairs`);
  }

  async watchV3Pools(poolAddresses: Address[]): Promise<void> {
    if (poolAddresses.length === 0) return;

    const addressMap = this.addressMap(poolAddresses);
    const unwatch = await this.client.watchContractEvent({
      address: poolAddresses,
      abi: V3_SWAP_EVENT_ABI,
      strict: true,
      onLogs: logs => {
        for (const log of logs) {
          const poolAddress = addressMap.get(log.address?.toLowerCase() ?? '');
          const decoded = poolAddress ? this.decodeV3Swap(log) : null;
          if (poolAddress && decoded) {
            this.v3Updates.set(poolAddress.toLowerCase(), { poolAddress, ...decoded });
          }
        }
      },
      onError: error => console.error('Startup V3 event buffer error:', error),
    });

    this.unwatchFns.push(unwatch);
    if (RUNTIME.debug) console.log(`Startup buffer watching ${poolAddresses.length} V3 pools`);
  }

  async stop(): Promise<BufferedStartupEvents> {
    for (const unwatch of this.unwatchFns) {
      await unwatch();
    }

    this.unwatchFns.length = 0;
    return {
      v2ReserveUpdates: Array.from(this.v2Updates.values()),
      v3PoolUpdates: Array.from(this.v3Updates.values()),
    };
  }

  private addressMap(addresses: Address[]): Map<string, Address> {
    return new Map(addresses.map(address => [address.toLowerCase(), address]));
  }

  private decodeSync(log: any): { reserve0: bigint; reserve1: bigint } | null {
    try {
      const topic = log.topics?.[0];
      if (topic === SYNC_TOPIC_UINT256) {
        const decoded = decodeEventLog({ abi: [SYNC_EVENT_ABI[1]], data: log.data, topics: log.topics });
        return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
      }

      if (topic === SYNC_TOPIC_UINT112) {
        const decoded = decodeEventLog({ abi: [SYNC_EVENT_ABI[0]], data: log.data, topics: log.topics });
        return { reserve0: decoded.args.reserve0, reserve1: decoded.args.reserve1 };
      }
    } catch (error) {
      console.error('Failed to decode startup Sync event:', error);
    }

    return null;
  }

  private decodeV3Swap(log: any): Omit<V3PoolUpdate, 'poolAddress'> | null {
    try {
      const decoded = decodeEventLog({ abi: V3_SWAP_EVENT_ABI, data: log.data, topics: log.topics });
      return {
        sqrtPriceX96: decoded.args.sqrtPriceX96,
        liquidity: decoded.args.liquidity,
        tick: Number(decoded.args.tick),
      };
    } catch (error) {
      console.error('Failed to decode startup V3 Swap event:', error);
      return null;
    }
  }
}
