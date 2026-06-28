import { formatUnits, type Address } from 'viem';
import { ADDRESSES, DEBUG, V2_SEARCH_POLICY } from '../constants';
import { createOpportunityManager } from '../execute';
import { type NetworkConfig } from '../network';
import { type ArbitrageSearchResult, type FindOpportunitiesRequest } from './types';

export type OpportunityWorkflowRequest = {
  changedPairs?: Address[];
};

type OpportunityEngine = {
  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult;
  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs?: Address[]
  ): { pairAddress: Address; fee: number } | null;
};

export class OpportunityWorkflow {
  constructor(
    private readonly engine: OpportunityEngine,
    private readonly networkConfig: NetworkConfig
  ) {}

  async scanAndExecute(request: OpportunityWorkflowRequest = {}): Promise<ArbitrageSearchResult> {
    const opportunities = this.engine.findOpportunities(this.createSearchRequest(request));

    this.log(opportunities);

    if (opportunities.paths.length > 0) {
      const manager = createOpportunityManager(this.networkConfig);
      manager.processOpportunities(this.engine, opportunities.paths.map((path, index) => ({
        path,
        pairs: opportunities.pairs[index],
        fees: opportunities.fees[index],
        optimalAmount: opportunities.optimalAmounts[index],
        expectedProfit: opportunities.profits[index],
      }))).catch(error => {
        if (DEBUG) {
          console.error('Error processing opportunities:', error);
        }
      });
    }

    return opportunities;
  }

  private createSearchRequest(request: OpportunityWorkflowRequest): FindOpportunitiesRequest {
    const startTokens = ADDRESSES
      .slice(0, Math.min(V2_SEARCH_POLICY.topTokens, ADDRESSES.length))
      .map(addr => addr.address);

    if (DEBUG) {
      console.log(`Searching for arbitrage opportunities using ${startTokens.length} tokens simultaneously`);
      startTokens.forEach((token, i) => {
        console.log(`Token ${i + 1}: ${ADDRESSES[i].name} (${token})`);
      });
    }

    return {
      startTokens,
      changedPairs: request.changedPairs,
    };
  }

  private log(opportunities: ArbitrageSearchResult): void {
    if (opportunities.paths.length === 0) {
      if (DEBUG) console.log('No profitable arbitrage opportunities found');
      return;
    }

    console.log(`\nFound ${opportunities.paths.length} potential arbitrage opportunities:`);

    opportunities.paths.forEach((path, index) => {
      if (!DEBUG) return;

      const profit = opportunities.profits[index];
      const pairs = opportunities.pairs[index];
      const fees = opportunities.fees[index];
      const optimalAmount = opportunities.optimalAmounts[index];
      const profitBps = optimalAmount > 0n ? (profit * 10000n) / optimalAmount : 0n;
      const startToken = path[0];
      const startTokenInfo = ADDRESSES.find(addr => addr.address === startToken);
      if (!startTokenInfo) throw new Error(`Token info not found for ${startToken}`);

      const lastToken = path[path.length - 1];
      const lastTokenInfo = ADDRESSES.find(addr => addr.address === lastToken);
      if (!lastTokenInfo) throw new Error(`Token info not found for ${lastToken}`);

      console.log(`\nOpportunity #${index + 1}:`);
      console.log(`Path: ${path.join(' -> ')}`);
      console.log(`Expected profit: ${formatUnits(profit, lastTokenInfo.decimal)} ${lastTokenInfo.name}`);
      console.log(`Optimal input amount: ${optimalAmount.toString()} wei || ${formatUnits(optimalAmount, startTokenInfo.decimal)} ${startTokenInfo.name}`);
      console.log(`Profit percentage: ${this.formatBasisPoints(profitBps)}%`);
      console.log(`Pairs used: ${pairs.join(', ')}`);
      console.log(`Fees: ${fees.map(fee => fee.toString()).join(', ')}`);
    });
  }

  private formatBasisPoints(value: bigint): string {
    const whole = value / 100n;
    const fraction = value % 100n;
    return `${whole}.${fraction.toString().padStart(2, '0')}`;
  }
}
