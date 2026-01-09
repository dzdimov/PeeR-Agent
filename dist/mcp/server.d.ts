#!/usr/bin/env node
/**
 * PR Agent MCP Server
 *
 * MCP server that uses the same PRAnalyzerAgent as the CLI.
 * Uses a StubChatModel to trigger fallback paths in PRAnalyzerAgent,
 * which runs static analysis (semgrep, patterns) and generates default recommendations.
 *
 * The calling LLM (Claude Code, Cursor, etc.) provides AI-powered insights
 * after receiving the analysis response.
 *
 * Note: When Claude Code adds MCP sampling support (Issue #1785),
 * the StubChatModel can be replaced with MCPChatModel for true pass-through LLM access.
 */
export {};
