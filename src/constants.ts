import dotenv from "dotenv";
import { parseEther, parseGwei, parseUnits } from "viem";
dotenv.config();

export const CHAIN_ID = 109;

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
    { name: "WBONE", address: "0xC76F4c819D820369Fb2d7C1531aB3Bb18e6fE8d8" as `0x${string}`, LPAMOUNT: parseEther("100").toString(), decimal: 18 },
    { name: "WWBONE", address: "0x839FdB6cc98342B428E074C1573ADF6D48CA3bFd" as `0x${string}`, LPAMOUNT: parseEther("100").toString(), decimal: 18 },
    { name: "LEASH", address: "0x65218A41Fb92637254B4f8c97448d3dF343A3064" as `0x${string}`, LPAMOUNT: parseEther("0.2045").toString(), decimal: 18 },
    { name: "DAMN", address: "0xeCe898EdCc0AF91430603175F945D8de75291c70" as `0x${string}`, LPAMOUNT: parseEther("5000000").toString(), decimal: 18 },
    { name: "WETH", address: "0x8ed7d143Ef452316Ab1123d28Ab302dC3b80d3ce" as `0x${string}`, LPAMOUNT: parseEther("0.01668").toString(), decimal: 18 },
    { name: "SHIB", address: "0x495eea66B0f8b636D441dC6a98d8F5C3D455C4c0" as `0x${string}`, LPAMOUNT: parseEther("2500000").toString(), decimal: 18 },
    { name: "FEED", address: "0xe9Cb2D7ADC24Fc59FE00D6C0A0669BDF16805Fe0" as `0x${string}`, LPAMOUNT: parseEther("42000000000").toString(), decimal: 18 },
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
 */
export const FACTORY: { name: string; address: `0x${string}`; fee: number; volatile: boolean }[] = [
    { name: "woolfPro", address: "0x5c6C40CAe6f57b782D8Ff445258989aaC73D5074" as `0x${string}`, fee: 10, volatile: false },
    { name: "chewy", address: "0xEDedDbde5ffA62545eDF97054edC11013ED72125" as `0x${string}`, fee: 25, volatile: false },
    { name: "shiba", address: "0xc2b4218F137e3A5A9B98ab3AE804108F0D312CBC" as `0x${string}`, fee: 30, volatile: false },
    { name: "mars", address: "0xBe0223f65813C7c82E195B48F8AAaAcb304FbAe7" as `0x${string}`, fee: 20, volatile: false },
    { name: "pumk", address: "0x5640113EA7F369E6DAFbe54cBb1406E5BF153E90" as `0x${string}`, fee: 20, volatile: false },
    { name: "woof", address: "0xB9fbdFA27B7ba8BB2d4bB4aB399e4c55F0F7F83a" as `0x${string}`, fee: 20, volatile: true },
];

/**
 * Token-specific minimum profit thresholds
 * 
 * IMPORTANT: This array MUST be equal to TOP_TOKENS_FOR_ARBITRAGE elements.
 * Each element corresponds to a token in the ADDRESSES array in the same order.
 * 
 * For example:
 * - minProfits[0] is the min profit for ADDRESSES[0] (WCRO)
 * - minProfits[1] is the min profit for ADDRESSES[1] (USDC)
 * - etc.
 * 
 * The system will throw an error if it tries to use a token that doesn't have
 * a corresponding minimum profit threshold defined here.
 */
export const minProfits = [
    parseEther("0.05"),     
    parseEther("0.05"),     
    parseEther("0.0002045"),  
    parseEther("5458"),
    parseEther("0.00001674"),
    parseEther("2385"), //0.1 bone
    parseEther("42000000"), //0.1 bone
];

// Legacy minProfit for backward compatibility - findArbitrageOpportunities
export const minProfit = parseEther("3");

export const maxIterations = 100;
export const maxHops = 20;
export const MAX_ENTRIES_PER_TOKEN = 10;

/**
 * Number of top tokens to consider for arbitrage
 * IMPORTANT: This value must not exceed the length of the minProfits array.
 * If you increase this number, make sure to add corresponding entries to the minProfits array.
 * NOTE - the more token you add - it increase the speed +100ms when searching(e.g if 3 means 300ms total)
 */
export const TOP_TOKENS_FOR_ARBITRAGE = 7;

export const DEBUG = true;
export const WSS_ENABLED = false; //enable this only when you are on a chain with wss support or better wss
export const NERK = false;


export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 500000n;
export const BASE_FEE = parseGwei("4.7");
export const LEGACY = true;

// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';