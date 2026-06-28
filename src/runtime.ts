import { RUNTIME } from './constants';
import { EventMonitor } from './event';
import { getAllPairsInfo } from './getinfo';
import { V2ArbitrageEngine } from './arbitrage';
import { OpportunityWorkflow } from './arbitrage/opportunity-workflow';
import { initializeNetwork } from './network';

export async function runArbitrageBot(): Promise<void> {
  console.log('Initializing network...');
  const network = await initializeNetwork();

  console.log('Fetching pairs information...');
  const pairs = await getAllPairsInfo(network.client);

  if (RUNTIME.debug) {
    console.log(`Found ${pairs.length} pairs`);
  }

  console.log('Building arbitrage graph...');
  const graph = new V2ArbitrageEngine();
  for (const pair of pairs) {
    graph.addPair(pair);
  }

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

