# PR Agent MCP Server

[![npm version](https://badge.fury.io/js/pr-agent-mcp.svg)](https://www.npmjs.com/package/pr-agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP (Model Context Protocol) server that provides AI-powered pull request analysis capabilities to any MCP-compatible tool like Claude Code, Cursor, or other AI assistants.

## Overview

PR Agent MCP Server exposes code review functionality through the Model Context Protocol, allowing AI assistants to:

- Analyze git diffs for risks, complexity, and code quality issues
- Compare branches and provide structured code review feedback
- Track analysis metrics and ROI in a local dashboard
- Save and retrieve analysis history

### Key Design Principle: LLM-Agnostic

This MCP server is **LLM-agnostic** - it provides diff data and analysis context, while the **calling tool's LLM** performs the actual code review. This means:

- **No API keys required** in the MCP server configuration
- Works with **any AI model** used by the host application
- Leverages the full capabilities of Claude, GPT, or any other LLM

```
┌──────────────────────────┐
│  AI Assistant (Claude)   │  ← Performs the actual analysis
└───────────┬──────────────┘
            │ MCP Protocol
            ▼
┌──────────────────────────┐
│   PR Agent MCP Server    │  ← Returns diff data + instructions
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│  Git Repository + SQLite │  ← Data sources
└──────────────────────────┘
```

## Installation

### Option 1: npm (Recommended)

```bash
npm install -g pr-agent-mcp
```

### Option 2: From Source

```bash
git clone https://github.com/techdebtgpt/pr-agent.git
cd pr-agent/pr-agent-plugin
npm install
```

## Configuration

### For Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "pr-agent": {
      "command": "npx",
      "args": ["pr-agent-mcp"]
    }
  }
}
```

### For Cursor

Add to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "pr-agent": {
      "command": "npx",
      "args": ["pr-agent-mcp"]
    }
  }
}
```

### For Other MCP Clients

```json
{
  "pr-agent": {
    "command": "node",
    "args": ["/path/to/pr-agent-plugin/server/index.js"]
  }
}
```

## MCP Tools

### `analyze_diff`

Get a diff ready for AI analysis. Returns the diff content with structured context and analysis instructions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `diff` | string | Yes | The diff text to analyze |
| `title` | string | No | PR title for context |

**Example:**
```json
{
  "name": "analyze_diff",
  "arguments": {
    "diff": "diff --git a/src/app.js b/src/app.js\n...",
    "title": "Add user authentication"
  }
}
```

---

### `analyze_branch`

Get current branch diff for AI analysis. Compares the current branch against a base branch.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `branch` | string | No | `origin/main` | Base branch to compare against |
| `cwd` | string | No | Current directory | Working directory of the git repository |

**Example:**
```json
{
  "name": "analyze_branch",
  "arguments": {
    "branch": "origin/develop"
  }
}
```

---

### `get_dashboard_stats`

Get PR analysis statistics and ROI metrics from the local database.

**Parameters:** None

**Example Response:**
```
# PR Agent Dashboard Statistics

## Overview
- Total PRs Analyzed: 42
- Success Rate: 85.7%
- Average Complexity: 2.3

## ROI Metrics
- Hours Saved: 10.5
- Estimated Cost Savings: $630
```

---

### `get_recent_analyses`

Get recent PR analysis history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 10 | Maximum number of results |

---

### `save_analysis`

Save analysis results to the local database for dashboard tracking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | PR title |
| `complexity` | number | Yes | Complexity score (1-5) |
| `pr_number` | number | No | PR number or identifier |
| `repo_owner` | string | No | Repository owner |
| `repo_name` | string | No | Repository name |
| `author` | string | No | PR author |
| `risks_count` | number | No | Number of risks identified |
| `risks` | string[] | No | Array of risk descriptions |
| `recommendations` | string[] | No | Array of recommendations |

## Usage Examples

### Analyzing Current Branch

```
User: Review my current branch changes

AI Assistant:
1. Calls analyze_branch tool
2. Receives diff with context
3. Analyzes code for risks, complexity, issues
4. Provides structured feedback
5. Optionally saves results with save_analysis
```

### Checking Dashboard Metrics

```
User: How is our team doing with code quality?

AI Assistant:
1. Calls get_dashboard_stats tool
2. Displays metrics summary
```

### Reviewing a Specific Diff

```
User: Here's a diff I want reviewed: [paste diff]

AI Assistant:
1. Calls analyze_diff with provided diff
2. Performs analysis
3. Returns structured review
```

## Development

### Running Locally

```bash
cd pr-agent-plugin
npm install
node server/index.js
```

### Testing

The server communicates via stdio. You can test with:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server/index.js
```

## Requirements

- Node.js >= 18.0.0
- Git (for branch analysis)

## License

MIT - See [LICENSE](../LICENSE) for details.

## Contributing

Contributions welcome! Please read the [contributing guidelines](../CONTRIBUTING.md) first.

## Related Projects

- [PR Agent CLI](https://github.com/techdebtgpt/pr-agent) - Full PR Agent with CLI and GitHub Action
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification