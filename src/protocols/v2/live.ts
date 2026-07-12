import { type Address, type PublicClient } from 'viem';
import { type OpportunityEngine } from '../../opportunities/opportunity-engine';
import { LatestUpdateScheduler } from '../../runtime/event-scheduler';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { decodeV2SyncEvent, V2_SYNC_EVENT_ABI } from './events';
import { refreshKnownPairsInfo, type V2PoolMetadata } from './market';
import { type ReserveUpdate } from './types';

export class V2EventAdapter implements ProtocolEventAdapter {
  readonly id = 'v2';
  private readonly pools = new Map<string, V2PoolMetadata>();
  private readonly scheduler: LatestUpdateScheduler<ReserveUpdate>;

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly engine: OpportunityEngine,
    pools: readonly V2PoolMetadata[],
    private readonly scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>
  ) {
    for (const pool of pools) this.pools.set(pool.pairAddress.toLowerCase(), pool);
    this.scheduler = new LatestUpdateScheduler(
      updates => this.applyUpdates(updates),
      update => update.pairAddress.toLowerCase()
    );
  }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    if (this.pools.size === 0) return [];
    const unwatch = await client.watchContractEvent({
      address: [...this.pools.values()].map(pool => pool.pairAddress),
      abi: V2_SYNC_EVENT_ABI,
      strict: true,
      onLogs,
      onError,
    });
    return [unwatch];
  }

  bufferKey(log: any): string | null {
    const key = log.address?.toLowerCase();
    return key && this.pools.has(key) ? key : null;
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    const touched = new Map<string, V2PoolMetadata>();
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      const pool = key ? this.pools.get(key) : undefined;
      if (pool) touched.set(key, pool);
    }
    const pairs = await refreshKnownPairsInfo(this.client, [...touched.values()]);
    for (const pair of pairs) this.engine.addPair(pair);
  }

  async apply(logs: any[]): Promise<void> {
    let count = 0;
    const updates = new Array<ReserveUpdate>(logs.length);
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      const pool = key ? this.pools.get(key) : undefined;
      const decoded = pool ? decodeV2SyncEvent(log) : null;
      if (pool && decoded) updates[count++] = { pairAddress: pool.pairAddress, ...decoded };
    }
    updates.length = count;
    if (count > 0) await this.scheduler.submit(updates);
  }

  clear(): void {
    this.scheduler.clear();
  }

  private async applyUpdates(updates: ReserveUpdate[]): Promise<void> {
    for (const update of updates) {
      const pool = this.pools.get(update.pairAddress.toLowerCase());
      if (!pool) continue;
      this.engine.addPair({
        pairAddress: pool.pairAddress,
        token0: pool.token0,
        token1: pool.token1,
        fee: pool.fee,
        reserve0: update.reserve0,
        reserve1: update.reserve1,
      });
    }
    await this.scan(updates.map(update => update.pairAddress), updates.map(update => update.pairAddress));
  }
}
