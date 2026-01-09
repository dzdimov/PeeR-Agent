/**
 * Stub Chat Model for MCP Server
 *
 * A LangChain BaseChatModel that always throws, forcing the PRAnalyzerAgent
 * to use its fallback paths. This allows the agent to run static analysis
 * and pattern matching while generating default recommendations.
 *
 * The calling LLM (Claude Code, Cursor, etc.) provides the AI-powered insights
 * after receiving the MCP server's response.
 *
 * Note: When Claude Code adds MCP sampling support (Issue #1785), this can be
 * replaced with MCPChatModel for true pass-through LLM access.
 */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
/**
 * Stub Chat Model - Always throws to trigger fallback paths
 *
 * This ensures PRAnalyzerAgent:
 * 1. Runs static analysis (semgrep, pattern matching)
 * 2. Generates default recommendations via catch blocks
 * 3. Returns consistent results without requiring API keys
 */
export class StubChatModel extends BaseChatModel {
    constructor() {
        super({});
    }
    _llmType() {
        return 'stub-for-mcp';
    }
    async _generate(_messages, _options, _runManager) {
        // Always throw to trigger fallback paths in PRAnalyzerAgent
        // The agent's catch blocks return default recommendations
        throw new Error('MCP stub model: LLM calls are handled by the calling tool (Claude Code). ' +
            'Static analysis and default recommendations will be used.');
    }
}
//# sourceMappingURL=stub-chat-model.js.map