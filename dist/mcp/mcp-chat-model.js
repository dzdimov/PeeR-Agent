/**
 * MCP Chat Model Adapter
 *
 * LangChain BaseChatModel implementation that routes LLM requests
 * through the MCP sampling capability back to the connected client.
 * This allows PRAnalyzerAgent to use the client's LLM (Claude Code, Cursor, etc.)
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage } from '@langchain/core/messages';
/**
 * Convert LangChain messages to MCP message format
 */
function convertToMCPMessages(messages) {
    return messages.map(msg => {
        let role = 'user';
        if (msg instanceof AIMessage) {
            role = 'assistant';
        }
        else if (msg instanceof SystemMessage) {
            // MCP doesn't have system role, prepend to user message
            role = 'user';
        }
        return {
            role,
            content: {
                type: 'text',
                text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            },
        };
    });
}
/**
 * MCP Chat Model - Routes LLM requests through MCP sampling to the client
 */
export class MCPChatModel extends BaseChatModel {
    mcpServer;
    maxTokens;
    constructor(mcpServer, options) {
        super({});
        this.mcpServer = mcpServer;
        this.maxTokens = options?.maxTokens || 4000;
    }
    _llmType() {
        return 'mcp-sampling';
    }
    async _generate(messages, _options, _runManager) {
        try {
            // Convert messages to MCP format
            const mcpMessages = convertToMCPMessages(messages);
            // Request completion from the connected client via MCP sampling
            const response = await this.mcpServer.createMessage({
                messages: mcpMessages,
                maxTokens: this.maxTokens,
            });
            // Extract text from response
            let responseText = '';
            if (response.content.type === 'text') {
                responseText = response.content.text;
            }
            else if (response.content.type === 'image') {
                responseText = '[Image response not supported]';
            }
            // Return as LangChain ChatResult
            const generation = {
                text: responseText,
                message: new AIMessage(responseText),
            };
            return {
                generations: [generation],
                llmOutput: {
                    model: response.model || 'mcp-client-model',
                    stopReason: response.stopReason,
                },
            };
        }
        catch (error) {
            // If sampling is not supported by the client, throw a clear error
            if (error.message?.includes('not supported') || error.message?.includes('sampling')) {
                throw new Error('MCP sampling not supported by the connected client. ' +
                    'The client must support the sampling capability for AI-powered analysis. ' +
                    'Consider using API keys in .pragent.config.json instead.');
            }
            throw error;
        }
    }
    /**
     * Check if the MCP server's client supports sampling
     */
    static async isSupported(mcpServer) {
        try {
            // Try to get server capabilities - sampling requires client support
            // This is a simplified check; actual support depends on the client
            return true; // We'll let it fail at runtime if not supported
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=mcp-chat-model.js.map