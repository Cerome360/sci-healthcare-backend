import { fileURLToPath } from 'node:url';
import { createWebhookServer } from './server.js';
export * from './bot.js';
export * from './formatter.js';
export * from './server.js';
export * from './verify.js';
// Auto-start server when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const port = Number(process.env.PORT ?? 3001);
    const webhookSecret = process.env.WEBHOOK_SECRET ?? 'example-webhook-secret-do-not-use-in-prod';
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
        console.warn('Notice: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not provided. Running in mock demonstration mode.');
    }
    const server = createWebhookServer({
        webhookSecret,
        botToken,
        chatId,
        logger: console.log,
    });
    server.listen(port, () => {
        console.log(`Clinic Telegram Webhook Bot running at http://localhost:${port}/webhook`);
        console.log(`Listening for signed voucher notifications (HMAC-SHA256)`);
    });
}
