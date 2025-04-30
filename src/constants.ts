import dotenv from "dotenv";
import { parseEther, parseGwei, parseUnits, type Address } from "viem";
dotenv.config();

export const CHAIN_ID = 2000;

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
    { name: "WWDOGE", address: "0xB7ddC6414bf4F5515b52D8BdD69973Ae205ff101" as `0x${string}`, LPAMOUNT: parseEther("455").toString(), decimal: 18 },
    { name: "ONMON", address: "0xe3fcA919883950c5cD468156392a6477Ff5d18de" as `0x${string}`, LPAMOUNT: parseEther("2000000000").toString(), decimal: 18 },
    { name: "DC", address: "0x7B4328c127B85369D9f82ca0503B000D09CF9180" as `0x${string}`, LPAMOUNT: parseEther("205000").toString(), decimal: 18 },
    { name: "KIBBLE", address: "0x1e1026ba0810e6391b0F86AFa8A9305c12713B66" as `0x${string}`, LPAMOUNT: parseEther("1700000000").toString(), decimal: 18 }, 
    { name: "CHEWY", address: "0xbA2fa659f475f69EeEFa245523DBa9C14BbA7163" as `0x${string}`, LPAMOUNT: parseEther("24000000000").toString(), decimal: 18 }, 
    { name: "YODE", address: "0x6FC4563460d5f45932C473334d5c1C5B4aEA0E01" as `0x${string}`, LPAMOUNT: parseEther("3700").toString(), decimal: 18 },
    // { name: "ISEI", address: "0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423" as `0x${string}`, LPAMOUNT: parseUnits("478", 6).toString(), decimal: 6 },
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
    { name: "DOGESHREK", address: "0x7C10a3b7EcD42dd7D79C0b9d58dDB812f92B574A" as `0x${string}`, fee: 30, volatile: false },
    { name: "DOGSWAP", address: "0xD27D9d61590874Bf9ee2a19b27E265399929C9C3" as `0x${string}`, fee: 20, volatile: false }, //swapfee
    { name: "FRAX", address: "0x67b7DA7c0564c6aC080f0A6D9fB4675e52E6bF1d" as `0x${string}`, fee: 30, volatile: false }, // swap fee
    { name: "YODEX", address: "0xAaA04462e35f3e40D798331657cA015169e005d7" as `0x${string}`, fee: 50, volatile: false},
    { name: "KIBBLE", address: "0xF4bc79D32A7dEfd87c8A9C100FD83206bbF19Af5" as `0x${string}`, fee: 30, volatile: false},
    { name: "BOUN", address: "0x6B09Aa7a03d918b08C8924591fc792ce9d80CBb5" as `0x${string}`, fee: 30, volatile: false}
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
    parseEther("0.01540"),     
    parseEther("1500000"),     
    parseEther("130"),  
    // parseUnits("0.01", 6),
    // parseEther("0.000006120"),
    // parseUnits("0.0000001149", 8),
    // parseUnits("0.05265", 6),
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
export const TOP_TOKENS_FOR_ARBITRAGE = 3;

export const DEBUG = true;
export const WSS_ENABLED = false; //enable this only when you are on a chain with wss support or better wss
export const NERK = false;
export const LEGACY = true;

/**
 * enable this when you when the bot to also include v3 pools in the arbitrage search
 * ( that means it will support the current V2→V2)
 * and also V2→V3, V3→V2 & V3→V3
 * 
 * BUT if false it will stick with the current V2→V2 only
 *  */ 
export const enableV3Pools = false; 


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
