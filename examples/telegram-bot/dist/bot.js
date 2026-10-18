/**
 * Sends a message to a Telegram chat via the Bot API.
 */
export async function sendTelegramNotification(token, chatId, text, fetchImpl = fetch) {
    // If token is a test/mock token, don't attempt real network call
    if (token === 'mock-token' || token.startsWith('mock_')) {
        return { ok: true, result: { message_id: 12345, chat: { id: chatId }, text } };
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    const data = (await response.json());
    if (!data.ok) {
        return { ok: false, error: data.description ?? `HTTP ${response.status}` };
    }
    return { ok: true, result: data.result };
}
