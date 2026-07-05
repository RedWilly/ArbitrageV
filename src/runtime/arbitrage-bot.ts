import { ARBITRAGE_SEARCH_POLICY, RUNTIME } from '../constants';
import { EventMonitor } from '../event';
import { getKnownPairsInfo } from '../getinfo';
import { loadStoredCarbonPairs, loadStoredPools, openMarketDb, storedV2Pools, storedV3Pools } from '../market-db';
import { CarbonStrategyStore } from '../market/carbon';
import { loadConfiguredV3StartupState } from '../market/v3-loader';
import { type PairInfo, type ReserveUpdate } from '../market/v2-types';
import { MarketGraph } from '../market-graph/market-graph';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { OpportunityWorkflow } from '../opportunities/opportunity-workflow';
import { StartupEventBuffer } from './startup-event-buffer';

export async function runArbitrageBot(): Promise<void> {
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Loading market metadata...');
  const db = openMarketDb();
  const storedPools = loadStoredPools(db);
  const carbonPairs = loadStoredCarbonPairs(db);
  db.close();

  if (storedPools.length === 0) {
    throw new Error('Market database is empty. Run `bun run sync:markets` first.');
  }

  const v2Pools = storedV2Pools(storedPools);
  const v3Pools = storedV3Pools(storedPools);
  const v2PoolByAddress = new Map(v2Pools.map(pool => [pool.pairAddress.toLowerCase(), pool]));

  console.log(`Loaded ${v2Pools.length} V2 pools, ${v3Pools.length} V3 pools, and ${carbonPairs.length} Carbon pairs from SQLite`);

  console.log('Building arbitrage graph...');
  const graph = new OpportunityEngine(
    ARBITRAGE_SEARCH_POLICY,
    new MarketGraph(ARBITRAGE_SEARCH_POLICY, [])
  );
  for (const pool of v3Pools) {
    graph.addV3Pool(pool);
  }
  const carbonStore = new CarbonStrategyStore(
    network.client,
    carbonPairs,
    strategies => graph.setCarbonStrategies(strategies)
  );

  const startupBuffer = new StartupEventBuffer(network);

  console.log('Buffering startup events...');
  await startupBuffer.watchV2Pairs(v2Pools.map(pool => pool.pairAddress));
  await startupBuffer.watchV3Pools(v3Pools.map(pool => pool.address));

  console.log('Fetching live V2 reserves, V3 startup state, and Carbon strategies...');
  const [pairs] = await Promise.all([
    getKnownPairsInfo(network.client, v2Pools),
    loadConfiguredV3StartupState(network.client, graph, v3Pools),
    carbonPairs.length > 0 ? carbonStore.start() : Promise.resolve(),
  ]);

  if (RUNTIME.debug) console.log(`Loaded live reserves for ${pairs.length} V2 pairs`);
  if (carbonPairs.length > 0) console.log(`Loaded ${carbonStore.strategyCount()} live Carbon strategies`);

  for (const pair of pairs) {
    graph.addPair(pair);
  }

  console.log('Replaying buffered startup events...');
  const bufferedEvents = await startupBuffer.stop();
  const v3RefreshPools = new Set(bufferedEvents.v3PoolsToRefresh.map(address => address.toLowerCase()));
  applyBufferedV2Updates(graph, bufferedEvents.v2ReserveUpdates, v2PoolByAddress);
  graph.updateV3PoolStates(
    bufferedEvents.v3PoolUpdates.filter(update => !v3RefreshPools.has(update.poolAddress.toLowerCase()))
  );

  if (bufferedEvents.v3PoolsToRefresh.length > 0) {
    console.log(`Refreshing ${bufferedEvents.v3PoolsToRefresh.length} V3 pools touched by startup liquidity events...`);
    await loadConfiguredV3StartupState(
      network.client,
      graph,
      v3Pools.filter(pool => v3RefreshPools.has(pool.address.toLowerCase()))
    );
  }

  console.log('Searching for initial arbitrage opportunities...');
  await new OpportunityWorkflow(graph, network).scanAndExecute();

  console.log('\nStarting event monitor...');
  const monitor = new EventMonitor(graph, network, {
    v2Pools,
    v3Pools: v3Pools.map(pool => pool.address),
  });
  await monitor.start();

  process.on('SIGINT', async () => {
    console.log('\nStopping event monitor...');
    await monitor.stop();
    await carbonStore.stop();
    process.exit();
  });
}

function applyBufferedV2Updates(
  graph: OpportunityEngine,
  updates: readonly ReserveUpdate[],
  metadata: ReadonlyMap<string, {
    pairAddress: PairInfo['pairAddress'];
    token0: PairInfo['token0'];
    token1: PairInfo['token1'];
    fee: PairInfo['fee'];
  }>
): void {
  if (updates.length === 0) return;

  for (const update of updates) {
    const pool = metadata.get(update.pairAddress.toLowerCase());
    if (!pool) continue;

    // ponytail: addPair is the shortest way to make buffered events create or overwrite V2 state.
    graph.addPair({
      pairAddress: pool.pairAddress,
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      reserve0: update.reserve0,
      reserve1: update.reserve1,
    });
  }
}

