import { type Address } from 'viem';
import { ADDRESSES, minProfits } from '../constants';
import { CandidateFinder } from './candidate-finder';
import { MarketGraph } from './market-graph';
import { V2_SEARCH_POLICY } from './search-policy';
import { TradeSizer } from './trade-sizer';
import {
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
  type PairInfo,
} from './types';

export class V2ArbitrageEngine {
  private readonly market = new MarketGraph();
  private readonly candidates = new CandidateFinder(this.market);
  private readonly sizer = new TradeSizer(this.market);

  addPair(pair: PairInfo): void {
    this.market.addPair(pair);
  }

  updateReserves(updates: { pairAddress: Address; reserve0: bigint; reserve1: bigint }[]): void {
    this.market.updateReserves(updates);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const candidates = this.candidates.findCandidates(request);
    const opportunities = candidates
      .map(candidate => this.sizeCandidate(candidate))
      .filter(opportunity => {
        const originToken = opportunity.path[0];
        const tokenIndex = ADDRESSES.findIndex(addr => addr.address === originToken);

        if (tokenIndex < 0 || tokenIndex >= minProfits.length) {
          const tokenName = tokenIndex >= 0 ? ADDRESSES[tokenIndex].name : originToken;
          throw new Error(`No minimum profit threshold defined for token ${tokenName}. Please update the minProfits array in constants.ts.`);
        }

        return opportunity.profit > BigInt(minProfits[tokenIndex]);
      })
      .sort((a, b) => {
        if (b.profit > a.profit) return 1;
        if (b.profit < a.profit) return -1;
        return 0;
      })
      .slice(0, V2_SEARCH_POLICY.maxOpportunities);

    return {
      paths: opportunities.map(opportunity => opportunity.path),
      pairs: opportunities.map(opportunity => opportunity.pairs),
      profits: opportunities.map(opportunity => opportunity.profit),
      optimalAmounts: opportunities.map(opportunity => opportunity.optimalInput),
      fees: opportunities.map(opportunity => opportunity.fees),
    };
  }

  findBestPairForToken(
    token: Address,
    amountIn: bigint,
    excludePairs: Address[] = []
  ): { pairAddress: Address; fee: number } | null {
    return this.market.findBestPairForToken(token, amountIn, excludePairs);
  }

  getTokens(): Address[] {
    return this.market.tokensList();
  }

  getPairAddresses(): Address[] {
    return this.market.pairAddresses();
  }

  getAllPairs(): PairInfo[] {
    return this.market.allPairs();
  }

  clear(): void {
    this.market.clear();
  }

  private sizeCandidate(candidate: CandidateRoute): CandidateRoute & {
    profit: bigint;
    optimalInput: bigint;
    fees: number[];
  } {
    const { profit, optimalInput } = this.sizer.size(candidate);
    const fees = candidate.pairs.map(pairAddress => {
      const pair = this.market.pair(pairAddress);
      if (!pair) throw new Error(`Missing pair info for ${pairAddress}`);
      return pair.fee;
    });

    return {
      ...candidate,
      profit,
      optimalInput,
      fees,
    };
  }
}
