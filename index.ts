import { runArbitrageBot } from './src/runtime/arbitrage-bot';

runArbitrageBot().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
