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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import from PR Agent codebase (same as CLI)
import { PRAnalyzerAgent } from '../agents/pr-analyzer-agent.js';
import { getDashboardStats, getRecentAnalyses, saveAnalysis } from '../db/index.js';
import { loadUserConfig, type UserConfig } from '../cli/utils/config-loader.js';
import { resolveDefaultBranch } from '../utils/branch-resolver.js';
import { StubChatModel } from './stub-chat-model.js';
import { parseDiff } from '../tools/pr-analysis-tools.js';
import type { Fix, DiffFile } from '../types/agent.types.js';

// Dashboard server state
let httpServer: any = null;
let dashboardPort: number | null = null;

/**
 * Get git diff
 */
function getGitDiff(command: string, cwd?: string): string {
  try {
    const maxBuffer = 200 * 1024 * 1024;
    const diff = execSync(command, {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      maxBuffer,
    });
    return diff.trim();
  } catch (error: any) {
    throw new Error(`Failed to get diff: ${error.message}`);
  }
}

/**
 * Get current branch name
 */
function getCurrentBranch(cwd?: string): string {
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
 * Get repository info
 */
function getRepoInfo(cwd?: string): { owner: string; name: string } {
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
 * Get PR title from git
 */
function getPRTitle(cwd?: string): string | undefined {
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
 * Get git author
 */
function getGitAuthor(cwd?: string): string {
  try {
    return execSync('git config user.name', {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract ticket references from text
 */
function extractTicketReferences(
  title?: string,
  branchName?: string,
  commitMessages?: string[],
  defaultProject?: string
): Array<{ key: string; source: string; confidence: number }> {
  const refs: Array<{ key: string; source: string; confidence: number }> = [];
  const seen = new Set<string>();
  const jiraPattern = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

  if (title) {
    let match;
    while ((match = jiraPattern.exec(title)) !== null) {
      if (!seen.has(match[1])) {
        refs.push({ key: match[1], source: 'title', confidence: 95 });
        seen.add(match[1]);
      }
    }
  }

  if (branchName) {
    let match;
    jiraPattern.lastIndex = 0;
    while ((match = jiraPattern.exec(branchName)) !== null) {
      if (!seen.has(match[1])) {
        refs.push({ key: match[1], source: 'branch', confidence: 85 });
        seen.add(match[1]);
      }
    }
  }

  if (commitMessages) {
    for (const msg of commitMessages) {
      let match;
      jiraPattern.lastIndex = 0;
      while ((match = jiraPattern.exec(msg)) !== null) {
        if (!seen.has(match[1])) {
          refs.push({ key: match[1], source: 'commit', confidence: 75 });
          seen.add(match[1]);
        }
      }
    }
  }

  return refs;
}

/**
 * Format CLI-style output
 */
function formatCLIOutput(result: any, ticketRefs: any[], peerReviewEnabled: boolean): string {
  const lines: string[] = [];

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('✨ PR Agent Analysis Complete!');
  lines.push('');

  // Summary
  lines.push('📋 Summary');
  lines.push('');
  lines.push(`Title: ${result.title || 'Untitled'}`);
  lines.push(`Repository: ${result.repository}`);
  lines.push(`Branch: ${result.currentBranch} → ${result.baseBranch}`);
  lines.push(`Files changed: ${result.files?.length || 0}`);

  const additions = result.files?.reduce((sum: number, f: any) => sum + (f.additions || 0), 0) || 0;
  const deletions = result.files?.reduce((sum: number, f: any) => sum + (f.deletions || 0), 0) || 0;
  lines.push(`Lines: +${additions} / -${deletions}`);

  const languages = [...new Set(result.files?.map((f: any) => f.language).filter(Boolean) || [])];
  if (languages.length > 0) {
    lines.push(`Languages: ${languages.join(', ')}`);
  }
  lines.push('');

  // Complexity
  lines.push('📊 Complexity');
  lines.push('');
  const complexity = result.complexity || 1;
  const complexityDesc = complexity >= 4
    ? 'High complexity - consider breaking into smaller PRs'
    : complexity >= 3
      ? 'Moderate complexity - ensure thorough testing'
      : 'Low complexity - straightforward changes';
  lines.push(`Score: ${complexity}/5 - ${complexityDesc}`);
  lines.push(`Total changes: ${additions + deletions} lines`);
  lines.push(`Files: ${result.files?.length || 0}`);
  lines.push('');

  // Risks
  if (result.fixes && result.fixes.length > 0) {
    lines.push('⚠️  Detected Risks');
    lines.push('');
    result.fixes.slice(0, 10).forEach((fix: Fix, i: number) => {
      const icon = fix.severity === 'critical' ? '🔴' : fix.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`  ${i + 1}. ${icon} [${(fix.severity || 'info').toUpperCase()}] ${fix.comment}`);
      if (fix.file) lines.push(`     File: ${fix.file}${fix.line ? `:${fix.line}` : ''}`);
    });
    lines.push('');
  }

  // Files
  if (result.files && result.files.length > 0) {
    lines.push('📁 Files Changed');
    lines.push('');
    result.files.forEach((f: any) => {
      const statusIcon = f.status === 'A' ? '➕' : f.status === 'D' ? '➖' : '📝';
      lines.push(`  ${statusIcon} ${f.path} (+${f.additions || 0}/-${f.deletions || 0})`);
    });
    lines.push('');
  }

  // Recommendations
  if (result.recommendations && result.recommendations.length > 0) {
    lines.push('💡 Recommendations');
    lines.push('');
    result.recommendations.forEach((rec: string, i: number) => {
      lines.push(`  ${i + 1}. ${rec}`);
    });
    lines.push('');
  }

  // Tickets
  if (ticketRefs.length > 0) {
    lines.push('🎫 Linked Tickets');
    lines.push('');
    ticketRefs.forEach((ref: any) => {
      lines.push(`  • ${ref.key} (from ${ref.source}, confidence: ${ref.confidence}%)`);
    });
    lines.push('');
    if (peerReviewEnabled) {
      lines.push('Jira integration is enabled. The calling LLM should validate against ticket requirements.');
    }
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return lines.join('\n');
}

// Create MCP server
const server = new McpServer({
  name: 'pr-agent',
  version: '1.0.0',
});

/**
 * analyze - Main entry point (uses same PRAnalyzerAgent as CLI)
 */
server.tool(
  'analyze',
  `Analyze PR/branch changes - mirrors the CLI 'pr-agent analyze' command exactly.
Uses the same configuration file (.pragent.config.json) and supports all CLI features.
Returns formatted analysis for the calling LLM to display and enhance with AI insights.`,
  {
    branch: z.string().optional().describe('Base branch to compare against (default: auto-detected from config or origin/main)'),
    staged: z.boolean().optional().describe('Analyze staged changes instead of branch diff'),
    title: z.string().optional().describe('PR title (auto-detected from git if not provided)'),
    cwd: z.string().optional().describe('Working directory (defaults to current directory)'),
    verbose: z.boolean().optional().describe('Include additional debug information'),
    peerReview: z.boolean().optional().describe('Enable peer review (Jira ticket validation) - uses config if not specified'),
    archDocs: z.boolean().optional().describe('Include architecture documentation context - uses config if not specified'),
  },
  async (args) => {
    const workDir = args.cwd || process.cwd();
    const verbose = args.verbose || false;

    try {
      // Load configuration (same as CLI)
      let config: UserConfig = {};
      try {
        config = await loadUserConfig(verbose, false);
      } catch (e) {
        // Config not found is OK
      }

      // Resolve base branch (same logic as CLI)
      let baseBranch = args.branch;
      if (!baseBranch && !args.staged) {
        try {
          const branchResult = await resolveDefaultBranch({
            configBranch: config.git?.defaultBranch,
            githubToken: process.env.GITHUB_TOKEN,
            fallbackToGit: true,
          });
          baseBranch = branchResult.branch;
        } catch {
          baseBranch = 'origin/main';
        }
      }

      // Get diff
      let diff: string;
      if (args.staged) {
        diff = getGitDiff('git diff --staged', workDir);
      } else {
        diff = getGitDiff(`git diff ${baseBranch}`, workDir);
      }

      const title = args.title || getPRTitle(workDir);
      const currentBranch = getCurrentBranch(workDir);
      const repoInfo = getRepoInfo(workDir);

      if (!diff) {
        return {
          content: [{
            type: 'text' as const,
            text: `No changes detected between ${currentBranch} and ${baseBranch || 'staged'}`,
          }],
        };
      }

      // Extract ticket references
      let commitMessages: string[] = [];
      try {
        const commits = execSync('git log --oneline -10', {
          encoding: 'utf-8',
          cwd: workDir,
        });
        commitMessages = commits.trim().split('\n');
      } catch {
        // Ignore
      }

      const peerReviewEnabled = args.peerReview ?? config.peerReview?.enabled ?? false;
      const ticketRefs = extractTicketReferences(
        title,
        currentBranch,
        commitMessages,
        config.peerReview?.defaultProject
      );

      // Create PRAnalyzerAgent with StubChatModel
      // The stub model triggers fallback paths, allowing:
      // 1. Static analysis (semgrep, pattern matching) to run
      // 2. Default recommendations to be generated
      // The calling LLM (Claude Code) provides AI insights after receiving response
      // Note: When Claude Code adds MCP sampling support (Issue #1785),
      // we can switch to MCPChatModel for true pass-through LLM access
      const stubModel = new StubChatModel();
      const agent = new PRAnalyzerAgent({ chatModel: stubModel });

      // Run analysis using PRAnalyzerAgent (same workflow as CLI)
      const useArchDocs = args.archDocs !== false;
      console.error('[MCP Server] Running PRAnalyzerAgent.analyze()...');
      const result = await agent.analyze(
        diff,
        title,
        { summary: true, risks: true, complexity: true },
        {
          useArchDocs,
          repoPath: workDir,
          language: config.analysis?.language,
          framework: config.analysis?.framework,
          enableStaticAnalysis: config.analysis?.enableStaticAnalysis !== false,
        }
      );

      console.error('[MCP Server] Analysis complete. Result:');
      console.error('  - summary:', result.summary?.substring(0, 100));
      console.error('  - recommendations:', JSON.stringify(result.recommendations));
      console.error('  - fixes count:', result.fixes?.length);
      console.error('  - fileAnalyses size:', result.fileAnalyses?.size);

      // Calculate overall complexity from file analyses
      let overallComplexity = 1;
      if (result.fileAnalyses && result.fileAnalyses.size > 0) {
        const complexities = Array.from(result.fileAnalyses.values()).map((f: any) => f.complexity || 1);
        overallComplexity = Math.round(complexities.reduce((a: number, b: number) => a + b, 0) / complexities.length);
      }

      // Save to database (same as CLI)
      try {
        const author = getGitAuthor(workDir);
        const prNumber = Math.floor(Date.now() / 1000) % 100000;

        saveAnalysis({
          pr_number: prNumber,
          repo_owner: repoInfo.owner,
          repo_name: repoInfo.name,
          author,
          title: title || 'Untitled Analysis',
          complexity: overallComplexity,
          risks_count: result.fixes?.filter((f: Fix) => f.severity === 'critical' || f.severity === 'warning').length || 0,
          risks: JSON.stringify(result.fixes?.filter((f: Fix) => f.severity === 'critical' || f.severity === 'warning').map((f: Fix) => f.comment) || []),
          recommendations: JSON.stringify(result.recommendations || []),
          // Peer review not run in MCP server (handled by calling LLM)
          peer_review_enabled: 0,
        });
      } catch {
        // Ignore save errors
      }

      // Parse diff to get files for output
      const files: DiffFile[] = parseDiff(diff);

      // Build output data
      const outputData = {
        title: title || 'Untitled',
        repository: `${repoInfo.owner}/${repoInfo.name}`,
        currentBranch,
        baseBranch: baseBranch || 'staged',
        files,
        fixes: result.fixes || [],
        recommendations: result.recommendations || [],
        complexity: overallComplexity,
      };

      // Return formatted output
      return {
        content: [{
          type: 'text' as const,
          text: formatCLIOutput(outputData, ticketRefs, peerReviewEnabled),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Analysis failed: ${error.message}\n\nMake sure you are in a git repository with changes to analyze.`,
        }],
      };
    }
  }
);

/**
 * dashboard - Start the web dashboard (same as CLI 'pr-agent dashboard')
 */
server.tool(
  'dashboard',
  `Start the PR Agent web dashboard on localhost - same as 'pr-agent dashboard' CLI command.`,
  {
    port: z.number().optional().describe('Port to run the dashboard on (default: 3000)'),
  },
  async ({ port }) => {
    const targetPort = port || 3000;

    if (httpServer && dashboardPort === targetPort) {
      return {
        content: [{
          type: 'text' as const,
          text: `✅ Dashboard is already running at http://localhost:${dashboardPort}\n\nOpen this URL in your browser to view PR analysis history and statistics.`,
        }],
      };
    }

    if (httpServer) {
      httpServer.close();
      httpServer = null;
      dashboardPort = null;
    }

    const app = express();

    // Resolve public directory
    const publicDir = path.resolve(__dirname, '../public');
    const srcPublicDir = path.resolve(__dirname, '../../src/public');
    const staticDir = fs.existsSync(publicDir) ? publicDir : srcPublicDir;

    app.use(express.static(staticDir));

    // API Routes (same as CLI dashboard)
    app.get('/dashboard/api/stats', (req, res) => {
      try {
        const stats = getDashboardStats();
        const recent = getRecentAnalyses();
        res.json({ stats, recent });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
      }
    });

    app.get('*', (req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });

    return new Promise((resolve) => {
      httpServer = app.listen(targetPort, () => {
        dashboardPort = targetPort;
        resolve({
          content: [{
            type: 'text' as const,
            text: `✅ Dashboard started successfully!\n\n🌐 URL: http://localhost:${targetPort}\n\nOpen this URL in your browser to view:\n• PR analysis history\n• Code quality trends\n• ROI metrics\n• Recent activity`,
          }],
        });
      });

      httpServer.on('error', (err: any) => {
        resolve({
          content: [{
            type: 'text' as const,
            text: err.code === 'EADDRINUSE'
              ? `❌ Port ${targetPort} is already in use.\n\nTry: dashboard with port: ${targetPort + 1}`
              : `❌ Failed to start dashboard: ${err.message}`,
          }],
        });
      });
    });
  }
);

// Main entry point
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PR Agent MCP Server started - uses same PRAnalyzerAgent as CLI');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
