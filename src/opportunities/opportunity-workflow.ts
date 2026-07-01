import { type Address } from 'viem';
import { ARBITRAGE_SEARCH_POLICY, RUNTIME, TOKENS } from '../constants';
import { createOpportunityManager } from '../execute';
import { type NetworkConfig } from '../network';
import { basisPoints, formatBasisPoints, formatTokenAmountWithSymbol } from '../values';
import { type FlashPoolCandidate } from '../market-graph/types';
import {
  type ArbitrageSearchResult,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export type OpportunityWorkflowRequest = {
  changedPairs?: Address[];
};

type OpportunityEngine = {
  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult;
  findBestFlashPoolForToken(
    token: Address,
    amountIn: bigint,
    excludePools?: Address[]
  ): FlashPoolCandidate | null;
};

export class OpportunityWorkflow {
  constructor(
    private readonly engine: OpportunityEngine,
    private readonly networkConfig: NetworkConfig
  ) {}

  async scanAndExecute(request: OpportunityWorkflowRequest = {}): Promise<ArbitrageSearchResult> {
    const opportunities = this.engine.findOpportunities(this.createSearchRequest(request));

    this.log(opportunities);

    const executableOpportunities = opportunities.paths
      .map((path, index) => ({
        path,
        pairs: opportunities.pairs[index],
        protocols: opportunities.protocols[index],
        fees: opportunities.fees[index],
        optimalAmount: opportunities.optimalAmounts[index],
        expectedProfit: opportunities.profits[index],
        routeKind: opportunities.routeKinds[index],
      }))
      .filter(opportunity => opportunity.protocols.length === opportunity.pairs.length);

    if (executableOpportunities.length > 0) {
      const manager = createOpportunityManager(this.networkConfig);
      manager.processOpportunities(this.engine, executableOpportunities).catch(error => {
        if (RUNTIME.debug) {
          console.error('Error processing opportunities:', error);
        }
      });
    }

    return opportunities;
  }

  private createSearchRequest(request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
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

  private log(opportunities: ArbitrageSearchResult): void {
    if (opportunities.paths.length === 0) {
      if (RUNTIME.debug) console.log('No profitable arbitrage opportunities found');
      return;
    }

    console.log(`\nFound ${opportunities.paths.length} potential arbitrage opportunities:`);

    opportunities.paths.forEach((path, index) => {
      if (!RUNTIME.debug) return;

      const profit = opportunities.profits[index];
      const pairs = opportunities.pairs[index];
      const fees = opportunities.fees[index];
      const routeKind = opportunities.routeKinds[index];
      const optimalAmount = opportunities.optimalAmounts[index];
      const profitBps = basisPoints(profit, optimalAmount);
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
      console.log(`Optimal input amount: ${optimalAmount.toString()} wei || ${formatTokenAmountWithSymbol(optimalAmount, startTokenInfo)}`);
      console.log(`Profit percentage: ${formatBasisPoints(profitBps)}%`);
      console.log(`Pairs used: ${pairs.join(', ')}`);
      console.log(`Fees: ${fees.map(fee => fee.toString()).join(', ')}`);
    });
  }
}

