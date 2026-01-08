---
name: PR Agent Usage
description: Use this skill when discussing PR analysis, code review automation, or when the user wants to analyze pull requests, understand code changes, or get insights about their development workflow
version: 1.0.0
---

# PR Agent Usage Skill

This skill provides guidance on using PR Agent for AI-powered pull request analysis.

## Architecture

The PR Agent MCP server is **LLM-agnostic**:
- The MCP server provides diff data and context
- **You** (the calling LLM) perform the actual code analysis
- No separate API keys needed - uses your capabilities

## When to Use This Skill

Activate this skill when the user:
- Wants to analyze code changes or pull requests
- Asks about code review automation
- Needs to understand risks in their changes
- Wants to see analysis metrics or dashboard statistics
- Mentions PR Agent, code analysis, or diff review

## Available MCP Tools

### analyze_diff
Get a diff ready for analysis. Returns the diff content with context.

**Use when**: User provides a diff or wants to analyze specific code changes.

**Parameters**:
- `diff` (required): The diff text to analyze
- `title` (optional): PR title for context

**Your job**: Analyze the returned diff for risks, complexity, and recommendations.

### analyze_branch
Get current branch diff for analysis. Returns the diff between current branch and base branch.

**Use when**: User wants to analyze their current work-in-progress changes.

**Parameters**:
- `branch` (optional): Base branch to compare against (default: origin/main)
- `cwd` (optional): Working directory of the git repository

**Your job**: Analyze the returned diff and provide structured feedback.

### get_dashboard_stats
Get analysis metrics and ROI statistics.

**Use when**: User asks about analysis history, metrics, or wants to see the dashboard.

### get_recent_analyses
Get recent PR analysis history.

**Use when**: User wants to see past analyses or review history.

**Parameters**:
- `limit` (optional): Number of results (default: 10)

### save_analysis
Save analysis results to the dashboard database.

**Use when**: After you complete an analysis, save the results for tracking.

**Parameters**:
- `title` (required): PR title
- `complexity` (required): Your complexity score (1-5)
- `risks` (optional): Array of risk descriptions you identified
- `recommendations` (optional): Array of your recommendations
- `pr_number`, `repo_owner`, `repo_name`, `author` (optional): Metadata

## Commands

- `/pr-analyze` - Analyze current branch and save results
- `/pr-stats` - Show dashboard statistics
- `/pr-recent` - Show recent analysis history

## Analysis Workflow

When analyzing code:

1. **Get the diff**: Call `analyze_branch` or `analyze_diff`
2. **Analyze the code**: You perform the actual analysis
   - Look for logic errors and edge cases
   - Identify security vulnerabilities
   - Assess complexity and maintainability
   - Check for performance implications
3. **Provide structured output**:
   - Summary of changes
   - Risk assessment (Critical/Warning)
   - Complexity score (1-5)
   - Actionable recommendations
4. **Save results**: Call `save_analysis` to track the analysis

## Example Workflows

### Analyze Before Committing
```
User: Can you review my changes before I commit?
Action:
1. Call analyze_branch
2. Analyze the returned diff
3. Provide feedback
4. Call save_analysis with your findings
```

### Check Team Metrics
```
User: How is our team doing with code quality?
Action: Call get_dashboard_stats to show metrics
```

### Review Specific Diff
```
User: Here's a diff I want you to review: [diff content]
Action:
1. Call analyze_diff with the provided diff
2. Analyze it yourself
3. Provide structured feedback
```
