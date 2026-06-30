import { type Address, parseAbi } from 'viem';
import { CONTRACTS, RUNTIME, V3_POOLS, V3_STARTUP_POLICY } from '../constants';
import { type OpportunityEngine } from '../opportunities/opportunity-engine';
import {
  type V3BitmapWord,
  type V3BitmapWordUpdate,
  type V3PoolConfig,
  type V3PoolStartupState,
  type V3PoolUpdate,
  type V3StartupPolicy,
  type V3Tick,
  type V3TickUpdate,
} from './v3-types';

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
