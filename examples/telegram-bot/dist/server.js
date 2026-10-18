import { createServer } from 'node:http';
import { sendTelegramNotification } from './bot.js';
import { formatTelegramMessage } from './formatter.js';
import { verifySignature } from './verify.js';
export function createWebhookServer(options) {
    const { webhookSecret, botToken = process.env.TELEGRAM_BOT_TOKEN ?? 'mock-token', chatId = process.env.TELEGRAM_CHAT_ID ?? '12345678', logger = console.log, fetchImpl = fetch, onMessagePosted, } = options;
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (req.method !== 'POST' || url.pathname !== '/webhook') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found', message: 'Endpoint not found' }));
            return;
        }
        // Read full raw request body
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
            const rawBody = Buffer.concat(chunks);
            const signatureHeader = req.headers['x-sci-signature'] ??
                req.headers['X-SCI-Signature'];
            // Verify HMAC-SHA256 signature
            const isValid = verifySignature(rawBody, signatureHeader, webhookSecret);
            if (!isValid) {
                logger('Rejected webhook with invalid or missing signature');
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'invalid_signature',
                    message: 'Signature header X-SCI-Signature is missing or invalid',
                }));
                return;
            }
            // Parse JSON payload
            let payload;
            try {
                payload = JSON.parse(rawBody.toString('utf8'));
            }
            catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_json', message: 'Payload is not valid JSON' }));
                return;
            }
            // Privacy guard: Ensure no beneficiary references exist
            try {
                const message = formatTelegramMessage(payload);
                logger(`Processing webhook for voucher: ${payload.voucherId} (status: ${payload.status})`);
                if (onMessagePosted) {
                    onMessagePosted(message);
                }
                const telegramRes = await sendTelegramNotification(botToken, chatId, message, fetchImpl);
                if (!telegramRes.ok) {
                    logger(`Failed to post to Telegram: ${telegramRes.error}`);
                    res.writeHead(502, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'telegram_error',
                        message: telegramRes.error ?? 'Failed to send to Telegram Bot API',
                    }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    status: 'delivered',
                    voucherId: payload.voucherId,
                }));
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                logger(`Privacy or formatting rejection: ${errorMsg}`);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'payload_rejected', message: errorMsg }));
            }
        });
    });
    return server;
}
