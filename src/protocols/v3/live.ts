import { type Address, type PublicClient } from 'viem';
import { type OpportunityEngine } from '../../opportunities/opportunity-engine';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { decodeV3PoolEvent, V3_POOL_EVENT_ABI } from './events';
import { loadConfiguredV3StartupState } from './runtime';
import { type V3PoolConfig, type V3Tick } from './types';

export class V3EventAdapter implements ProtocolEventAdapter {
  readonly id = 'v3';
  private readonly pools = new Map<string, V3PoolConfig>();

  constructor(
    private readonly client: PublicClient<any, any, any>,
    private readonly engine: OpportunityEngine,
    pools: readonly V3PoolConfig[],
    private readonly scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>
  ) {
    for (const pool of pools) this.pools.set(pool.address.toLowerCase(), pool);
  }

  async watch(client: PublicClient, onLogs: (logs: any[]) => void | Promise<void>, onError: (error: any) => void | Promise<void>) {
    if (this.pools.size === 0) return [];
    const unwatch = await client.watchContractEvent({
      address: [...this.pools.values()].map(pool => pool.address),
      abi: V3_POOL_EVENT_ABI,
      strict: true,
      onLogs,
      onError,
    });
    return [unwatch];
  }

  bufferKey(log: any): string | null {
    const key = log.address?.toLowerCase();
    if (!key || !this.pools.has(key)) return null;
    const decoded = decodeV3PoolEvent(log);
    return decoded && decoded.kind !== 'collect' ? key : null;
  }

  async reconcile(logs: readonly any[]): Promise<void> {
    const touched = new Map<string, V3PoolConfig>();
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      const pool = key ? this.pools.get(key) : undefined;
      if (pool) touched.set(key, pool);
    }
    if (touched.size > 0) await loadConfiguredV3StartupState(this.client, this.engine, [...touched.values()]);
  }

  async apply(logs: any[]): Promise<void> {
    const affected = new Map<string, Address>();
    for (const log of logs) {
      const key = log.address?.toLowerCase();
      const pool = key ? this.pools.get(key) : undefined;
      const decoded = pool ? decodeV3PoolEvent(log) : null;
      if (!pool || !decoded || decoded.kind === 'collect') continue;

      affected.set(key, pool.address);
      if (decoded.kind === 'swap') {
        this.engine.updateV3PoolStates([{ poolAddress: pool.address, ...decoded.update }]);
        continue;
      }

      this.applyLiquidityUpdate(pool.address, decoded.update);
      const live = this.findPool(pool.address)?.state;
      if (!live || live.tick < decoded.update.tickLower || live.tick >= decoded.update.tickUpper) continue;
      const liquidity = decoded.update.kind === 'mint'
        ? live.liquidity + decoded.update.amount
        : live.liquidity > decoded.update.amount ? live.liquidity - decoded.update.amount : 0n;
      this.engine.updateV3PoolStates([{
        poolAddress: pool.address,
        sqrtPriceX96: live.sqrtPriceX96,
        liquidity,
        tick: live.tick,
      }]);
    }

    if (affected.size === 0) return;
    await this.refreshWindows([...affected.values()]);
    await this.scan([...affected.keys()], [...affected.values()]);
  }

  private applyLiquidityUpdate(
    poolAddress: Address,
    update: { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint }
  ): void {
    const ticks = this.engine.getV3InitializedTicks(poolAddress);
    const grossDelta = update.kind === 'mint' ? update.amount : -update.amount;
    const lower = this.nextTick(ticks, update.tickLower, grossDelta, update.kind === 'mint' ? update.amount : -update.amount);
    const upper = this.nextTick(ticks, update.tickUpper, grossDelta, update.kind === 'mint' ? -update.amount : update.amount);
    const nextTicks = [lower, upper].filter((tick): tick is V3Tick => tick !== null);
    if (nextTicks.length > 0) this.engine.updateV3Ticks([{ poolAddress, ticks: nextTicks }]);
  }

  private nextTick(ticks: V3Tick[], index: number, grossDelta: bigint, netDelta: bigint): V3Tick | null {
    const current = ticks.find(tick => tick.index === index);
    if (!current && grossDelta < 0n) return null;
    return {
      index,
      liquidityGross: grossDelta < 0n && (current?.liquidityGross ?? 0n) < -grossDelta
        ? 0n
        : (current?.liquidityGross ?? 0n) + grossDelta,
      liquidityNet: (current?.liquidityNet ?? 0n) + netDelta,
    };
  }

  private findPool(address: Address) {
    return this.engine.getV3Pool(address) ?? undefined;
  }

  private async refreshWindows(addresses: readonly Address[]): Promise<void> {
    const refresh = addresses
      .map(address => this.pools.get(address.toLowerCase()))
      .filter((pool): pool is V3PoolConfig => Boolean(pool && this.engine.v3PoolNeedsRefresh(pool.address)));
    if (refresh.length > 0) await loadConfiguredV3StartupState(this.client, this.engine, refresh);
  }
}
