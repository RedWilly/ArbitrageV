import { RUNTIME } from '../constants';
import { EventMonitor } from '../event';
import { getAllPairsInfo } from '../getinfo';
import { loadConfiguredV3StartupState } from '../market/v3-loader';
import { initializeNetwork } from '../network';
import { OpportunityEngine } from '../opportunities/opportunity-engine';
import { OpportunityWorkflow } from '../opportunities/opportunity-workflow';
import { StartupEventBuffer } from './startup-event-buffer';

export async function runArbitrageBot(): Promise<void> {
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Building arbitrage graph...');
  const graph = new OpportunityEngine();
  const startupBuffer = new StartupEventBuffer(network);

  console.log('Buffering V3 startup events...');
  await startupBuffer.watchV3Pools(graph.getV3PoolAddresses());

  console.log('Fetching pairs information...');
  const pairs = await getAllPairsInfo(network.client);

  if (RUNTIME.debug) {
    console.log(`Found ${pairs.length} pairs`);
  }

  for (const pair of pairs) {
    graph.addPair(pair);
  }

  console.log('Buffering V2 startup events...');
  await startupBuffer.watchV2Pairs(graph.getPairAddresses());

  console.log('Loading configured V3 startup state...');
  await loadConfiguredV3StartupState(network.client, graph);

  console.log('Replaying buffered startup events...');
  const bufferedEvents = await startupBuffer.stop();
  graph.updateReserves(bufferedEvents.v2ReserveUpdates);
  graph.updateV3PoolStates(bufferedEvents.v3PoolUpdates);

  console.log('Searching for initial arbitrage opportunities...');
  await new OpportunityWorkflow(graph, network).scanAndExecute();

  console.log('\nStarting event monitor...');
  const monitor = new EventMonitor(graph, network);
  await monitor.start();

  process.on('SIGINT', async () => {
    console.log('\nStopping event monitor...');
    await monitor.stop();
    process.exit();
  });
}

