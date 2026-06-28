import { type Address } from 'viem';
import { OpportunityWorkflow } from './arbitrage';
import { ArbitrageGraph } from './graph';
import { type NetworkConfig } from './network';

type OpportunitySearchOptions = {
  affectedPairs?: Address[];
};

export function findAndLogArbitrageOpportunities(
  graph: ArbitrageGraph,
  networkConfig: NetworkConfig,
  options: OpportunitySearchOptions = {}
) {
  return new OpportunityWorkflow(graph, networkConfig).scanAndExecute({
    changedPairs: options.affectedPairs,
  });
}
