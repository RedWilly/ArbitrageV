import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, EXECUTION_POLICY, RUNTIME, TOKENS } from '../constants';
import { OpportunityManager } from '../execute';
import { type ExecutableOpportunity } from '../execution/execution-planner';
import { type NetworkConfig } from '../network';
import { basisPoints, formatBasisPoints, formatTokenAmountWithSymbol } from '../values';
import { type MarketProtocol } from '../market-graph/types';
import { type OpportunityEngine } from './opportunity-engine';
import {
  type ArbitrageSearchResult,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export type OpportunityWorkflowRequest = {
  changedPairs?: Address[];
};

let sharedManager: OpportunityManager | null = null;

export async function scanAndExecuteOpportunities(
  engine: OpportunityEngine,
  networkConfig: NetworkConfig,
  request: OpportunityWorkflowRequest = {}
): Promise<ArbitrageSearchResult> {
  const opportunities = engine.findOpportunities(createSearchRequest(request));
  logOpportunities(opportunities);

  const manager = opportunityManager(networkConfig);
  if (manager && opportunities.length > 0) {
    const executableOpportunities: ExecutableOpportunity[] = opportunities
      .map(opportunity => ({
        path: opportunity.path,
        pairs: opportunity.pairs,
        protocols: opportunity.protocols,
        fees: opportunity.fees,
        routeData: opportunity.routeData,
        optimalAmount: opportunity.optimalInput,
        expectedProfit: opportunity.profit,
      }))
      .filter((opportunity): opportunity is ExecutableOpportunity =>
        opportunity.protocols.length === opportunity.pairs.length &&
        opportunity.routeData.length === opportunity.pairs.length &&
        opportunity.protocols.every(isExecutableProtocol)
      );

    if (executableOpportunities.length === 0) return opportunities;

    manager.processOpportunities(engine, executableOpportunities).catch(error => {
      if (RUNTIME.debug) {
        console.error('Error processing opportunities:', error);
      }
    });
  }

  return opportunities;
}

function opportunityManager(networkConfig: NetworkConfig): OpportunityManager | null {
  if (!EXECUTION_POLICY.executeTrades) return null;

  if (!sharedManager) {
    sharedManager = new OpportunityManager(networkConfig);
    void sharedManager.warmNonce();
  }

  return sharedManager;
}

function createSearchRequest(request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
  const startTokens = TOKENS
    .slice(0, Math.min(ARBITRAGE_SEARCH_POLICY.topTokens, TOKENS.length))
    .map(addr => addr.address);

  if (RUNTIME.debug) {
    console.log(`Searching for arbitrage opportunities using ${startTokens.length} tokens simultaneously`);
    startTokens.forEach((token, i) => {
      console.log(`Token ${i + 1}: ${TOKENS[i].name} (${token})`);
    });
  }

  return {
    startTokens,
    changedPairs: request.changedPairs,
  };
}

function logOpportunities(opportunities: ArbitrageSearchResult): void {
  if (opportunities.length === 0) {
    if (RUNTIME.debug) console.log('No profitable arbitrage opportunities found');
    return;
  }

  console.log(`\nFound ${opportunities.length} potential arbitrage opportunities:`);

  opportunities.forEach((opportunity, index) => {
    if (!RUNTIME.debug) return;

    const { path, profit, pairs, fees, optimalInput } = opportunity;
    const routeKind = routeKindFromProtocols(opportunity.protocols);
    const profitBps = basisPoints(profit, optimalInput);
    const startToken = path[0];
    const startTokenInfo = TOKENS.find(addr => addr.address === startToken);
    if (!startTokenInfo) throw new Error(`Token info not found for ${startToken}`);

    const lastToken = path[path.length - 1];
    const lastTokenInfo = TOKENS.find(addr => addr.address === lastToken);
    if (!lastTokenInfo) throw new Error(`Token info not found for ${lastToken}`);

    console.log(`\nOpportunity #${index + 1}:`);
    console.log(`Path: ${path.join(' -> ')}`);
    console.log(`Expected profit: ${formatTokenAmountWithSymbol(profit, lastTokenInfo)}`);
    console.log(`Route type: ${routeKind}`);
    console.log(`Optimal input amount: ${optimalInput.toString()} wei || ${formatTokenAmountWithSymbol(optimalInput, startTokenInfo)}`);
    console.log(`Profit percentage: ${formatBasisPoints(profitBps)}%`);
    console.log(`Pairs used: ${pairs.join(', ')}`);
    console.log(`Fees: ${fees.map(fee => fee.toString()).join(', ')}`);
  });
}

function routeKindFromProtocols(protocols: MarketProtocol[]): 'v2' | 'v3' | 'carbon' | 'mixed' {
  if (protocols.length === 0) return 'mixed';
  return protocols.every(protocol => protocol === protocols[0]) ? protocols[0] : 'mixed';
}

function isExecutableProtocol(protocol: MarketProtocol): protocol is ExecutableOpportunity['protocols'][number] {
  return protocol === 'v2' || protocol === 'v3' || protocol === 'carbon';
}

