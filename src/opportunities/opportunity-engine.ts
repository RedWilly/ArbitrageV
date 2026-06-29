import { type Address } from 'viem';
import { TOKENS, V2_SEARCH_POLICY } from '../constants';
import { V2Market } from '../market/v2-market';
import { type PairInfo, type ReserveUpdate, type V2SearchPolicy } from '../market/v2-types';
import { RouteSizer } from '../pricing/route-sizer';
import { type OpportunityStrategy } from '../strategies/strategy';
import { V2CircularArbitrageStrategy } from '../strategies/v2-circular-arb';
import {
  type ArbitrageOpportunity,
  type ArbitrageSearchResult,
  type CandidateRoute,
  type FindOpportunitiesRequest,
} from './opportunity-types';

export class OpportunityEngine {
  private readonly market: V2Market;
  private readonly strategies: OpportunityStrategy[];
  private readonly sizer: RouteSizer;

  constructor(
    private readonly policy: V2SearchPolicy = V2_SEARCH_POLICY,
    market = new V2Market(),
    strategies?: OpportunityStrategy[]
  ) {
    this.market = market;
    this.strategies = strategies ?? [new V2CircularArbitrageStrategy(market, policy)];
    this.sizer = new RouteSizer(market, policy);
  }

  addPair(pair: PairInfo): void {
    this.market.addPair(pair);
  }

  updateReserves(updates: ReserveUpdate[]): void {
    this.market.updateReserves(updates);
  }

  findOpportunities(request: FindOpportunitiesRequest): ArbitrageSearchResult {
    const candidates = this.strategies.flatMap(strategy => strategy.findCandidates(request));
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

  private sizeCandidate(candidate: CandidateRoute): ArbitrageOpportunity {
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
