---
name: pr-stats
description: Show PR Agent dashboard statistics and ROI metrics
allowed-tools:
  - mcp__plugin_pr-agent_pr-agent__get_dashboard_stats
---

# PR Statistics Command

Display dashboard statistics from PR Agent including analysis metrics, ROI calculations, and trends.

## Instructions

1. Use the `mcp__plugin_pr-agent_pr-agent__get_dashboard_stats` tool to fetch statistics
2. Present the data in a clear, organized format
3. Highlight key metrics like total PRs, success rate, and cost savings

## Metrics Displayed

- **Total PRs Analyzed**: Count of all analyzed pull requests
- **Success Rate**: Percentage of PRs with low complexity and no risks
- **Average Complexity**: Mean complexity score across all PRs
- **ROI Metrics**: Hours saved and estimated cost savings
- **Complexity Distribution**: Low/Medium/High breakdown
- **Top Contributors**: Most active PR authors
- **Common Recommendations**: Frequently suggested improvements

## Example Output Format

Present the statistics in a readable format with sections for each metric category.
