#!/usr/bin/env node

/**
 * PR Agent MCP Server
 *
 * Exposes PR Agent functionality as MCP tools for any MCP-compatible tool.
 * The analysis is performed by the calling tool's LLM, not by this server.
 *
 * Modes:
 * - MCP Server: Returns data for the calling LLM to analyze
 * - Standalone/GitHub Action: Uses configured API keys for AI analysis
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve PR Agent root from environment or relative path
const PR_AGENT_ROOT = process.env.PR_AGENT_ROOT || path.resolve(__dirname, '../..');

// Dynamic imports from parent PR Agent (for dashboard/db functions only)
let getDashboardStats, getRecentAnalyses, saveAnalysis;

async function loadDependencies() {
  try {
    // Convert path to file:// URL for ESM compatibility on Windows
    const dbPath = path.join(PR_AGENT_ROOT, 'dist/db/index.js');
    const dbUrl = new URL(`file:///${dbPath.replace(/\\/g, '/')}`).href;
    const dbModule = await import(dbUrl);
    getDashboardStats = dbModule.getDashboardStats;
    getRecentAnalyses = dbModule.getRecentAnalyses;
    saveAnalysis = dbModule.saveAnalysis;
  } catch (error) {
    console.error('Warning: Could not load PR Agent db module:', error.message);
    // Provide fallback implementations
    getDashboardStats = () => ({ totalPRs: 0, successRate: 0, avgComplexity: 0, roi: { hoursSaved: 0, moneySaved: 0 } });
    getRecentAnalyses = () => [];
    saveAnalysis = () => {};
  }
}

/**
 * Get git diff for branch comparison
 */
function getGitDiff(baseBranch, cwd) {
  try {
    const diff = execSync(`git diff ${baseBranch}`, {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      maxBuffer: 200 * 1024 * 1024,
    });
    return diff.trim();
  } catch (error) {
    throw new Error(`Failed to get diff from ${baseBranch}: ${error.message}`);
  }
}

/**
 * Get current branch name
 */
function getCurrentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get PR title from git commit message
 */
function getPRTitle(cwd) {
  try {
    return execSync('git log -1 --pretty=%B', {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
    }).trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/**
 * Get repository info from git remote
 */
function getRepoInfo(cwd) {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
    }).trim();

    const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], name: sshMatch[2] };
    }
    const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], name: httpsMatch[2] };
    }
    return { owner: 'local', name: 'unknown' };
  } catch {
    return { owner: 'local', name: 'unknown' };
  }
}

/**
 * Parse diff to extract file information
 */
function parseDiffFiles(diff) {
  const files = [];
  const filePattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match;

  while ((match = filePattern.exec(diff)) !== null) {
    const filePath = match[2] !== '/dev/null' ? match[2] : match[1];
    const isNew = match[1] === '/dev/null' || match[1].startsWith('dev/null');
    const isDeleted = match[2] === '/dev/null';

    files.push({
      path: filePath,
      status: isNew ? 'added' : isDeleted ? 'deleted' : 'modified',
    });
  }

  return files;
}

