---
name: pr-recent
description: Show recent PR analysis history
allowed-tools:
  - mcp__plugin_pr-agent_pr-agent__get_recent_analyses
---

# Recent Analyses Command

Display the most recent PR analyses from the local database.

## Instructions

1. Use the `mcp__plugin_pr-agent_pr-agent__get_recent_analyses` tool
2. Default to showing 10 most recent analyses
3. Present results in a table format

## Information Displayed

For each analysis:
- PR number
- Repository (owner/name)
- Author
- Complexity score
- Risk count
- Analysis date

## Parameters

- **limit**: Number of recent analyses to show (default: 10)

## Example Usage

When the user says "/pr-recent", fetch and display the recent analyses.

If the user specifies a limit (e.g., "/pr-recent 5"), pass that limit to the tool.
