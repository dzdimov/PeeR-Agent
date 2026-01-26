import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ILLMProvider, ProviderConfig } from './provider.interface.js';

/**
 * OpenRouter provider implementation (OpenAI-compatible)
 */
export class OpenRouterProvider implements ILLMProvider {
    public readonly name = 'openrouter';
    private readonly apiKey: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey || process.env.OPENROUTER_API_KEY || '';
    }

    public isConfigured(): boolean {
        return !!this.apiKey;
    }

    public getDefaultModel(): string {
        return 'anthropic/claude-3-opus';
    }

    public getChatModel(config: ProviderConfig = {}): BaseChatModel {
        if (!this.isConfigured()) {
            throw new Error('OpenRouter API key is not configured');
        }

        return new ChatOpenAI({
            apiKey: this.apiKey,
            modelName: config.model || this.getDefaultModel(),
            temperature: config.temperature ?? 0.2,
            maxTokens: config.maxTokens ?? 50000,
            configuration: {
                baseURL: 'https://openrouter.ai/api/v1',
                defaultHeaders: {
                    'HTTP-Referer': 'https://github.com/techdebtgpt/pr-agent',
                    'X-Title': 'PR Agent',
                }
            }
        });
    }
}
