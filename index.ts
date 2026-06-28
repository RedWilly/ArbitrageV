import { runArbitrageBot } from './src/runtime';

runArbitrageBot().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
