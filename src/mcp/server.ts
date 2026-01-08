#!/usr/bin/env node

/**
 * PR Agent MCP Server
 *
 * LLM-agnostic MCP server that mirrors the CLI workflow exactly.
 * Uses the same configuration file (.pragent.config.json) and supports
 * all the same features (Jira peer review, arch-docs, etc.).
 *
 * The only difference from CLI: No AI provider API keys required.
 * The calling tool's LLM (Claude Code, Cursor, etc.) does the AI analysis.
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

// Import utilities from PR Agent codebase (same as CLI)
import { parseDiff } from '../tools/pr-analysis-tools.js';
import { parseAllArchDocs, archDocsExists } from '../utils/arch-docs-parser.js';
import { buildArchDocsContext } from '../utils/arch-docs-rag.js';
import { resolveDefaultBranch } from '../utils/branch-resolver.js';
import { getDashboardStats, getRecentAnalyses, saveAnalysis } from '../db/index.js';
import { loadUserConfig, type UserConfig } from '../cli/utils/config-loader.js';
import type { DiffFile } from '../types/agent.types.js';

// Dashboard server state
let httpServer: any = null;
let dashboardPort: number | null = null;

/**
 * Detect potential risks using pattern matching (same patterns as CLI)
 */
function detectRiskPatterns(diff: string, files: DiffFile[]): Array<{
  type: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  file?: string;
  line?: number;
}> {
  const risks: Array<{
    type: string;
    severity: 'critical' | 'warning' | 'info';
    description: string;
    file?: string;
    line?: number;
  }> = [];

  // Security patterns - same as CLI
  if (/password\s*[=:]\s*['"][^'"]+['"]/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'critical',
      description: 'Potential hardcoded password detected',
    });
  }
  if (/api[_-]?key\s*[=:]\s*['"][^'"]+['"]/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'critical',
      description: 'Potential hardcoded API key detected',
    });
  }
  if (/secret\s*[=:]\s*['"][^'"]+['"]/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'critical',
      description: 'Potential hardcoded secret detected',
    });
  }
  if (/eval\s*\(/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'warning',
      description: 'Use of eval() detected - potential code injection risk',
    });
  }
  if (/innerHTML\s*=/i.test(diff) || /dangerouslySetInnerHTML/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'warning',
      description: 'Direct HTML injection detected - potential XSS risk',
    });
  }
  if (/exec\s*\(|execSync\s*\(/i.test(diff) && /\$\{|\+\s*['"]/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'critical',
      description: 'Command execution with string interpolation - potential command injection',
    });
  }

  // SQL injection patterns
  if (/SELECT.*FROM.*WHERE.*\+|INSERT.*INTO.*VALUES.*\+/i.test(diff)) {
    risks.push({
      type: 'security',
      severity: 'critical',
      description: 'SQL query with string concatenation - potential SQL injection',
    });
  }

  // Code quality patterns
  const todoCount = (diff.match(/TODO|FIXME|XXX|HACK/gi) || []).length;
  if (todoCount > 0) {
    risks.push({
      type: 'quality',
      severity: 'info',
      description: `${todoCount} TODO/FIXME comments found - incomplete work markers`,
    });
  }

  const consoleLogCount = (diff.match(/console\.log\s*\(/g) || []).length;
  if (consoleLogCount > 3) {
    risks.push({
      type: 'quality',
      severity: 'warning',
      description: `${consoleLogCount} console.log statements - consider using proper logging`,
    });
  }

  // Error handling patterns
  if (/throw\s+new\s+Error/i.test(diff) && !/try\s*\{/i.test(diff)) {
    risks.push({
      type: 'quality',
      severity: 'warning',
      description: 'Throws errors without apparent try-catch handling',
    });
  }

  // Breaking change patterns
  if (/-\s*export\s+(interface|type|class|function|const)\s+\w+/i.test(diff)) {
    risks.push({
      type: 'breaking',
      severity: 'warning',
      description: 'Removed or modified export - potential breaking change',
    });
  }

  return risks;
}

/**
 * Calculate complexity score (same algorithm as CLI)
 */
function calculateComplexity(files: DiffFile[]): {
  score: number;
  factors: {
    totalChanges: number;
    fileCount: number;
    avgFileComplexity: number;
    hasConfigChanges: boolean;
    hasTestChanges: boolean;
    hasMigrations: boolean;
  };
  recommendation: string;
} {
  const totalChanges = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const fileCount = files.length;

  const fileComplexities = files.map(f => {
    let complexity = 1;
    const changes = f.additions + f.deletions;
    if (changes > 200) complexity = 5;
    else if (changes > 100) complexity = 4;
    else if (changes > 50) complexity = 3;
    else if (changes > 20) complexity = 2;
    return complexity;
  });

  const avgFileComplexity = fileComplexities.length > 0
    ? fileComplexities.reduce((a, b) => a + b, 0) / fileComplexities.length
    : 1;

  const hasConfigChanges = files.some(f =>
    /config|\.env|settings|\.ya?ml$/i.test(f.path)
  );
  const hasTestChanges = files.some(f =>
    /test|spec|__tests__/i.test(f.path)
  );
  const hasMigrations = files.some(f =>
    /migration|schema/i.test(f.path)
  );

  let score = 1;

  if (totalChanges > 500) score = Math.max(score, 5);
  else if (totalChanges > 300) score = Math.max(score, 4);
  else if (totalChanges > 150) score = Math.max(score, 3);
  else if (totalChanges > 50) score = Math.max(score, 2);

  if (fileCount > 20) score = Math.max(score, 5);
  else if (fileCount > 10) score = Math.max(score, 4);
  else if (fileCount > 5) score = Math.max(score, 3);

  if (avgFileComplexity >= 4) score = Math.max(score, 5);
  else if (avgFileComplexity >= 3) score = Math.max(score, 4);

  if (hasMigrations) score = Math.max(score, 3);
  if (hasConfigChanges && totalChanges > 50) score = Math.max(score, 3);

  score = Math.min(score, 5);

  const recommendation = score >= 4
    ? 'High complexity - consider breaking into smaller PRs'
    : score >= 3
      ? 'Moderate complexity - ensure thorough testing'
      : 'Low complexity - straightforward changes';

  return {
    score,
    factors: {
      totalChanges,
      fileCount,
      avgFileComplexity: Math.round(avgFileComplexity * 10) / 10,
      hasConfigChanges,
      hasTestChanges,
      hasMigrations,
    },
    recommendation,
  };
}

/**
 * Get git diff (same as CLI)
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
 * Extract ticket references from text (same patterns as CLI)
 */
function extractTicketReferences(
  title?: string,
  branchName?: string,
  commitMessages?: string[],
  defaultProject?: string
): Array<{ key: string; source: string; confidence: number }> {
  const refs: Array<{ key: string; source: string; confidence: number }> = [];
  const seen = new Set<string>();

  // Standard Jira pattern: PROJ-123
  const jiraPattern = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

  // Check title
  if (title) {
    let match;
    while ((match = jiraPattern.exec(title)) !== null) {
      if (!seen.has(match[1])) {
        refs.push({ key: match[1], source: 'title', confidence: 95 });
        seen.add(match[1]);
      }
    }
  }

  // Check branch name
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

  // Check commit messages
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
 * Format output like CLI (for calling LLM to display)
 */
function formatCLIOutput(analysis: any): string {
  const lines: string[] = [];

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('✨ PR Agent Analysis Complete!');
  lines.push('');

  // Summary section
  lines.push('📋 Summary');
  lines.push('');
  lines.push(`Title: ${analysis.title || 'Untitled'}`);
  lines.push(`Repository: ${analysis.repository}`);
  lines.push(`Branch: ${analysis.currentBranch} → ${analysis.baseBranch}`);
  lines.push(`Files changed: ${analysis.stats.filesChanged}`);
  lines.push(`Lines: +${analysis.stats.totalAdditions} / -${analysis.stats.totalDeletions}`);
  if (analysis.stats.languages.length > 0) {
    lines.push(`Languages: ${analysis.stats.languages.join(', ')}`);
  }
  lines.push('');

  // Complexity section
  lines.push('📊 Complexity');
  lines.push('');
  lines.push(`Score: ${analysis.complexity.score}/5 - ${analysis.complexity.recommendation}`);
  lines.push(`Total changes: ${analysis.complexity.factors.totalChanges} lines`);
  lines.push(`Files: ${analysis.complexity.factors.fileCount}`);
  if (analysis.complexity.factors.hasConfigChanges) lines.push('⚙️  Contains config changes');
  if (analysis.complexity.factors.hasTestChanges) lines.push('🧪 Contains test changes');
  if (analysis.complexity.factors.hasMigrations) lines.push('🗃️  Contains migrations');
  lines.push('');

  // Risks section
  if (analysis.risks.detected.length > 0) {
    lines.push('⚠️  Detected Risks');
    lines.push('');
    analysis.risks.detected.forEach((risk: any, i: number) => {
      const icon = risk.severity === 'critical' ? '🔴' : risk.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`  ${i + 1}. ${icon} [${risk.severity.toUpperCase()}] ${risk.description}`);
      if (risk.file) lines.push(`     File: ${risk.file}${risk.line ? `:${risk.line}` : ''}`);
    });
    lines.push('');
  }

  // Files section
  lines.push('📁 Files Changed');
  lines.push('');
  analysis.files.forEach((f: any) => {
    const statusIcon = f.status === 'A' ? '➕' : f.status === 'D' ? '➖' : '📝';
    lines.push(`  ${statusIcon} ${f.path} (+${f.additions}/-${f.deletions})`);
  });
  lines.push('');

  // Arch-docs section
  if (analysis.archDocs?.available) {
    lines.push('📚 Architecture Documentation');
    lines.push('');
    lines.push(`Documents found: ${analysis.archDocs.totalDocs}`);
    if (analysis.archDocs.relevantSections?.length > 0) {
      lines.push('Relevant sections:');
      analysis.archDocs.relevantSections.slice(0, 5).forEach((section: string) => {
        lines.push(`  • ${section}`);
      });
    }
    lines.push('');
  }

  // Peer review section (if tickets found)
  if (analysis.peerReview?.ticketReferences?.length > 0) {
    lines.push('🎫 Linked Tickets');
    lines.push('');
    analysis.peerReview.ticketReferences.forEach((ref: any) => {
      lines.push(`  • ${ref.key} (from ${ref.source}, confidence: ${ref.confidence}%)`);
    });
    lines.push('');
    if (analysis.peerReview.config?.enabled) {
      lines.push('Jira integration is enabled. The calling LLM should validate against ticket requirements.');
    }
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Instructions for calling LLM
  lines.push('');
  lines.push('📝 INSTRUCTIONS FOR AI ANALYSIS:');
  lines.push('');
  lines.push('Please analyze this PR and provide:');
  lines.push('1. A brief summary of what the changes do');
  lines.push('2. Potential risks or issues (bugs, edge cases, security)');
  lines.push('3. Recommendations for improvement');
  if (analysis.peerReview?.ticketReferences?.length > 0) {
    lines.push('4. Validation against linked ticket requirements (if Jira access available)');
  }
  lines.push('');
  lines.push('Format your response like the PR Agent CLI output shown above.');

  return lines.join('\n');
}

// Create MCP server
const server = new McpServer({
  name: 'pr-agent',
  version: '1.0.0',
});

/**
 * analyze - Main entry point (mirrors CLI analyze command)
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
        // Config not found is OK for MCP
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

      // Get diff (same as CLI)
      let diff: string;
      if (args.staged) {
        diff = getGitDiff('git diff --staged', workDir);
      } else {
        diff = getGitDiff(`git diff ${baseBranch}`, workDir);
      }

      if (!diff) {
        return {
          content: [{
            type: 'text' as const,
            text: formatCLIOutput({
              title: args.title || getPRTitle(workDir),
              repository: `${getRepoInfo(workDir).owner}/${getRepoInfo(workDir).name}`,
              currentBranch: getCurrentBranch(workDir),
              baseBranch: baseBranch || 'staged',
              stats: { filesChanged: 0, totalAdditions: 0, totalDeletions: 0, languages: [] },
              files: [],
              risks: { detected: [], criticalCount: 0, warningCount: 0 },
              complexity: { score: 1, factors: {}, recommendation: 'No changes to analyze' },
              message: 'No changes detected',
            }),
          }],
        };
      }

      // Parse diff (same as CLI)
      const files = parseDiff(diff);
      const title = args.title || getPRTitle(workDir);
      const currentBranch = getCurrentBranch(workDir);
      const repoInfo = getRepoInfo(workDir);

      // Detect risks (same patterns as CLI)
      const risks = detectRiskPatterns(diff, files);

      // Calculate complexity (same algorithm as CLI)
      const complexity = calculateComplexity(files);

      // Check for arch-docs (same as CLI)
      const useArchDocs = args.archDocs !== false;
      const hasArchDocs = archDocsExists(workDir);
      let archDocsData: any = null;

      if (useArchDocs && hasArchDocs) {
        const docs = parseAllArchDocs(workDir);
        const context = buildArchDocsContext(docs, { title, files, diff });
        const relevantSections = context?.relevantDocs?.map(d => `${d.filename}: ${d.section}`) || [];
        archDocsData = {
          available: true,
          totalDocs: docs.length,
          relevantSections,
          summary: context?.summary || '',
          documents: docs.map(d => ({
            filename: d.filename,
            title: d.title,
            sections: d.sections.map(s => s.heading),
          })),
        };
      }

      // Extract ticket references for peer review (same as CLI)
      let branchName: string | undefined;
      let commitMessages: string[] = [];
      try {
        branchName = currentBranch;
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
        branchName,
        commitMessages,
        config.peerReview?.defaultProject
      );

      // Build analysis result (same structure as CLI)
      const analysis = {
        title: title || 'Untitled',
        repository: `${repoInfo.owner}/${repoInfo.name}`,
        currentBranch,
        baseBranch: baseBranch || 'staged',
        stats: {
          filesChanged: files.length,
          totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
          totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
          languages: [...new Set(files.map(f => f.language).filter(Boolean))],
          estimatedTokens: Math.ceil(diff.length / 4),
        },
        files: files.map(f => ({
          path: f.path,
          language: f.language,
          status: f.status || 'M',
          additions: f.additions,
          deletions: f.deletions,
        })),
        risks: {
          detected: risks,
          criticalCount: risks.filter(r => r.severity === 'critical').length,
          warningCount: risks.filter(r => r.severity === 'warning').length,
        },
        complexity,
        archDocs: archDocsData || { available: false },
        peerReview: {
          enabled: peerReviewEnabled,
          ticketReferences: ticketRefs,
          config: peerReviewEnabled ? {
            enabled: true,
            provider: config.peerReview?.provider || 'jira',
            instanceUrl: config.peerReview?.instanceUrl,
            defaultProject: config.peerReview?.defaultProject,
          } : null,
        },
        config: {
          language: config.analysis?.language,
          framework: config.analysis?.framework,
          enableStaticAnalysis: config.analysis?.enableStaticAnalysis,
        },
        diff, // Include full diff for AI analysis
      };

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
          complexity: complexity.score,
          risks_count: risks.filter(r => r.severity === 'critical' || r.severity === 'warning').length,
          risks: JSON.stringify(risks.map(r => r.description)),
          recommendations: JSON.stringify([]),
        });
      } catch {
        // Ignore save errors
      }

      // Return formatted output (same format as CLI)
      return {
        content: [{
          type: 'text' as const,
          text: formatCLIOutput(analysis),
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
  console.error('PR Agent MCP Server started - mirrors CLI workflow (LLM-agnostic mode)');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
