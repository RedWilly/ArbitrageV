import { type Address } from 'viem';
import { TOKENS, V2_SEARCH_POLICY } from '../constants';
import { CandidateFinder } from './candidate-finder';
import { MarketGraph } from './market-graph';
import { TradeSizer } from './trade-sizer';
import {
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
  type PairInfo,
  type V2SearchPolicy,
} from './types';

export class V2ArbitrageEngine {
  private readonly market = new MarketGraph();
  private readonly candidates: CandidateFinder;
  private readonly sizer: TradeSizer;

  constructor(private readonly policy: V2SearchPolicy = V2_SEARCH_POLICY) {
    this.candidates = new CandidateFinder(this.market, policy);
    this.sizer = new TradeSizer(this.market, policy);
  }

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
        const token = TOKENS.find(addr => addr.address === originToken);

        if (!token) {
          throw new Error(`No token config found for ${originToken}. Please update TOKENS in constants.ts.`);
        }

        return opportunity.profit > token.minProfit;
      })
      .sort((a, b) => {
        if (b.profit > a.profit) return 1;
        if (b.profit < a.profit) return -1;
        return 0;
      })
      .slice(0, this.policy.maxOpportunities);

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

