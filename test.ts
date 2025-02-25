import { createPublicClient, http, parseAbiItem } from 'viem';
import { shibarium } from 'viem/chains';

// Uniswap V3 Pool Address (Replace with the actual pool address)
const poolAddress = '0x0fE6189AC54Ca3aac59421DC49C9991F564621a8';

// Create a Viem public client
const client = createPublicClient({
  chain: shibarium,
  transport: http(),
});

// Define Swap event using parseAbiEvent (fixes TypeScript issue)
const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

// Listen for Swap events
client.watchEvent({
  address: poolAddress,
  event: swapEvent, // ✅ Use `event` instead of `abi`
  onLogs: (logs) => {
    logs.forEach((log) => {
      if (!log.args) return; // Prevents errors in case args are missing

      const { sqrtPriceX96, liquidity } = log.args;
      const sqrtP = Number(sqrtPriceX96);
      const L = Number(liquidity);
      const Q96 = 2 ** 96;

      // Compute price
      const price = (sqrtP / Q96) ** 2;

      // Approximate reserves
      const reserve0 = L / sqrtP * Q96;
      const reserve1 = (L * sqrtP) / Q96;

      console.log(`Swap Detected! Updated Values:
        - sqrtPriceX96: ${BigInt(sqrtP).toString()}
        - Liquidity: ${BigInt(L).toString()}
        - Price: ${price.toFixed(18)}
        - Reserve0 (approx): ${reserve0.toFixed(0)} 
        - Reserve1 (approx): ${reserve1.toFixed(0)} 
      `);      
    });
  },
});

console.log('Listening for Swap events...');
