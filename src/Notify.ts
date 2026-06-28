import TelegramBot from 'node-telegram-bot-api';
import { formatEther, type Address } from 'viem';
import { ADDRESSES, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './constants';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Notifications will be disabled.');
}

class NotificationService {
  private bot: TelegramBot | null = null;
  private static instance: NotificationService;

  private constructor() {
    if (TELEGRAM_BOT_TOKEN) {
      this.bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    }
  }

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  async sendTransactionNotification(
    hash: string,
    type: 'flashswap' | 'direct',
    expectedProfit: bigint,
    tokenAddress?: Address
  ): Promise<void> {
    if (!this.bot || !TELEGRAM_CHAT_ID) return;

    const status = expectedProfit > 0n ? 'PROFIT' : 'WARNING';
    const tokenName = this.resolveTokenName(tokenAddress);
    const message =
      `<b>${status}: Arbitrage Transaction</b>\n\n` +
      `<b>Type:</b> ${type === 'flashswap' ? 'Flash Swap' : 'Direct Swap'}\n` +
      `<b>Expected Profit:</b> ${formatEther(expectedProfit)} ${tokenName}\n\n` +
      `<b>Transaction:</b>\n` +
      `<code>${hash}</code>\n\n` +
      `<a href="https://www.shibariumscan.io/tx/${hash}">View on Explorer</a>`;

    try {
      await this.bot.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      console.error('Failed to send Telegram notification:', error);
    }
  }

  async sendErrorNotification(error: string): Promise<void> {
    if (!this.bot || !TELEGRAM_CHAT_ID) return;

    const message =
      `<b>Arbitrage Error</b>\n\n` +
      `<b>Error Details:</b>\n` +
      `<code>${error}</code>`;

    try {
      await this.bot.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
      });
    } catch (error) {
      console.error('Failed to send Telegram error notification:', error);
    }
  }

  private resolveTokenName(tokenAddress?: Address): string {
    if (!tokenAddress) return ADDRESSES[0]?.name || 'Unknown';

    const token = ADDRESSES.find(addr => addr.address.toLowerCase() === tokenAddress.toLowerCase());
    return token?.name || 'Unknown';
  }
}

export const notificationService = NotificationService.getInstance();
