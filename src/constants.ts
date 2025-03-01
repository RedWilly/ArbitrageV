import dotenv from "dotenv";
import { parseEther, parseGwei } from "viem";
dotenv.config();

export const CHAIN_ID = 109;

export const RPC_URL = process.env.RPC_URL;
export const WSS_URL = process.env.WSS_URL;

export const PRIVATE_KEY = process.env.PRIVATE_KEY;

export const ARB_CONTRACT = process.env.ARB_CONTRACT_ADDRESS;

export const UNISWAP_FLASH_QUERY_CONTRACT =
    process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS;

export const ADDRESSES: { name: string; address: `0x${string}`; LPAMOUNT: string }[] = [
    { name: "WETH", address: "0xC76F4c819D820369Fb2d7C1531aB3Bb18e6fE8d8" as `0x${string}`, LPAMOUNT: parseEther("50").toString() },
    { name: "WETH2", address: "0x839FdB6cc98342B428E074C1573ADF6D48CA3bFd" as `0x${string}`, LPAMOUNT: parseEther("50").toString() },
    { name: "SHIB", address: "0x495eea66B0f8b636D441dC6a98d8F5C3D455C4c0" as `0x${string}`, LPAMOUNT: parseEther("1000000").toString() }, //shib
    { name: "WETH3", address: "0x8ed7d143Ef452316Ab1123d28Ab302dC3b80d3ce" as `0x${string}`, LPAMOUNT: parseEther("0.14").toString()}, // weth
    { name: "DAMN", address: "0xeCe898EdCc0AF91430603175F945D8de75291c70" as `0x${string}`, LPAMOUNT: parseEther("500000000").toString() } //damn
];

export const NERK = true;

//factory addresses, fees and volatile( volatile DEX and exclude stable pairs ingetinfo)
export const FACTORY: { name: string; address: `0x${string}`; fee: number; volatile: boolean }[] = [
    { name: "woolfPro", address: "0x5c6C40CAe6f57b782D8Ff445258989aaC73D5074" as `0x${string}`, fee: 10, volatile: false }, //0.1%
    { name: "chewy", address: "0xEDedDbde5ffA62545eDF97054edC11013ED72125" as `0x${string}`, fee: 25, volatile: false }, //0.25%
    { name: "shiba", address: "0xc2b4218F137e3A5A9B98ab3AE804108F0D312CBC" as `0x${string}`, fee: 30, volatile: false }, //0.3%
    { name: "mars", address: "0xBe0223f65813C7c82E195B48F8AAaAcb304FbAe7" as `0x${string}`, fee: 20, volatile: false }, //0.2%
    { name: "pumk", address: "0x5640113EA7F369E6DAFbe54cBb1406E5BF153E90" as `0x${string}`, fee: 20, volatile: false },
    { name: "woof", address: "0xB9fbdFA27B7ba8BB2d4bB4aB399e4c55F0F7F83a" as `0x${string}`, fee: 20, volatile: true },
];

export const V3_Pools: { name: string; address: `0x${string}`; fee: number; }[] = [
    { name: "LEASH/WETH", address: "0x8c5BF9dbD297AEE1762114647eFbCf3040DF9Beb" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "KnBONE/WBONE", address: "0x11aa9D3D9728641e08D9fe4d1bCF286090dc2760" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "RYOSHI/WBONE", address: "0x0fE6189AC54Ca3aac59421DC49C9991F564621a8" as `0x${string}`, fee: 10000 }, //1% (for v3)
    { name: "ROAR/WBONE", address: "0x88D8917eDdC0510ee0639EdB60854047a6Fa4557" as `0x${string}`, fee: 10000 }, //1% (for v3)
    { name: "SHIFU/WBONE", address: "0x158dfbd6e5cf63743eb7801821e624a80eb1616c" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "LEASH/SHIB", address: "0x1AfB34A7384D27dB454B6dC433b9b163f335708d" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "SHIB/WBONE", address: "0x0b9240905a60ddaa260044f3a6cd63b6ef37ae22" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "LEASH/WBONE", address: "0x5d9c344Ca2C58Af9D48CfC801DBE688f25C5158f" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "LEASH/WBONE", address: "0xfb8b7c4738543B26c308448B8A95285efD7586cc" as `0x${string}`, fee: 10000 }, //0.3% (for v3)
    { name: "TREAT/WBONE", address: "0x114a97501f668105fE4a7CCcc3F7D048EF2112e9" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "ROAR/SHIB", address: "0x0d7faED1112bd3394ADa0aa967A7B133CD8612F8" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "WETH/WBONE", address: "0x42C6FD7B750CD712c8c9FFa645a93fE88DFe3Ac0" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "FEED/WBONE", address: "0xC1565264d4F392F534e9bA8d601A5bc5724Ba7fE" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "USDT/USDC", address: "0x12F94ca643C8Cc4f6B92B73DA6847Dd13d4F3cD0" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
    { name: "USDC/DAI", address: "0x03FD4f6F8552659DC2DF71037fF4754781906eef" as `0x${string}`, fee: 3000 }, //0.3% (for v3)
];

export const minProfit = parseEther("0.003"); //0.1 WETH - minimum profit
export const maxIterations = 100;
export const maxHops = 10;
export const MAX_ENTRIES_PER_TOKEN = 10;

export const DEBUG = true;
export const WSS_ENABLED = true; //enable this only when you are on a chain with wss support or better wss

export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 700000n;
export const BASE_FEE = parseGwei("2.5");

// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';