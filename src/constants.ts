import dotenv from "dotenv";
import { parseEther, parseGwei, parseUnits, type Address } from "viem";
dotenv.config();

export const CHAIN_ID = 1329;

export const RPC_URL = process.env.RPC_URL;
export const WSS_URL = process.env.WSS_URL;

export const PRIVATE_KEY = process.env.PRIVATE_KEY;

export const ARB_CONTRACT = process.env.ARB_CONTRACT_ADDRESS;

export const UNISWAP_FLASH_QUERY_CONTRACT =
    process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS;

/**
 * List of tokens used for arbitrage operations
 * 
 * IMPORTANT: The order of this array is significant:
 * - The first TOP_TOKENS_FOR_ARBITRAGE tokens will be used as starting points for arbitrage
 * - Each token that is used for arbitrage must have a corresponding entry in the minProfits array
 * - For example, if TOP_TOKENS_FOR_ARBITRAGE = 3, then the first 3 tokens (WCRO, USDC, USDT) will be used
 * 
 * Each token object contains:
 * - name: A human-readable name for the token
 * - address: The token's contract address
 * - LPAMOUNT: The amount to use when calculating liquidity
 * - decimal: The number of decimals for the token
 */
export const ADDRESSES: { name: string; address: `0x${string}`; LPAMOUNT: string; decimal: number }[] = [
    { name: "WSEI", address: "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7" as `0x${string}`, LPAMOUNT: parseEther("495").toString(), decimal: 18 },
    { name: "USDC", address: "0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1" as `0x${string}`, LPAMOUNT: parseUnits("90", 6).toString(), decimal: 6 },
    { name: "USDT", address: "0xB75D0B03c06A926e488e2659DF1A861F860bD3d1" as `0x${string}`, LPAMOUNT: parseUnits("90", 6).toString(), decimal: 6 },
    { name: "USD₮0", address: "0x9151434b16b9763660705744891fA906F660EcC5" as `0x${string}`, LPAMOUNT: parseUnits("90", 6).toString(), decimal: 6 }, 
    { name: "WETH", address: "0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8" as `0x${string}`, LPAMOUNT: parseEther("0.05532").toString(), decimal: 18 }, 
    { name: "WBTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" as `0x${string}`, LPAMOUNT: parseUnits("0.001032", 8).toString(), decimal: 8 },
    { name: "ISEI", address: "0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423" as `0x${string}`, LPAMOUNT: parseUnits("478", 6).toString(), decimal: 6 },
];
        
/**
 * DEX factory addresses and configuration
 * 
 * This array defines the DEX factories that the arbitrage bot will monitor.
 * Each factory represents a different exchange on the blockchain.
 * 
 * Each factory object contains:
 * - name: The name of the DEX (e.g., "VVS", "MMF")
 * - address: The factory contract address
 * - fee: The trading fee in basis points (e.g., 30 = 0.3%)
 * - volatile: Flag to indicate if this is a volatile DEX (if true, stable pairs will be excluded)
 * 
 * The bot will search for arbitrage opportunities across all these exchanges.
 * V2 DEXES FACTORY ADDESSES
 */
export const FACTORY: { name: string; address: `0x${string}`; fee: number; volatile: boolean }[] = [
    { name: "DRAGON", address: "0x71f6b49ae1558357bBb5A6074f1143c46cBcA03d" as `0x${string}`, fee: 30, volatile: false },
    { name: "YAKA", address: "0xd45dAff288075952822d5323F1d571e73435E929" as `0x${string}`, fee: 18, volatile: true }, //swapfee
    { name: "Donkey", address: "0x4B4746216214f9e972c5D35D3Fe88e6Ec4C28A6B" as `0x${string}`, fee: 30, volatile: false }, // swap fee
];

/**
 * V3 DEXES FACTORY ADDESSES
 * Fee tiers and corresponding tick spacing:
 * - 100 (0.01%) -> tick spacing: 1
 * - 500 (0.05%) -> tick spacing: 10
 * - 3000 (0.3%) -> tick spacing: 60
 * - 10000 (1%) -> tick spacing: 200
 */
