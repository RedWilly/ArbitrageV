import dotenv from "dotenv";
import { parseEther, parseGwei } from "viem";
dotenv.config();

export const CHAIN_ID = 109;

export const RPC_URL = process.env.RPC_URL;

export const PRIVATE_KEY = process.env.PRIVATE_KEY;

export const ARB_CONTRACT = process.env.ARB_CONTRACT_ADDRESS;

export const UNISWAP_FLASH_QUERY_CONTRACT =
    process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS;

export const TAX_CHECKER_ADDRESS= process.env.TAX_CHECKER_ADDRESS;

export const ADDRESSES: { name: string; address: `0x${string}`; LPAMOUNT: string }[] = [
    { name: "WETH", address: "0xC76F4c819D820369Fb2d7C1531aB3Bb18e6fE8d8" as `0x${string}`, LPAMOUNT: parseEther("50").toString() },
    { name: "WETH2", address: "0x839FdB6cc98342B428E074C1573ADF6D48CA3bFd" as `0x${string}`, LPAMOUNT: parseEther("50").toString() },
    { name: "SHIB", address: "0x495eea66B0f8b636D441dC6a98d8F5C3D455C4c0" as `0x${string}`, LPAMOUNT: parseEther("1000000").toString() }, //shib
    { name: "WETH3", address: "0x8ed7d143Ef452316Ab1123d28Ab302dC3b80d3ce" as `0x${string}`, LPAMOUNT: parseEther("0.14").toString()}, // weth
    { name: "DAMN", address: "0xeCe898EdCc0AF91430603175F945D8de75291c70" as `0x${string}`, LPAMOUNT: parseEther("500000000").toString() } //damn
];

export const NERK = true;

//factory addresses and fees
export const FACTORY: { name: string; address: `0x${string}`; fee: number }[] = [
    { name: "woolfPro", address: "0x5c6C40CAe6f57b782D8Ff445258989aaC73D5074" as `0x${string}`, fee: 10 },
    { name: "chewy", address: "0xEDedDbde5ffA62545eDF97054edC11013ED72125" as `0x${string}`, fee: 25 },
    { name: "shiba", address: "0xc2b4218F137e3A5A9B98ab3AE804108F0D312CBC" as `0x${string}`, fee: 30 },
    { name: "mars", address: "0xBe0223f65813C7c82E195B48F8AAaAcb304FbAe7" as `0x${string}`, fee: 20 },
    { name: "pumk", address: "0x5640113EA7F369E6DAFbe54cBb1406E5BF153E90" as `0x${string}`, fee: 20 },
    { name: "woof", address: "0xB9fbdFA27B7ba8BB2d4bB4aB399e4c55F0F7F83a" as `0x${string}`, fee: 20 },
];

export const minProfit = parseEther("0.05"); //0.1 WETH - minimum profit
export const maxIterations = 100;
export const maxHops = 10;
export const MAX_ENTRIES_PER_TOKEN = 10;

export const DEBUG = false;

export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 3000000n;
export const BASE_FEE = parseGwei("2.5");
// export const MAX_FEE = 60;
// export const MAX_PRIORITY_FEE = 60;


// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';