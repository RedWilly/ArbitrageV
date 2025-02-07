---

### **Building the Graph for Arbitrage Detection in AMM DEXs**  
*A Step-by-Step Guide with Formulas and Fees*

---

## **1. Graph Structure**  
In an AMM DEX, liquidity pools (e.g., Uniswap pairs) are modeled as a **directed graph** where:  
- **Nodes**: Tokens (e.g., `USDC`, `ETH`, `BTC`).  
- **Edges**: Directed swaps between tokens via a liquidity pool.  
- **Edge Weights**: Derived from pool reserves and fees (explained below).  

---

## **2. Input Data Structure**  
Assume the following `PairInfo` format for each liquidity pool:  
```typescript
type PairInfo = {
    pairAddress: Address;  // Pool contract address
    token0: Address;       // Token A in the pool
    token1: Address;       // Token B in the pool
    reserve0: bigint;      // Reserve of token0
    reserve1: bigint;      // Reserve of token1
    fee: number;           // Swap fee (e.g., 0.003 = 0.3%)
};
```

---

## **3. Graph Construction Formula**  

### **3.1 Edge Representation**  
For each `PairInfo`, create **two directed edges** (one for each swap direction):  
1. **Edge 1**: Swap `token0 → token1`.  
2. **Edge 2**: Swap `token1 → token0`.  

### **3.2 Edge Weight Calculation**  
The weight of an edge represents the **logarithmic exchange rate adjusted for fees**.  

#### **For Edge \( \text{token}_A \rightarrow \text{token}_B \):**  
- **Reserves**: \( R_A \) (reserve of tokenA), \( R_B \) (reserve of tokenB).  
- **Fee**: \( f \) (e.g., 0.3% fee → \( f = 0.003 \)).  

The effective exchange rate after fees is:  
\[
\text{Effective Rate} = \frac{R_B}{R_A} \cdot (1 - f)
\]  

The edge weight \( w_{AB} \) is:  
\[
w_{AB} = -\ln(\text{Effective Rate}) = -\ln\left(\frac{R_B}{R_A} \cdot (1 - f)\right)
\]  

#### **Example**:  
For a `USDC/ETH` pool with:  
- \( R_{\text{USDC}} = 1000 \), \( R_{\text{ETH}} = 5 \), \( f = 0.003 \):  
\[
w_{\text{USDC→ETH}} = -\ln\left(\frac{5}{1000} \cdot 0.997\right) \approx 5.30
\]  

---

### **3.3 Edge Data Structure**  
Each edge stores:  
- `inputToken`: The token being sold (e.g., `token0`).  
- `outputToken`: The token being bought (e.g., `token1`).  
- `pairAddress`: The liquidity pool address.  
- `weight`: Calculated as above.  

```typescript
type Edge = {
    inputToken: Address;
    outputToken: Address;
    pairAddress: Address;
    weight: number;
};
```

---

## **4. Step-by-Step Graph Construction**  

### **Step 1: Initialize an Empty Graph**  
Create a map where each key is a token, and the value is a list of edges originating from that token:  
```typescript
const graph = new Map<Address, Edge[]>();
```

### **Step 2: Process Each `PairInfo`**  
For each liquidity pool:  
1. **Edge 1**: Add \( \text{token}_0 \rightarrow \text{token}_1 \).  
2. **Edge 2**: Add \( \text{token}_1 \rightarrow \text{token}_0 \).  

```typescript
function buildGraph(pairs: PairInfo[]): Map<Address, Edge[]> {
    const graph = new Map<Address, Edge[]>();

    for (const pair of pairs) {
        // Edge: token0 → token1
        const edge0to1: Edge = {
            inputToken: pair.token0,
            outputToken: pair.token1,
            pairAddress: pair.pairAddress,
            weight: calculateEdgeWeight(pair.reserve0, pair.reserve1, pair.fee),
        };

        // Edge: token1 → token0
        const edge1to0: Edge = {
            inputToken: pair.token1,
            outputToken: pair.token0,
            pairAddress: pair.pairAddress,
            weight: calculateEdgeWeight(pair.reserve1, pair.reserve0, pair.fee),
        };

        // Add edges to the graph
        addEdgeToGraph(graph, edge0to1);
        addEdgeToGraph(graph, edge1to0);
    }

    return graph;
}

function addEdgeToGraph(graph: Map<Address, Edge[]>, edge: Edge) {
    if (!graph.has(edge.inputToken)) {
        graph.set(edge.inputToken, []);
    }
    graph.get(edge.inputToken)!.push(edge);
}
```

### **Step 3: Edge Weight Calculation Function**  
Implement the formula \( w_{AB} = -\ln\left(\frac{R_B}{R_A} \cdot (1 - f)\right) \):  
```typescript
function calculateEdgeWeight(
    inputReserve: bigint,
    outputReserve: bigint,
    fee: number
): number {
    const rate = Number(outputReserve) / Number(inputReserve);
    const rateAfterFee = rate * (1 - fee);
    return -Math.log(rateAfterFee);
}
```

---

## **5. Example: Building a Simple Graph**  

### **Input Data**  
```typescript
const pairs: PairInfo[] = [
    {
        pairAddress: "0x123",
        token0: "USDC",
        token1: "ETH",
        reserve0: BigInt(1000),
        reserve1: BigInt(5),
        fee: 0.003,
    },
    {
        pairAddress: "0x456",
        token0: "ETH",
        token1: "BTC",
        reserve0: BigInt(10),
        reserve1: BigInt(1),
        fee: 0.003,
    },
];
```

### **Resulting Graph**  
- **Edges from `USDC`**:  
  ```typescript
  {
    inputToken: "USDC",
    outputToken: "ETH",
    pairAddress: "0x123",
    weight: 5.30,
  }
  ```
- **Edges from `ETH`**:  
  ```typescript
  {
    inputToken: "ETH",
    outputToken: "USDC",
    pairAddress: "0x123",
    weight: -Math.log((1000/5) * 0.997) ≈ -5.30,
  },
  {
    inputToken: "ETH",
    outputToken: "BTC",
    pairAddress: "0x456",
    weight: -Math.log((1/10) * 0.997) ≈ 2.31,
  }
  ```
- **Edges from `BTC`**:  
  ```typescript
  {
    inputToken: "BTC",
    outputToken: "ETH",
    pairAddress: "0x456",
    weight: -Math.log((10/1) * 0.997) ≈ -2.30,
  }
  ```

---

## **6. Path Reconstruction with Pair Addresses**  
When detecting a negative cycle (arbitrage), backtrack using the `pairAddress` stored in each edge:  
```typescript
// Example cycle: USDC → ETH → BTC → USDC
const path = ["USDC", "ETH", "BTC", "USDC"];
const pairs = ["0x123", "0x456", "0x789"];  // Pool addresses used
```

---

## **7. Key Takeaways**  
1. **Graph Structure**: Tokens are nodes; swaps are edges with weights derived from reserves and fees.  
2. **Negative Cycle Detection**: A cycle with total weight \( < 0 \) implies arbitrage.  
3. **Efficiency**: The algorithm runs in \( O(K_{\text{max}} \cdot |E|) \), suitable for real-time use.  

This graph structure is the foundation for detecting arbitrage in AMM DEXs. Let me know if you need further clarification!