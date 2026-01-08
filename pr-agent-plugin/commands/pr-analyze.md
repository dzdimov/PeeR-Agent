---
name: pr-analyze
description: Analyze the current branch changes with AI-powered code review
allowed-tools:
  - mcp__plugin_pr-agent_pr-agent__analyze_branch
  - mcp__plugin_pr-agent_pr-agent__save_analysis
  - Bash
---

# PR Analysis Command

Analyze the current branch changes against the base branch using AI-powered code review.

## Instructions

1. Use the `mcp__plugin_pr-agent_pr-agent__analyze_branch` tool to get the diff
2. The tool returns the diff with analysis instructions - analyze it yourself
3. Provide a structured analysis with:
   - **Summary**: What changes were made
   - **Risk Assessment**: Critical issues and warnings
   - **Complexity Score**: 1-5 rating
   - **Recommendations**: Actionable improvements
4. After analyzing, use `mcp__plugin_pr-agent_pr-agent__save_analysis` to save the results to the dashboard

## Default Behavior

- Compares current branch against `origin/main`
- You (the LLM) perform the actual code analysis
- Results are saved to the local dashboard database

## Example Workflow

When the user says "/pr-analyze":

1. Call `analyze_branch` to get the diff
2. Read and analyze the diff content
3. Provide structured feedback
4. Call `save_analysis` with your findings (complexity score, risks, recommendations)
