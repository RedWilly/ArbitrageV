### **Modified Bellman-Ford Algorithm: Source-Specific Cycle Detection**  
*A Comprehensive Guide for Arbitrage Detection in AMM DEXs*

---

## **1. Problem Statement**  
**Goal**:  
Given a directed graph \( G = (V, E) \) representing token pairs in an Automated Market Maker (AMM) Decentralized Exchange (DEX), find cycles of **specific lengths** (e.g., 4–20 edges) that start and end at a **source token** (e.g., `USDC`). Such cycles represent profitable arbitrage opportunities.  

**Constraints**:  
- Handle **negative edge weights** (critical for arbitrage detection).  
- Optimize for **low computational complexity** (suitable for real-time DEX environments).  
- Return the **exact path** (sequence of token pairs) forming the cycle.  

---

## **2. Mathematical Foundations**  

### **2.1 Graph Transformation**  
**AMM Pool as Edges**:  
Each liquidity pool (e.g., `USDC/ETH`) is modeled as **two directed edges**:  
1. \( \text{token}_0 \rightarrow \text{token}_1 \) (swap \( \text{token}_0 \) for \( \text{token}_1 \)).  
2. \( \text{token}_1 \rightarrow \text{token}_0 \) (swap \( \text{token}_1 \) for \( \text{token}_0 \)).  

**Edge Weight Calculation**:  
For a swap from \( \text{token}_A \) to \( \text{token}_B \) in a pool with reserves \( R_A \) and \( R_B \), and fee \( f \):  
\[
\text{Output amount} = \frac{R_B \cdot (1 - f)}{R_A} \quad \text{(simplified for small swaps)}
\]  
The edge weight \( w_{AB} \) is defined as:  
\[
w_{AB} = -\ln\left(\frac{\text{Output amount}}{1}\right) = -\ln\left(\frac{R_B}{R_A} \cdot (1 - f)\right)
\]  
**Interpretation**:  
- \( w_{AB} < 0 \): Profitable swap (output > input).  
- \( w_{AB} > 0 \): Loss-making swap.  

**Negative Cycle = Arbitrage**:  
A cycle \( C \) with total weight \( \sum_{e \in C} w_e < 0 \) implies:  
\[
\prod_{e \in C} \left(\frac{R_{\text{out},e}}{R_{\text{in},e}} \cdot (1 - f_e)\right) > 1
\]  
This means the product of exchange rates in the cycle exceeds 1, resulting in a profit.

---

## **3. Algorithm Design**  

### **3.1 Modified Bellman-Ford with Dynamic Programming**  
**Key Idea**:  
Track the shortest path from the source token to all other tokens **for exactly \( k \) steps** (edges). If the shortest path back to the source after \( k \) steps is negative, a profitable cycle exists.  

**Notation**:  
- \( \text{dist}_k[v] \): Shortest distance from the source to token \( v \) using **exactly \( k \) edges**.  
- \( \text{pred}_k[v] \): Predecessor token and pair address used to reach \( v \) in \( k \) steps.  

---

### **3.2 Algorithm Steps**  

#### **Step 1: Initialization**  
- Let \( s \) be the source token (e.g., `USDC`).  
- Initialize distances for \( k = 0 \):  
  \[
  \text{dist}_0[s] = 0 \quad \text{and} \quad \text{dist}_0[v] = \infty \quad \forall v \neq s
  \]  
- All other \( \text{dist}_k[v] \) are initially \( \infty \).  

#### **Step 2: Edge Relaxation with Step Tracking**  
For each step \( k = 1, 2, \ldots, K_{\text{max}} \) (e.g., \( K_{\text{max}} = 20 \)):  
1. **Reset Current Distances**:  
   \[
   \text{dist}_k[v] = \infty \quad \forall v
   \]  
2. **Relax All Edges**:  
   For each directed edge \( (u \rightarrow v) \) with weight \( w_{uv} \):  
   \[
   \text{if } \text{dist}_{k-1}[u] + w_{uv} < \text{dist}_k[v] \text{, then:}
   \]  
   \[
   \text{dist}_k[v] = \text{dist}_{k-1}[u] + w_{uv}
   \]  
   \[
   \text{pred}_k[v] = (u, \text{pairAddress}_{u \rightarrow v})
   \]  

#### **Step 3: Cycle Detection**  
After each step \( k \geq 4 \):  
Check if the source token \( s \) has a negative distance:  
\[
\text{if } \text{dist}_k[s] < 0 \quad \Rightarrow \quad \text{Cycle of length } k \text{ detected!}
\]  

