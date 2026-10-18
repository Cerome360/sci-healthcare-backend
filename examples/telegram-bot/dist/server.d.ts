import { type Server } from 'node:http';
export interface WebhookServerOptions {
    webhookSecret: string;
    botToken?: string | undefined;
    chatId?: string | undefined;
    logger?: ((msg: string) => void) | undefined;
    fetchImpl?: typeof fetch | undefined;
    onMessagePosted?: ((message: string) => void) | undefined;
}
export declare function createWebhookServer(options: WebhookServerOptions): Server;
