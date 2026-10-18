/**
 * Sends a message to a Telegram chat via the Bot API.
 */
export declare function sendTelegramNotification(token: string, chatId: string, text: string, fetchImpl?: typeof fetch): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
}>;
