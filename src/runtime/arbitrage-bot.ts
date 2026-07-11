import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME } from '../constants';
import { EventMonitor } from '../event';
import { getKnownPairsInfo } from '../getinfo';
import { loadMarketSnapshot } from '../market-db';
import { CarbonStrategyStore } from '../market/carbon';
import { loadConfiguredV3StartupState } from '../market/v3-loader';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { createOpportunityScanner } from '../opportunities/opportunity-workflow';
import { LatestUpdateScheduler } from './event-scheduler';

type ScanUpdate = { key: string; releasedPairs: readonly Address[] };

export async function runArbitrageBot(): Promise<void> {
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Loading market metadata...');
  const { v2Pools, v3Pools, carbonPairs } = loadMarketSnapshot();

  if (v2Pools.length + v3Pools.length === 0) {
    throw new Error('Market database is empty. Run `bun run sync:markets` first.');
  }

  console.log(`Loaded ${v2Pools.length} V2 pools, ${v3Pools.length} V3 pools, and ${carbonPairs.length} Carbon pairs from SQLite`);

  console.log('Building arbitrage graph...');
  const graph = new OpportunityEngine(
    ARBITRAGE_SEARCH_POLICY,
    []
  );
  for (const pool of v3Pools) {
    graph.addV3Pool(pool);
  }
  const scanOpportunities = createOpportunityScanner(graph, network);
  const scanScheduler = new LatestUpdateScheduler<ScanUpdate>(
    async updates => {
      const releasedPairs = new Map<string, Address>();
      for (const update of updates) {
        for (const pair of update.releasedPairs) releasedPairs.set(pair.toLowerCase(), pair);
      }
      await scanOpportunities({
        changedPairs: updates.map(update => update.key),
        releasedPairs: [...releasedPairs.values()],
      });
    },
    update => update.key.toLowerCase()
  );
  const scheduleScan = (changedPairs: readonly string[], releasedPairs: readonly Address[] = []) =>
    scanScheduler.submit(changedPairs.map(key => ({ key, releasedPairs })));
  let startupReady = false;
  const carbonStore = new CarbonStrategyStore(
    network.wsClient ?? network.client,
    carbonPairs,
    async (strategies, changedPoolKeys, changedController) => {
      graph.setCarbonStrategies(strategies);
      if (!startupReady || changedPoolKeys.length === 0) return;
      await scheduleScan(changedPoolKeys, changedController ? [changedController] : []);
    }
  );

  const monitor = new EventMonitor(graph, network, {
    v2Pools,
    v3Pools: v3Pools.map(pool => pool.address),
    v3PoolConfigs: v3Pools,
    carbonStore: carbonPairs.length > 0 ? carbonStore : undefined,
    scan: scheduleScan,
  });

  console.log('Starting market event feed in buffering mode...');
  await monitor.startBuffering();

  try {
    console.log('Fetching live V2 reserves, V3 startup state, and Carbon strategies...');
    const hydrationStartedAtBlock = await network.client.getBlockNumber();
    const [pairs] = await Promise.all([
      getKnownPairsInfo(network.client, v2Pools),
      loadConfiguredV3StartupState(network.client, graph, v3Pools),
      carbonPairs.length > 0 ? carbonStore.loadAll() : Promise.resolve(),
    ]);
    const hydrationCompletedAtBlock = await network.client.getBlockNumber();
    console.log(`Initial live state fetched across blocks ${hydrationStartedAtBlock}-${hydrationCompletedAtBlock}`);

    if (RUNTIME.debug) console.log(`Loaded live reserves for ${pairs.length} V2 pairs`);
    if (carbonPairs.length > 0) console.log(`Loaded ${carbonStore.stats().strategyCount} live Carbon strategies`);

    for (const pair of pairs) graph.addPair(pair);

    console.log('Reconciling events received during startup...');
    await monitor.activate();
    startupReady = true;
  } catch (error) {
    await monitor.stop();
    throw error;
  }

  console.log('Searching for initial arbitrage opportunities...');
  await scanOpportunities();

  process.on('SIGINT', async () => {
    console.log('\nStopping event monitor...');
    await monitor.stop();
    process.exit();
  });
}
