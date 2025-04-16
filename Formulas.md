# Formulas & Algorithmic Overview

This document describes the math and algorithmic details of ArbitrageV's implementation, matching the codebase in `src/graph.ts`. It covers data structures, graph construction, CPMM swap formulas, dynamic programming arbitrage detection, and profit optimization.

## 1. Data Structures

```typescript
export type PairInfo = {
  pairAddress: Address;  // AMM pool contract address
  token0: Address;       // Address of token0
  token1: Address;       // Address of token1
  reserve0: bigint;      // Liquidity reserve of token0
  reserve1: bigint;      // Liquidity reserve of token1
  fee: number;           // Trading fee in basis points (e.g., 30 for 0.3%)
};

interface Edge {
  to: Address;        // Destination token
  pairAddress: Address;
  direction: 'token0ToToken1' | 'token1ToToken0';
  fee: number;
  reserveIn: bigint;
  reserveOut: bigint;
}
```

## 2. Graph Construction

ArbitrageV maintains a directed graph of AMM pools:

- For each `PairInfo`, two edges are added:
  - `token0 → token1`
  - `token1 → token0`

Each edge stores the current reserves and fee for computing swap outputs.

## 3. Graph Maintenance & Updates

### 3.1 updateGraphEdges
The `updateGraphEdges` method dynamically adds or updates edges for a given `PairInfo`:
- Converts reserves to numbers and skips zero-liquidity pools.
- Tracks highest-reserve pair for each token using `tokenToHighestReservePair`.
- Maintains `edgeIndex` (Map<`${token}-${pairAddress}`, Edge>) for O(1) updates.
- Updates existing edges’ `reserveIn`, `reserveOut`, and `fee`, or creates new `Edge` instances.

### 3.2 updatePairReservesBatch
The `updatePairReservesBatch` method processes multiple reserve updates efficiently:
- Accepts an array of `{ pairAddress, reserve0, reserve1 }` updates.
- Updates stored `PairInfo` objects and logs missing pairs.
- Collects unique updated pairs and invokes `updateGraphEdges` per pair to refresh the graph.

## 4. CPMM Swap Formula

For a given input amount `amountIn`, reserves `reserveIn`, `reserveOut`, and fee `f` (basis points):

1. Convert fee to multiplier:  
   `feeMultiplier = 1 - f / 10000`

2. Amount after fee:  
   `amountInAfterFee = amountIn * feeMultiplier`

3. Output amount (constant-product formula):  
   `amountOut = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee)`

## 5. Dynamic Programming Arbitrage Detection

Arbitrage cycles are found via a DP-based method in `findArbitrageOpportunities`:

1. **DP Table**: `dp[step]` maps each token to up to `MAX_ENTRIES_PER_TOKEN` best entries (`DPEntry`), where each entry has:
   - `amountOut`: maximum output after `step` swaps starting from input 1
   - `path`, `pairs`, `directions`: tracking the route

2. **Initialization**:  
   `dp[0].set(startToken, [{ amountOut: 1.0, path: [startToken], pairs: [], directions: [] }])`

3. **Relaxation**: For `step = 1..maxHops`:
   - For each token in `dp[step-1]`, and each outgoing edge:
     - Skip if same pair used
     - Compute new `amountOut` via CPMM formula
     - Insert into `dp[step][edge.to]`, keep top entries by `amountOut`

4. **Recording Opportunities**:  
   - Whenever `step ≥ 2` and `edge.to === startToken`, record a circular arbitrage route.
   - The `findMultiTokenArbitrageOpportunities` method generalizes this approach by seeding `dp[0]` with multiple `startTokens`, tracking each entry’s origin (`entry.path[0]`), and recording cycles that return to their respective origin.

## 6. Profit Optimization

After raw cycles are found, each is validated and optimized:

1. **Profit Function**: `calculateProfit(inputAmount)` simulates swaps along the cycle.

2. **Derivatives**:
   - `calculateJacobian`: first derivative of profit w.r.t. input
   - `calculateHessian`: second derivative

3. **Optimal Input**: A Newton–Raphson iteration finds `inputAmount` maximizing profit.

4. **Profit Condition**: Only cycles with `profit > minProfit` are kept.

## 7. Path Reconstruction

For each validated opportunity, we return:
- `path`: array of token addresses
- `pairs`: array of pool addresses
- `directions`: swap directions
- `optimalInput`: computed input amount
- `profit`: max profit amount

## 8. References

- `src/graph.ts`: `findArbitrageOpportunities`, `createProfitFunctions`
- CPMM constant-product invariant: `x * y = k`
- DP pruning and maximum hops settings in `constants.ts`