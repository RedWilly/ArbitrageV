import { MarketGraph } from './market-graph';
import { type ArbitrageSearchPolicy, type MarketRoute, type MarketSizedRoute } from './types';

export function sizeRoute(graph: MarketGraph, policy: ArbitrageSearchPolicy, route: MarketRoute): MarketSizedRoute {
  let low = 1n;
  let high = graph.maxInputForRoute(route);

  while (high > low && !graph.quote(route, high).complete) {
    high /= 2n;
  }

  if (high <= low) {
    return { profit: 0n, optimalInput: 0n, complete: false };
  }

  for (let i = 0; i < policy.optimizationIterations && high - low > 3n; i++) {
    const third = (high - low) / 3n;
    if (third === 0n) break;

    const mid1 = low + third;
    const mid2 = high - third;
    const profit1 = quoteProfit(graph, route, mid1);
    const profit2 = quoteProfit(graph, route, mid2);

    if (profit1 < profit2) {
      low = mid1 + 1n;
    } else {
      high = mid2 - 1n;
    }
  }

  return bestFinalCandidate(graph, route, low, high);
}

function quoteProfit(graph: MarketGraph, route: MarketRoute, amountIn: bigint): bigint {
  const quote = graph.quote(route, amountIn);
  return quote.complete ? quote.profit : -1n;
}

function bestFinalCandidate(graph: MarketGraph, route: MarketRoute, low: bigint, high: bigint): MarketSizedRoute {
  const center = (low + high) / 2n;
  const candidates = new Set<bigint>([low, center, high]);

  for (let offset = 1n; offset <= 5n; offset++) {
    if (center > offset) candidates.add(center - offset);
    candidates.add(center + offset);
  }

  let profit = 0n;
  let optimalInput = 0n;
  let complete = false;

  for (const input of candidates) {
    if (input < low || input > high) continue;
    const quote = graph.quote(route, input);
    if (quote.complete && quote.profit > profit) {
      profit = quote.profit;
      optimalInput = input;
      complete = true;
    }
  }

  return { profit, optimalInput, complete };
}