export const V3_Pools: { name: string; address: `0x${string}`; fee: number; }[] = [
    { name: "WSEI/WBTC", address: "0x3E00Dd875fEf6cE2209007c1e625d9A656E32556" as `0x${string}`, fee: 3000, }, //0.3% = 3000 (for v3)
    { name: "WSEI/USDC", address: "0x882f62fe8E9594470D1da0f70Bc85096F6c60423" as `0x${string}`, fee: 3000, },
    { name: "WETH/USDC", address: "0x69E2EDD60BBCd42Fd5eD549599de249A9A34b98B" as `0x${string}`, fee: 3000, },
    { name: "USD₮0/WSEI", address: "0xb243320bcf9c95DB7F74108B6773b8F4Dc3adaF5" as `0x${string}`, fee: 3000, },
    { name: "ISEI/WSEI", address: "0xD0553A0853C57267c1F2E212347002B052595558" as `0x${string}`, fee: 500, }, // 0.05% = 500
    { name: "USD₮0/USDC", address: "0xC1461365C3FcfeBB12247B40Ceca5bdB97E87c56" as `0x${string}`, fee: 100, }, // 0.01% = 100
    { name: "WBTC/USDC", address: "0x9E0F3349580ebdFd546efFb0deF17100c60A7af9" as `0x${string}`, fee: 3000, },
    { name: "WETH/WSEI", address: "0xE0F20947365D2fcF5Fabd14AD4415ab18191BD3a" as `0x${string}`, fee: 3000, },
];

/**
 * Token-specific minimum profit thresholds
 * 
 * IMPORTANT: This array MUST be equal to TOP_TOKENS_FOR_ARBITRAGE elements.
 * Each element corresponds to a token in the ADDRESSES array in the same order.
 * 
 * For example:
 * - minProfits[0] is the min profit for ADDRESSES[0] (WCRO)
 * - minProfits[1] is the min profit for ADDRESSES[1] (LION)
 * - etc.
 * 
 * The system will throw an error if it tries to use a token that doesn't have
 * a corresponding minimum profit threshold defined here.
 */
export const minProfits = [
    parseEther("0.05540"),     
    parseUnits("0.01", 6),     
    parseUnits("0.01", 6),  
    parseUnits("0.01", 6),
    parseEther("0.000006120"),
    parseUnits("0.0000001149", 8),
    parseUnits("0.05265", 6),
];

// Legacy minProfit for backward compatibility - findArbitrageOpportunities
export const minProfit = parseEther("3");

export const maxIterations = 100;
export const maxHops = 3;
export const MAX_ENTRIES_PER_TOKEN = 10;

/**
 * Number of top tokens to consider for arbitrage
 * IMPORTANT: This value must not exceed the length of the minProfits array.
 * If you increase this number, make sure to add corresponding entries to the minProfits array.
 * NOTE - the more token you add - it increase the speed +100ms when searching(e.g if 3 means 300ms total)
 */
export const TOP_TOKENS_FOR_ARBITRAGE = 7;

export const DEBUG = true;
export const WSS_ENABLED = true; //enable this only when you are on a chain with wss support or better wss
export const NERK = true;
export const LEGACY = true;

/**
 * enable this when you when the bot to also include v3 pools in the arbitrage search
 * ( that means it will support the current V2→V2)
 * and also V2→V3, V3→V2 & V3→V3
 * 
 * BUT if false it will stick with the current V2→V2 only
 *  */ 
export const enableV3Pools = true; 


export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 300000n;
export const BASE_FEE = parseGwei("21060");

// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';


/**
 * Types
 */
export type PoolInfo = {
  type: 'V2';
  token0: Address;
  token1: Address;
  pairAddress: Address;
  fee: number;
  reserve0: bigint;
  reserve1: bigint;
} | {
  type: 'V3';
  token0: Address;
  token1: Address;
  poolAddress: Address;
  fee: number;
  tick: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tickSpacing: number;
};