#### **Step 4: Path Reconstruction**  
1. **Backtrack Predecessors**:  
   Starting from \( \text{pred}_k[s] \), trace back \( k \) steps to reconstruct the cycle.  
2. **Collect Pair Addresses**:  
   Extract the `pairAddress` from each predecessor step to identify the liquidity pools used.  

---

### **3.3 Complexity Analysis**  
- **Time**: \( O(K_{\text{max}} \cdot |E|) \)  
  - Example: \( K_{\text{max}} = 20 \), \( |E| = 10,000 \) → 200,000 operations.  
- **Space**: \( O(|V|) \) (uses two 1D arrays: \( \text{dist}_{k-1} \) and \( \text{dist}_k \)).  

---

## **4. Example Walkthrough**  

### **4.1 Input Data**  
- **Source Token**: `USDC`  
- **Pairs**:  
  1. `USDC/ETH` (\( R_{\text{USDC}} = 1000 \), \( R_{\text{ETH}} = 5 \), \( f = 0.3\% \))  
  2. `ETH/BTC` (\( R_{\text{ETH}} = 10 \), \( R_{\text{BTC}} = 1 \), \( f = 0.3\% \))  
  3. `BTC/USDC` (\( R_{\text{BTC}} = 1 \), \( R_{\text{USDC}} = 20,000 \), \( f = 0.3\% \))  

### **4.2 Edge Weights**  
1. \( \text{USDC} \rightarrow \text{ETH} \):  
   \[
   w = -\ln\left(\frac{5}{1000} \cdot 0.997\right) \approx -\ln(0.004985) \approx 5.30
   \]  
2. \( \text{ETH} \rightarrow \text{BTC} \):  
   \[
   w = -\ln\left(\frac{1}{10} \cdot 0.997\right) \approx -\ln(0.0997) \approx 2.31
   \]  
3. \( \text{BTC} \rightarrow \text{USDC} \):  
   \[
   w = -\ln\left(\frac{20,000}{1} \cdot 0.997\right) \approx -\ln(19,940) \approx -9.90
   \]  

### **4.3 Cycle Detection (k=3)**  
- **Path**: `USDC → ETH → BTC → USDC`  
- **Total Weight**:  
  \[
  5.30 + 2.31 - 9.90 = -2.29 \quad (< 0)
  \]  
- **Arbitrage Profit**:  
  \[
  e^{-(-2.29)} = e^{2.29} \approx 9.87 \quad (987\% \text{ profit})
  \]  

---

## **5. Practical Considerations**  

### **5.1 Handling Large Reserves**  
- Use **logarithmic transformation** to avoid numerical overflow:  
  \[
  \ln\left(\frac{R_B}{R_A}\right) = \ln(R_B) - \ln(R_A)
  \]  

### **5.2 Early Termination**  
- Stop updating \( \text{dist}_k[v] \) if no improvements occur in an iteration.  

### **5.3 Slippage Adjustment**  
- For large swaps, adjust \( \text{Output amount} \) using the **constant product formula**:  
  \[
  \text{Output} = \frac{R_B \cdot \Delta_{\text{in}} \cdot (1 - f)}{R_A + \Delta_{\text{in}}}
  \]  

---

## **6. Pseudocode**  

```typescript
type Edge = {
  inputToken: Address;
  outputToken: Address;
  pairAddress: Address;
  weight: number;
};

function findArbitrage(
  source: Address,
  edges: Edge[],
  maxSteps: number
): { path: Address[]; pairs: Address[] } | null {
  // Step 1: Initialize distances and predecessors
  const prevDist = new Map<Address, number>();
  const currDist = new Map<Address, number>();
  const predecessors = new Map<number, Map<Address, { token: Address; pair: Address }>>();

  // ... (see full implementation in previous answer) ...

  // Step 2: Relax edges for each step
  for (let step = 1; step <= maxSteps; step++) {
    // ... (relax edges and update distances) ...

    // Step 3: Check for cycle at the source
    if (step >= 4 && currDist.get(source) < 0) {
      // Step 4: Reconstruct path
      const path = [source];
      const pairs: Address[] = [];
      let currentToken = source;
      for (let i = 0; i < step; i++) {
        const pred = predecessors.get(step - i)?.get(currentToken);
        if (!pred) break;
        path.unshift(pred.token);
        pairs.unshift(pred.pair);
        currentToken = pred.token;
      }
      return { path: [...path, source], pairs };
    }
  }

  return null;
}
```

---

## **7. Conclusion**  
The **Modified Bellman-Ford Algorithm** with source-specific cycle detection is a robust method for identifying arbitrage opportunities in AMM DEXs. By combining dynamic programming with step-limited relaxations, it efficiently balances precision and computational cost, making it ideal for real-time applications.