import { type Address, parseAbi, type PublicClient } from 'viem';
import { CONTRACTS, RUNTIME } from '../../constants';
import { V3_POOLS, V3_STARTUP_POLICY } from './config';
import { type OpportunityEngine } from '../../opportunities/opportunity-engine';
import { type ProtocolEventAdapter } from '../../runtime/protocol-event-adapter';
import { decodeV3PoolEvent, V3_POOL_EVENT_ABI } from './events';
import {
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolStartupState,
  type V3PoolUpdate,
  type V3StartupPolicy,
  type V3Tick,
  type V3TickUpdate,
} from './types';

const V3_STARTUP_ABI = parseAbi([
  'function getV3StartupStatesAroundCurrentTick(address[] pools, int24[] tickSpacings) view returns (((address pool, uint160 sqrtPriceX96, int24 tick, uint128 liquidity) live, (int16 wordPosition, uint256 bitmap)[] bitmaps, (int24 tick, uint128 liquidityGross, int128 liquidityNet, bool initialized)[] ticks)[])',
]);

type RawV3StartupState = any;
type RawV3BitmapWord = any;
type RawV3Tick = any;
type V3StartupClient = {
  readContract(parameters: any): Promise<unknown>;
};

export type V3StartupLoadResult = {
  configuredPools: number;
  loadedPools: number;
  loadedBitmapWords: number;
  loadedTicks: number;
};

export type V3StartupRequest = {
  poolAddresses: Address[];
  tickSpacings: number[];
};

export async function loadConfiguredV3StartupState(
  client: V3StartupClient,
  engine: OpportunityEngine,
  pools: readonly V3PoolConfig[] = V3_POOLS,
  policy: V3StartupPolicy = V3_STARTUP_POLICY
): Promise<V3StartupLoadResult> {
  const enabledPools = pools.filter(pool => pool.enabled);
  for (const pool of enabledPools) {
    engine.addV3Pool(pool);
  }

  if (enabledPools.length === 0) {
    return {
      configuredPools: 0,
      loadedPools: 0,
      loadedBitmapWords: 0,
      loadedTicks: 0,
    };
  }

  if (!CONTRACTS.flashQuery) {
    throw new Error('CONTRACTS.flashQuery is required to load configured V3 startup state.');
  }

  if (RUNTIME.debug) {
    console.log(`Loading V3 startup state for ${enabledPools.length} configured pools`);
  }

  const rawStates: RawV3StartupState[] = [];
  for (const request of buildV3StartupRequests(enabledPools, policy)) {
    const batchStates = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: V3_STARTUP_ABI,
      functionName: 'getV3StartupStatesAroundCurrentTick',
      args: [
        request.poolAddresses,
        request.tickSpacings,
      ],
    }) as RawV3StartupState[];

    rawStates.push(...batchStates);
  }

  const states = normalizeV3StartupStates(rawStates);
  applyV3StartupStates(engine, states);

  const loadedBitmapWords = states.reduce((total, state) => total + state.bitmapWords.length, 0);
  const loadedTicks = states.reduce((total, state) => total + state.ticks.filter(tick => tick.initialized).length, 0);

  if (RUNTIME.debug) {
    console.log(`Loaded V3 startup state for ${states.length}/${enabledPools.length} pools`);
  }

  return {
    configuredPools: enabledPools.length,
    loadedPools: states.length,
    loadedBitmapWords,
    loadedTicks,
  };
}

export function buildV3StartupRequests(
  pools: readonly V3PoolConfig[],
  policy: V3StartupPolicy
): V3StartupRequest[] {
  if (policy.batchSize <= 0) {
    throw new Error('V3 startup batchSize must be greater than zero.');
  }

  const enabledPools = pools.filter(pool => pool.enabled);
  const requests: V3StartupRequest[] = [];

  for (let start = 0; start < enabledPools.length; start += policy.batchSize) {
    const batch = enabledPools.slice(start, start + policy.batchSize);
    requests.push({
      poolAddresses: batch.map(pool => pool.address),
      tickSpacings: batch.map(pool => pool.tickSpacing),
    });
  }

  return requests;
}

export function applyV3StartupStates(
  engine: Pick<OpportunityEngine, 'updateV3PoolStates' | 'updateV3BitmapWords' | 'updateV3Ticks'>,
  states: V3PoolStartupState[]
): void {
  engine.updateV3PoolStates(toV3PoolUpdates(states));
  engine.updateV3BitmapWords(toV3BitmapWordUpdates(states));
  engine.updateV3Ticks(toV3TickUpdates(states));
}

export function toV3PoolUpdates(states: V3PoolStartupState[]): V3PoolUpdate[] {
  return states.map(state => ({
    poolAddress: state.poolAddress,
    sqrtPriceX96: state.sqrtPriceX96,
    liquidity: state.liquidity,
    tick: state.tick,
  }));
}

export function toV3BitmapWordUpdates(states: V3PoolStartupState[]): V3BitmapWordUpdate[] {
  return states.map(state => ({
    poolAddress: state.poolAddress,
    words: state.bitmapWords,
  }));
}

export function toV3TickUpdates(states: V3PoolStartupState[]): V3TickUpdate[] {
  return states.map(state => ({
    poolAddress: state.poolAddress,
    ticks: state.ticks
      .filter(tick => tick.initialized)
      .map(({ initialized, ...tick }) => tick),
  }));
}

export function normalizeV3StartupStates(rawStates: RawV3StartupState[]): V3PoolStartupState[] {
  return rawStates.map(rawState => {
    const live = field<any>(rawState, 'live', 0);
    const bitmapWords = field<RawV3BitmapWord[]>(rawState, 'bitmaps', 1) || [];
    const ticks = field<RawV3Tick[]>(rawState, 'ticks', 2) || [];

    return {
      poolAddress: field<Address>(live, 'pool', 0),
      sqrtPriceX96: BigInt(field<bigint>(live, 'sqrtPriceX96', 1)),
      tick: Number(field<number | bigint>(live, 'tick', 2)),
      liquidity: BigInt(field<bigint>(live, 'liquidity', 3)),
      bitmapWords: bitmapWords.map(normalizeBitmapWord),
      ticks: ticks.map(normalizeTick),
    };
  });
}

function normalizeBitmapWord(rawWord: RawV3BitmapWord): V3BitmapWord {
  return {
    wordPosition: Number(field<number | bigint>(rawWord, 'wordPosition', 0)),
    bitmap: BigInt(field<bigint>(rawWord, 'bitmap', 1)),
  };
}

function normalizeTick(rawTick: RawV3Tick): V3Tick & { initialized: boolean } {
  return {
    index: Number(field<number | bigint>(rawTick, 'tick', 0)),
    liquidityGross: BigInt(field<bigint>(rawTick, 'liquidityGross', 1)),
    liquidityNet: BigInt(field<bigint>(rawTick, 'liquidityNet', 2)),
    initialized: Boolean(field<boolean>(rawTick, 'initialized', 3)),
  };
}

function field<TValue>(value: any, name: string, index: number): TValue {
  if (value && typeof value === 'object' && name in value) return value[name] as TValue;
  return value[index] as TValue;
}

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
