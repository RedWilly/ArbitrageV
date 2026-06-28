import { type Address } from 'viem';
import { V2ArbitrageEngine } from './arbitrage/v2-engine';
import { type ArbitrageSearchResult, type FindOpportunitiesRequest, type PairInfo } from './arbitrage/types';

export type { PairInfo };

export class ArbitrageGraph {
  private readonly engine = new V2ArbitrageEngine();

  addPair(pair: PairInfo): void {
    this.engine.addPair(pair);
  }

  updatePairReserves(pairAddress: Address, reserve0: bigint, reserve1: bigint): void {
    this.updatePairReservesBatch([{ pairAddress, reserve0, reserve1 }]);
  }

  updatePairReservesBatch(updates: { pairAddress: Address; reserve0: bigint; reserve1: bigint }[]): void {
    this.engine.updateReserves(updates);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    return this.engine.findOpportunities(request);
  }

  findMultiTokenArbitrageOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    return this.findOpportunities(request);
  }

  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs: Address[] = []
  ): { pairAddress: Address; fee: number } | null {
    return this.engine.findBestPairForToken(token, amountIn, excludePairs);
  }

  getTokens(): Address[] {
    return this.engine.getTokens();
  }

  getPairAddresses(): Address[] {
    return this.engine.getPairAddresses();
  }

  getAllPairs(): PairInfo[] {
    return this.engine.getAllPairs();
  }

  clear(): void {
    this.engine.clear();
  }
}
