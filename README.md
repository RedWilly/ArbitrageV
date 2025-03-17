# CrosArb: Cross-Chain DEX Arbitrage Bot

A high-performance arbitrage detection and execution system for cryptocurrency markets on the Shibarium blockchain.

## Features

- **Multi-Token Arbitrage**: Supports simultaneous arbitrage opportunities across multiple starting tokens
- **Token-Specific Profit Thresholds**: Configurable minimum profit thresholds for each token
- **WebSocket Support**: Real-time event monitoring with fallback to HTTP polling
- **Cross-DEX Operation**: Works across multiple DEXes on the Shibarium blockchain
- **Tax-Token Avoidance**: Automatically filters out tokens with transfer taxes
- **Telegram Notifications**: Real-time alerts for arbitrage opportunities and executions

## Installation

```bash
# Install dependencies
npm install

# Build the TypeScript code
npm run build
```

## Configuration

The system is highly configurable through the `constants.ts` file:

### Token Configuration

```typescript
/**
 * List of tokens used for arbitrage operations
 * 
 * IMPORTANT: The order of this array is significant:
 * - The first TOP_TOKENS_FOR_ARBITRAGE tokens will be used as starting points for arbitrage
 * - Each token that is used for arbitrage must have a corresponding entry in the minProfits array
 */
export const ADDRESSES = [
    { name: "WCRO", address: "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23", LPAMOUNT: "..." },
    { name: "USDC", address: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59", LPAMOUNT: "..." },
    { name: "USDT", address: "0x66e428c3f67a68878562e79A0234c1F83c208770", LPAMOUNT: "..." },
    // More tokens...
];
```

### DEX Configuration

```typescript
/**
 * DEX factory addresses and configuration
 * 
 * Each factory object contains:
 * - name: The name of the DEX (e.g., "VVS", "MMF")
 * - address: The factory contract address
 * - fee: The trading fee in basis points (e.g., 30 = 0.3%)
 * - volatile: Flag to indicate if this is a volatile DEX
 */
export const FACTORY = [
    { name: "VVS", address: "0x3B44B2a187a7b3824131F8db5a74194D0a42Fc15", fee: 30, volatile: false },
    { name: "MMF", address: "0xd590cC180601AEcD6eeADD9B7f2B7611519544f4", fee: 17, volatile: false },
    // More DEXes...
];
```

### Profit Thresholds

```typescript
/**
 * Token-specific minimum profit thresholds
 * 
 * IMPORTANT: This array MUST be equal to TOP_TOKENS_FOR_ARBITRAGE elements.
 * Each element corresponds to a token in the ADDRESSES array in the same order.
 */
export const minProfits = [
    parseEther("0.5"),      // WCRO (18 decimals)
    parseUnits("1", 6),     // USDC (6 decimals)
    parseUnits("1", 6),     // USDT (6 decimals)
];
```

### Network Configuration

Set up your environment variables:

```
# .env file
PRIVATE_KEY=your_private_key
RPC_URL=https://your-rpc-url
WSS_URL=wss://your-websocket-url
```

## Usage

```bash
# Run the arbitrage bot
npm start
```

## Mathematical Foundations of Currency Arbitrage

### Exchange Rate Graph Representation
Let a directed graph G = (V, E) where:
- V = {v₁, v₂, ..., vₙ} represents currencies
- E = {e₁, e₂, ..., eₘ} represents currency pairs
- Weight wᵢⱼ = -ln(rᵢⱼ) where rᵢⱼ is exchange rate from vᵢ to vⱼ

Transforming the exchange rates using:  
```math
  w_{ij} = -\ln(r_{ij})
```

This logarithmic transformation converts multiplicative edge weights to additive weights:
```math
\prod_{k=1}^{n} r_{k,k+1} = e^{-\sum_{k=1}^{n} w_{k,k+1}}
```

### Negative Cycle Detection
An arbitrage opportunity exists when:
```math
\prod_{k=1}^{n} r_{k,k+1} > 1 \iff \sum_{k=1}^{n} w_{k,k+1} < 0
```