// Create MCP server
const server = new Server(
  {
    name: 'pr-agent',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'analyze_diff',
        description: 'Get a diff ready for AI analysis. Returns the diff content with context for the calling LLM to analyze for risks, complexity, and recommendations.',
        inputSchema: {
          type: 'object',
          properties: {
            diff: {
              type: 'string',
              description: 'The diff text to analyze',
            },
            title: {
              type: 'string',
              description: 'Optional PR title for context',
            },
          },
          required: ['diff'],
        },
      },
      {
        name: 'analyze_branch',
        description: 'Get current branch diff for AI analysis. Returns the diff between current branch and base branch for the calling LLM to analyze.',
        inputSchema: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              description: 'Base branch to compare against (default: origin/main)',
              default: 'origin/main',
            },
            cwd: {
              type: 'string',
              description: 'Working directory of the git repository',
            },
          },
        },
      },
      {
        name: 'get_dashboard_stats',
        description: 'Get PR analysis statistics and metrics for the dashboard',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_recent_analyses',
        description: 'Get recent PR analysis history',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)',
              default: 10,
            },
          },
        },
      },
      {
        name: 'save_analysis',
        description: 'Save an analysis result to the local database for dashboard tracking',
        inputSchema: {
          type: 'object',
          properties: {
            pr_number: {
              type: 'number',
              description: 'PR number or identifier',
            },
            repo_owner: {
              type: 'string',
              description: 'Repository owner',
            },
            repo_name: {
              type: 'string',
              description: 'Repository name',
            },
            author: {
              type: 'string',
              description: 'PR author',
            },
            title: {
              type: 'string',
              description: 'PR title',
            },
            complexity: {
              type: 'number',
              description: 'Complexity score (1-5)',
            },
            risks_count: {
              type: 'number',
              description: 'Number of risks identified',
            },
            risks: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of risk descriptions',
            },
            recommendations: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of recommendations',
            },
          },
          required: ['title', 'complexity'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'analyze_diff': {
        const files = parseDiffFiles(args.diff);
        const diffSize = args.diff.length;
        const estimatedTokens = Math.ceil(diffSize / 4);

        // Return structured data for the calling LLM to analyze
        return {
          content: [
            {
              type: 'text',
              text: `# PR Diff Analysis Request

## Context
${args.title ? `**Title:** ${args.title}` : ''}
**Files Changed:** ${files.length}
**Diff Size:** ${(diffSize / 1024).toFixed(1)} KB (~${estimatedTokens.toLocaleString()} tokens)

## Files Modified
${files.map(f => `- ${f.path} (${f.status})`).join('\n')}

## Diff Content

\`\`\`diff
${args.diff}
\`\`\`

## Analysis Instructions

Please analyze this diff and provide:

1. **Summary**: Brief description of what changes were made
2. **Risk Assessment**: Identify potential issues, bugs, or security concerns
   - Critical: Must fix before merge
   - Warning: Should review carefully
3. **Complexity Score**: Rate 1-5 (1=trivial, 5=highly complex)
4. **Recommendations**: Actionable suggestions for improvement

Focus on:
- Logic errors and edge cases
- Security vulnerabilities (injection, XSS, etc.)
- Performance implications
- Code quality and maintainability
- Test coverage gaps`,
            },
          ],
        };
      }

      case 'analyze_branch': {
        const baseBranch = args.branch || 'origin/main';
        const cwd = args.cwd || process.cwd();

        const diff = getGitDiff(baseBranch, cwd);
        if (!diff) {
          return {
            content: [
              {
                type: 'text',
                text: `No changes found between current branch and ${baseBranch}`,
              },
            ],
          };
        }

        const title = getPRTitle(cwd);
        const currentBranch = getCurrentBranch(cwd);
        const repoInfo = getRepoInfo(cwd);
        const files = parseDiffFiles(diff);
        const diffSize = diff.length;
        const estimatedTokens = Math.ceil(diffSize / 4);

        return {
          content: [
            {
              type: 'text',
              text: `# Branch Analysis Request

## Context
**Repository:** ${repoInfo.owner}/${repoInfo.name}
**Current Branch:** ${currentBranch}
**Base Branch:** ${baseBranch}
${title ? `**Commit Title:** ${title}` : ''}
**Files Changed:** ${files.length}
**Diff Size:** ${(diffSize / 1024).toFixed(1)} KB (~${estimatedTokens.toLocaleString()} tokens)

## Files Modified
${files.map(f => `- ${f.path} (${f.status})`).join('\n')}

## Diff Content

\`\`\`diff
${diff}
\`\`\`

## Analysis Instructions

Please analyze this diff and provide:

1. **Summary**: Brief description of what changes were made
2. **Risk Assessment**: Identify potential issues, bugs, or security concerns
   - Critical: Must fix before merge
   - Warning: Should review carefully
3. **Complexity Score**: Rate 1-5 (1=trivial, 5=highly complex)
4. **Recommendations**: Actionable suggestions for improvement

Focus on:
- Logic errors and edge cases
- Security vulnerabilities (injection, XSS, etc.)
- Performance implications
- Code quality and maintainability
- Test coverage gaps`,
            },
          ],
        };
      }

      case 'get_dashboard_stats': {
        const stats = getDashboardStats();
        return {
          content: [
            {
              type: 'text',
              text: formatDashboardStats(stats),
            },
          ],
        };
      }

      case 'get_recent_analyses': {
        const limit = args.limit || 10;
        const analyses = getRecentAnalyses(limit);
        return {
          content: [
            {
              type: 'text',
              text: formatRecentAnalyses(analyses),
            },
          ],
        };
      }

      case 'save_analysis': {
        const cwd = process.cwd();
        const repoInfo = args.repo_owner && args.repo_name
          ? { owner: args.repo_owner, name: args.repo_name }
          : getRepoInfo(cwd);

        const prNumber = args.pr_number || Math.floor(Date.now() / 1000) % 100000;

        saveAnalysis({
          pr_number: prNumber,
          repo_owner: repoInfo.owner,
          repo_name: repoInfo.name,
          author: args.author || 'unknown',
          title: args.title,
          complexity: args.complexity || 1,
          risks_count: args.risks_count || (args.risks?.length || 0),
          risks: JSON.stringify(args.risks || []),
          recommendations: JSON.stringify(args.recommendations || []),
        });

        return {
          content: [
            {
              type: 'text',
              text: `Analysis saved successfully for ${repoInfo.owner}/${repoInfo.name} #${prNumber}`,
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Format dashboard stats for display
 */
function formatDashboardStats(stats) {
  let output = '# PR Agent Dashboard Statistics\n\n';

  output += `## Overview\n`;
  output += `- **Total PRs Analyzed**: ${stats.totalPRs}\n`;
  output += `- **Success Rate**: ${stats.successRate?.toFixed(1) || 0}%\n`;
  output += `- **Average Complexity**: ${stats.avgComplexity?.toFixed(2) || 0}\n\n`;

  output += `## ROI Metrics\n`;
  output += `- **Hours Saved**: ${stats.roi?.hoursSaved?.toFixed(1) || 0}\n`;
  output += `- **Estimated Cost Savings**: $${stats.roi?.moneySaved?.toFixed(0) || 0}\n\n`;

  if (stats.complexityDistribution) {
    output += `## Complexity Distribution\n`;
    output += `- Low: ${stats.complexityDistribution[0] || 0}\n`;
    output += `- Medium: ${stats.complexityDistribution[1] || 0}\n`;
    output += `- High: ${stats.complexityDistribution[2] || 0}\n\n`;
  }

  if (stats.perCreator?.length > 0) {
    output += `## Top Contributors\n`;
    stats.perCreator.forEach(creator => {
      output += `- **${creator.author}**: ${creator.count} PRs (avg complexity: ${creator.avg_complexity?.toFixed(1) || 'N/A'})\n`;
    });
    output += '\n';
  }

  if (stats.commonRecommendations?.length > 0) {
    output += `## Common Recommendations\n`;
    stats.commonRecommendations.slice(0, 5).forEach(rec => {
      output += `- ${rec.text} (${rec.count}x)\n`;
    });
  }

  return output;
}

/**
 * Format recent analyses for display
 */
function formatRecentAnalyses(analyses) {
  if (!analyses || analyses.length === 0) {
    return 'No recent analyses found.';
  }

  let output = '# Recent PR Analyses\n\n';
  output += '| PR | Repository | Author | Complexity | Risks | Date |\n';
  output += '|---|---|---|---|---|---|\n';

  analyses.forEach(analysis => {
    const date = new Date(analysis.timestamp).toLocaleDateString();
    output += `| #${analysis.pr_number} | ${analysis.repo_owner}/${analysis.repo_name} | ${analysis.author} | ${analysis.complexity} | ${analysis.risks_count} | ${date} |\n`;
  });

  return output;
}

// Main entry point
async function main() {
  await loadDependencies();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('PR Agent MCP Server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
