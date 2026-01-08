# PR Agent Plugin for Claude Code

AI-powered pull request analyzer that integrates with Claude Code via MCP.

## Features

- **Analyze Diffs**: Get AI-powered analysis of code changes
- **Branch Comparison**: Compare current branch against base branch
- **Dashboard Stats**: View analysis metrics and ROI
- **Recent Analyses**: Access history of PR analyses
- **Save Results**: Store analysis results for tracking

## How It Works

This MCP server provides tools that return diff data and analysis context. The **calling tool's LLM** (e.g., Claude in Claude Code) performs the actual analysis - no separate API keys needed.

## Installation

### Option 1: Local Plugin

```bash
claude --plugin-dir /path/to/pr-agent/pr-agent-plugin
```

### Option 2: Copy to Project

Copy `pr-agent-plugin/` to your project's `.claude-plugin/` directory.

### Option 3: Add to MCP Settings

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "pr-agent": {
      "command": "node",
      "args": ["/path/to/pr-agent/pr-agent-plugin/server/index.js"],
      "env": {
        "PR_AGENT_ROOT": "/path/to/pr-agent"
      }
    }
  }
}
```

## MCP Tools

### `analyze_diff`
Get a diff ready for AI analysis. Returns the diff content with context and instructions for the calling LLM.

**Parameters:**
- `diff` (required): The diff text to analyze
- `title` (optional): PR title for context

**Returns:** Formatted diff with analysis instructions for the LLM

### `analyze_branch`
Get current branch diff for AI analysis. Returns the diff between current branch and base branch.

**Parameters:**
- `branch` (optional): Base branch to compare against (default: origin/main)
- `cwd` (optional): Working directory of the repo

**Returns:** Formatted branch diff with context and analysis instructions

### `get_dashboard_stats`
Get analysis metrics and statistics from the local database.

**Parameters:** None

**Returns:** Dashboard statistics including total PRs, success rate, ROI metrics

### `get_recent_analyses`
Get recent PR analysis history.

**Parameters:**
- `limit` (optional): Number of results (default: 10)

**Returns:** Table of recent analyses with PR info

### `save_analysis`
Save analysis results to the local database for dashboard tracking.

**Parameters:**
- `title` (required): PR title
- `complexity` (required): Complexity score (1-5)
- `pr_number` (optional): PR number
- `repo_owner` (optional): Repository owner
- `repo_name` (optional): Repository name
- `author` (optional): PR author
- `risks_count` (optional): Number of risks
- `risks` (optional): Array of risk descriptions
- `recommendations` (optional): Array of recommendations

## Commands

- `/pr-analyze` - Analyze current branch
- `/pr-stats` - Show dashboard statistics
- `/pr-recent` - Show recent analyses

## Example Usage

```
User: Analyze my current branch changes
Claude: [Uses analyze_branch tool, then performs analysis with its own LLM]

User: /pr-stats
Claude: [Shows dashboard metrics from local database]
```

## Architecture

```
┌──────────────────────┐
│  Claude Code / LLM   │  ← Performs the actual AI analysis
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  PR Agent MCP Server │  ← Returns diff data + instructions
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Git Repository      │  ← Source of diffs
│  SQLite Database     │  ← Stores analysis history
└──────────────────────┘
```

The MCP server is **LLM-agnostic** - it provides the data and context, while the calling tool's LLM performs the actual analysis. This means:
- No API keys needed in the plugin
- Works with any MCP-compatible tool
- Uses the host tool's AI capabilities