## Algorithmic Implementation

### Improved Bellman-Ford for Arbitrage

Our implementation enhances the classic Bellman-Ford algorithm:

1. **Early Termination Optimization**
   - Traditional: O(|V|·|E|) complexity guaranteed
   - Ours: Average-case O(|E|) using queue-based relaxation

2. **Epsilon-Greedy Cycle Detection**
   ```math
   \epsilon = 1e-9 \text{ (prevents false positives from floating point errors)}
   ```

3. **Breadth-First Relaxation**
   - Prioritizes recently updated nodes using FIFO queue
   - Reduces average relaxation operations

### Multi-Token Support

The system can now find arbitrage opportunities starting from multiple tokens:

```typescript
findMultiTokenArbitrageOpportunities(): ArbitrageOpportunity[] {
  // Use TOP_TOKENS_FOR_ARBITRAGE to consider multiple starting tokens
  const topTokens = ADDRESSES.slice(0, TOP_TOKENS_FOR_ARBITRAGE);
  let opportunities: ArbitrageOpportunity[] = [];
  
  for (const token of topTokens) {
    // Find opportunities for each token with token-specific profit thresholds
    // ...
  }
  
  return opportunities;
}
```

## Architecture

The project is organized into several key components:

1. **Graph Logic (`graph.ts`)**: Implements the core arbitrage detection algorithms
2. **Information Retrieval (`getinfo.ts`)**: Fetches reserves and pair information from the blockchain
3. **Execution Engine (`execute.ts`)**: Manages the execution of arbitrage opportunities
4. **Event Monitoring (`event.ts`)**: Listens for blockchain events using WebSockets with HTTP fallback
5. **Opportunity Manager (`opp.ts`)**: Handles opportunity discovery and logging
6. **Notification System (`Notify.ts`)**: Sends alerts via Telegram

## Advanced Features

### WebSocket Support

Real-time event monitoring is achieved through WebSockets:

```typescript
// In event.ts
if (wsClient && WSS_ENABLED) {
  console.log("Using WebSocket for event monitoring");
  this.setupWebSocketSubscription();
} else {
  console.log("Using HTTP polling for event monitoring");
  this.startPolling();
}
```

### Token-Specific Profit Thresholds

Each token can have its own minimum profit threshold:

```typescript
// Find the index of the starting token in ADDRESSES
const tokenIndex = ADDRESSES.findIndex(addr => addr.address === startToken);

// Use the token-specific minProfit
const tokenMinProfit = minProfits[tokenIndex];

return opp.profit > Number(tokenMinProfit);
```

## Performance & Benchmark Comparison

### Algorithm Comparison
| Algorithm               | Average O     | Best Case     | Worst Case     | Memory           |
|-------------------------|---------------|---------------|----------------|------------------|
| Standard Bellman-Ford   | O(V·E)        | O(V·E)        | O(V·E)         | O(V)             |
| Our Dynamic Programming | O(V·E·log(E)) | O(E)          | O(V·E·log(E))  | O(V·MAX_ENTRIES) |

Our implementation uses:
1. **Dynamic Programming with Path Pruning**: Maintains only the most profitable MAX_ENTRIES_PER_TOKEN paths for each token
2. **Newton's Method Optimization**: For finding the optimal input amount that maximizes profit
3. **Multi-Token Starting Points**: Enables parallel arbitrage detection across several base tokens

### Key Optimizations
1. **Early Loop Termination**: Skips redundant paths and immediate loops
2. **Reserve-Based Filtering**: Prioritizes pairs with higher liquidity
3. **Token-Specific Profit Thresholds**: Custom minimum profit requirements for each token

### Execution Performance
| Operation | Average Time (ms) |
|----------------------------|-------------------|
| Graph Construction | ~50 |
| Arbitrage Detection | ~150 |
| Optimal Amount Calculation | ~15 |
| Total Execution Cycle | ~250 |

This implementation achieves high accuracy in detecting profitable arbitrage opportunities with minimal latency.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
