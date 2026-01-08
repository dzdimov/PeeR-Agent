/**
 * MCP Chat Model Adapter
 *
 * LangChain BaseChatModel implementation that routes LLM requests
 * through the MCP sampling capability back to the connected client.
 * This allows PRAnalyzerAgent to use the client's LLM (Claude Code, Cursor, etc.)
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage } from '@langchain/core/messages';
import { ChatResult } from '@langchain/core/outputs';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * MCP Chat Model - Routes LLM requests through MCP sampling to the client
 */
export declare class MCPChatModel extends BaseChatModel {
    private mcpServer;
    private maxTokens;
    constructor(mcpServer: Server, options?: {
        maxTokens?: number;
    });
    _llmType(): string;
    _generate(messages: BaseMessage[], _options?: this['ParsedCallOptions'], _runManager?: CallbackManagerForLLMRun): Promise<ChatResult>;
    /**
     * Check if the MCP server's client supports sampling
     */
    static isSupported(mcpServer: Server): Promise<boolean>;
}
