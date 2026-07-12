import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME } from '../constants';
import { EventMonitor } from '../event';
import { loadMarketSnapshot } from '../market-db';
import { CarbonStrategyStore } from '../market/carbon';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { createOpportunityScanner } from '../opportunities/opportunity-workflow';
import { createProtocolPlugins, PROTOCOL_PLUGINS } from '../protocols/registry';
import { LatestUpdateScheduler } from './event-scheduler';

type ScanUpdate = { key: string; releasedPairs: readonly Address[] };

export async function runArbitrageBot(): Promise<void> {
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Loading market metadata...');
  const catalog = loadMarketSnapshot();
  const { v2Pools, v3Pools, carbonPairs } = catalog;

  if (v2Pools.length + v3Pools.length === 0) {
    throw new Error('Market database is empty. Run `bun run sync:markets` first.');
  }

  console.log(`Loaded ${PROTOCOL_PLUGINS.map(plugin => `${plugin.count(catalog)} ${plugin.id}`).join(', ')} markets from SQLite`);

  console.log('Building arbitrage graph...');
  const graph = new OpportunityEngine(
    ARBITRAGE_SEARCH_POLICY,
    []
  );
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
  const runtimePlugins = createProtocolPlugins(carbonPairs.length > 0 ? carbonStore : undefined);

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
    await Promise.all(runtimePlugins.map(plugin => plugin.hydrate({
      client: network.client,
      catalog,
      engine: graph,
    })));
    const hydrationCompletedAtBlock = await network.client.getBlockNumber();
    console.log(`Initial live state fetched across blocks ${hydrationStartedAtBlock}-${hydrationCompletedAtBlock}`);

    if (RUNTIME.debug) console.log(`Loaded live state for ${runtimePlugins.map(plugin => plugin.id).join(', ')}`);
    if (carbonPairs.length > 0) console.log(`Loaded ${carbonStore.stats().strategyCount} live Carbon strategies`);

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
