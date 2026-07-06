# ArbitrageV

Small hobby arbitrage bot for Sei DEX pools. It is mostly a personal project for testing V2/V3 pool discovery, Carbon strategy reads, event monitoring, and simple route execution.

Use at your own risk. This touches real wallets and on-chain contracts.

## Setup

```bash
bun install
```

Create `.env`:

```ini
PRIVATE_KEY=0x...
RPC_URL=https://...
WSS_URL=wss://...
ARB_CONTRACT_ADDRESS=0x...
UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS=0x...

# optional
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Most pool/token settings live in `src/constants.ts`.

## Run

First build the local pool cache:

```bash
bun run sync:markets
```

That writes known V2/V3 pool metadata and Carbon pair metadata to `data/markets.sqlite`.

Then start the bot:

```bash
bun start
```

On startup the bot reads market metadata from SQLite, starts watching events, then fetches V2 live reserves, V3 state, and Carbon strategies.

## Tests

```bash
bun test
```

## Notes

This is not polished trading software. It is a workbench. Expect rough edges, noisy logs, and config that changes as I test things.
