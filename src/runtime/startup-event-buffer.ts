import { decodeEventLog, type Address, type PublicClient } from 'viem';
import { RUNTIME } from '../constants';
import { type ReserveUpdate } from '../market/v2-types';
import { type V3PoolUpdate } from '../market/v3-types';
import { addressMap, decodeV2SyncEvent, V2_SYNC_EVENT_ABI } from './v2-events';
import { V3_POOL_EVENT_ABI } from './v3-events';

export type BufferedStartupEvents = {
  v2ReserveUpdates: ReserveUpdate[];
  v3PoolUpdates: V3PoolUpdate[];
  v3PoolsToRefresh: Address[];
};

type DecodedV3StartupEvent =
  | { kind: 'swap'; update: Omit<V3PoolUpdate, 'poolAddress'> }
  | { kind: 'liquidity' }
  | { kind: 'collect' };

export class StartupEventBuffer {
  private readonly client: PublicClient;
  private readonly v2Updates = new Map<string, ReserveUpdate>();
  private readonly v3Updates = new Map<string, V3PoolUpdate>();
  private readonly v3PoolsToRefresh = new Map<string, Address>();
  private readonly unwatchFns: Array<() => void | Promise<void>> = [];

  constructor(networkConfig: any) {
    this.client = networkConfig.wsClient ?? networkConfig.client;
  }

  async watchV2Pairs(pairAddresses: Address[]): Promise<void> {
    if (pairAddresses.length === 0) return;

    const pairsByAddress = addressMap(pairAddresses);
    const unwatch = await this.client.watchContractEvent({
      address: pairAddresses,
      abi: V2_SYNC_EVENT_ABI,
      strict: true,
      onLogs: logs => {
        for (const log of logs) {
          const pairAddress = pairsByAddress.get(log.address?.toLowerCase() ?? '');
          const decoded = pairAddress ? decodeV2SyncEvent(log) : null;
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

    const poolsByAddress = addressMap(poolAddresses);
    const unwatch = await this.client.watchContractEvent({
      address: poolAddresses,
      abi: V3_POOL_EVENT_ABI,
      strict: true,
      onLogs: logs => {
        for (const log of logs) {
          const poolAddress = poolsByAddress.get(log.address?.toLowerCase() ?? '');
          const decoded = poolAddress ? this.decodeV3StartupEvent(log) : null;
          if (!poolAddress || !decoded) continue;

          if (decoded.kind === 'swap') {
            this.v3Updates.set(poolAddress.toLowerCase(), { poolAddress, ...decoded.update });
          } else if (decoded.kind === 'liquidity') {
            this.v3PoolsToRefresh.set(poolAddress.toLowerCase(), poolAddress);
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
      v3PoolsToRefresh: Array.from(this.v3PoolsToRefresh.values()),
    };
  }

  private decodeV3StartupEvent(log: any): DecodedV3StartupEvent | null {
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
        return { kind: 'liquidity' };
      }

      return { kind: 'collect' };
    } catch (error) {
      // console.error('Failed to decode startup V3 pool event:', error);
      return null;
    }
  }
}
