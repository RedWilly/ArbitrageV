# ArbitrageV – Cross-Chain DEX Arbitrage Bot

ArbitrageV is a high-performance arbitrage engine that scans AMM-based DEXs, builds a fees‑aware exchange graph, detects negative‑cycle arbitrage opportunities, and executes profitable trades automatically.

## Table of Contents
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Mathematical Foundations](#mathematical-foundations)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Multi-Token Arbitrage**: Scan top N tokens concurrently
- **Fee‑Adjusted Graph**: Negative‑log weights incorporate swap fees
- **Event Monitoring**: Real‑time WebSocket + HTTP polling fallback
- **Robust Error Handling**: Automatic reconnects and filter recovery
- **Token‑Specific Thresholds**: Custom profit guards per token
- **Telegram Notifications**: Instant alerts for opportunities and executions
- **Modular Design**: Clear separation of network, graph, execution, and monitoring

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Bun (or Node.js)
- **Blockchain API**: viem (HTTP & WebSocket)
- **Notifications**: `node-telegram-bot-api`
- **Environment**: dotenv

## Architecture

```
root/
├─ src/
│   ├─ constants.ts      # Configuration & thresholds
│   ├─ network.ts        # HTTP/WebSocket client setup
│   ├─ getinfo.ts        # Pair discovery & reserve fetching
│   ├─ graph.ts          # Graph builder & Bellman‑Ford logic
│   ├─ execute.ts        # Transaction construction & send
│   ├─ event.ts          # Sync event monitor with fallbacks
│   ├─ opp.ts            # Opportunity discovery & logging
│   ├─ Notify.ts         # Telegram notifications
│   └─ nonce.ts          # Nonce management
├─ README.md
├─ package.json
└─ tsconfig.json
```


## Prerequisites

- **Bun** v0.6+ or **Node.js** v16+ installed
- A funded wallet private key
- RPC endpoint with HTTP & optional WSS support
- Telegram Bot API token and chat ID (optional)

## Installation

```bash
git clone https://github.com/RedWilly/ArbitrageV.git
cd ArbitrageV
bun install
```

## Configuration

Create a `.env` file at project root with:

```ini
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
RPC_URL=https://your-rpc-endpoint
WSS_URL=wss://your-ws-endpoint    # optional
ARB_CONTRACT_ADDRESS=0x...      
UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS=0x...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
```  
Modify `src/constants.ts` if you need custom thresholds, factory list, or TOP_TOKENS_FOR_ARBITRAGE.
- EIP-1559 gas fee budget: modify the 90% allocation in `OpportunityManager.calculateGasFees` (in `src/execute.ts` around lines 238–239). By default it uses 90% of expected profit; adjust this value to suit your strategy.
- Legacy transactions: set `LEGACY` to `true` in `src/constants.ts` to use legacy gas pricing, and update the `BASE_FEE` constant there to control the `gasPrice` for legacy txns.

## Usage

```bash
# Start the arbitrage bot
bun run index.ts
```

Press `Ctrl+C` to stop the event monitor gracefully.

## Contributing

Contributions welcome! Please open issues or submit PRs. Follow existing code style and include tests for new features.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
