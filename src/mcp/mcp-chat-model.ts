/**
 * MCP Chat Model Adapter
 *
 * LangChain BaseChatModel implementation that routes LLM requests
 * through the MCP sampling capability back to the connected client.
 * This allows PRAnalyzerAgent to use the client's LLM (Claude Code, Cursor, etc.)
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatResult, ChatGeneration } from '@langchain/core/outputs';
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Convert LangChain messages to MCP message format
 */
function convertToMCPMessages(messages: BaseMessage[]): Array<{
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}> {
  return messages.map(msg => {
    let role: 'user' | 'assistant' = 'user';

    if (msg instanceof AIMessage) {
      role = 'assistant';
    } else if (msg instanceof SystemMessage) {
      // MCP doesn't have system role, prepend to user message
      role = 'user';
    }

    return {
      role,
      content: {
        type: 'text' as const,
        text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      },
    };
  });
}

/**
 * MCP Chat Model - Routes LLM requests through MCP sampling to the client
 */
export class MCPChatModel extends BaseChatModel {
  private mcpServer: Server;
  private maxTokens: number;

  constructor(mcpServer: Server, options?: { maxTokens?: number }) {
    super({});
    this.mcpServer = mcpServer;
    this.maxTokens = options?.maxTokens || 4000;
  }

  _llmType(): string {
    return 'mcp-sampling';
  }

  async _generate(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
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
      } else if (response.content.type === 'image') {
        responseText = '[Image response not supported]';
      }

      // Return as LangChain ChatResult
      const generation: ChatGeneration = {
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
    } catch (error: any) {
      // If sampling is not supported by the client, throw a clear error
      if (error.message?.includes('not supported') || error.message?.includes('sampling')) {
        throw new Error(
          'MCP sampling not supported by the connected client. ' +
          'The client must support the sampling capability for AI-powered analysis. ' +
          'Consider using API keys in .pragent.config.json instead.'
        );
      }
      throw error;
    }
  }

  /**
   * Check if the MCP server's client supports sampling
   */
  static async isSupported(mcpServer: Server): Promise<boolean> {
    try {
      // Try to get server capabilities - sampling requires client support
      // This is a simplified check; actual support depends on the client
      return true; // We'll let it fail at runtime if not supported
    } catch {
      return false;
    }
  }
}
