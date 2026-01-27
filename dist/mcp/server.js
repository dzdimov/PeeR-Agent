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
import { loadUserConfig } from '../cli/utils/config-loader.js';
import { resolveDefaultBranch } from '../utils/branch-resolver.js';
import { ExecutionMode as ExecutionModeEnum } from '../types/agent.types.js';
import { createPeerReviewIntegration, PeerReviewMode } from '../issue-tracker/index.js';
import { OutputFormatter } from '../utils/output-formatter.js';
// Dashboard server state
let httpServer = null;
let dashboardPort = null;
/**
 * Get git diff
 */
function getGitDiff(command, cwd) {
    try {
        const maxBuffer = 200 * 1024 * 1024;
        const diff = execSync(command, {
            encoding: 'utf-8',
            cwd: cwd || process.cwd(),
            maxBuffer,
            shell: true,
        });
        return diff.trim();
    }
    catch (error) {
        throw new Error(`Failed to get diff: ${error.message}`);
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
            shell: true,
        }).trim();
    }
    catch {
        return 'unknown';
    }
}
/**
 * Get repository info
 */
function getRepoInfo(cwd) {
    try {
        const remoteUrl = execSync('git remote get-url origin', {
            encoding: 'utf-8',
            cwd: cwd || process.cwd(),
            shell: true,
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
    }
    catch {
        return { owner: 'local', name: 'unknown' };
    }
}
/**
 * Get PR title from git
 */
function getPRTitle(cwd) {
    try {
        return execSync('git log -1 --pretty=%B', {
            encoding: 'utf-8',
            cwd: cwd || process.cwd(),
        }).trim().split('\n')[0];
    }
    catch {
        return undefined;
    }
}
/**
 * Get git author
 */
function getGitAuthor(cwd) {
    try {
        return execSync('git config user.name', {
            encoding: 'utf-8',
            cwd: cwd || process.cwd(),
        }).trim() || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/**
 * Extract ticket references from text
 */
function extractTicketReferences(title, branchName, commitMessages, defaultProject) {
    const refs = [];
    const seen = new Set();
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
 * Parse diff to extract file information (same as CLI)
 */
function parseDiffFiles(diff) {
    const files = [];
    const filePattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let match;
    while ((match = filePattern.exec(diff)) !== null) {
        const filePath = match[2] !== '/dev/null' ? match[2] : match[1];
        const isNew = match[1] === '/dev/null' || match[1].startsWith('dev/null');
        const isDeleted = match[2] === '/dev/null';
        // Count additions and deletions (simplified)
        const fileStart = match.index;
        const nextFileMatch = filePattern.exec(diff);
        const fileEnd = nextFileMatch ? nextFileMatch.index : diff.length;
        filePattern.lastIndex = match.index + 1; // Reset to continue from after current match
        const fileContent = diff.substring(fileStart, fileEnd);
        const additions = (fileContent.match(/^\+[^+]/gm) || []).length;
        const deletions = (fileContent.match(/^-[^-]/gm) || []).length;
        files.push({
            path: filePath,
            additions,
            deletions,
            status: isNew ? 'added' : isDeleted ? 'deleted' : 'modified',
        });
    }
    return files;
}
/**
 * Run Peer Review analysis (EXACT same logic as CLI, using StubChatModel for pass-through)
 */
async function runPeerReview(config, diff, title, prAnalysisResult, verbose, workDir) {
    try {
        // Use PROMPT_ONLY mode - no LLM needed, returns prompts for calling LLM to execute
        // This is the LLM-agnostic approach that works without API keys
        const peerReviewConfig = config.peerReview || {};
        const integration = createPeerReviewIntegration(peerReviewConfig, PeerReviewMode.PROMPT_ONLY);
        if (!integration.isEnabled()) {
            console.error('[MCP Server] Peer Review enabled but not configured');
            if (verbose) {
                console.error('[MCP Server] Set peerReview.useMcp=true in config');
            }
            return null;
        }
        // Get branch name for ticket extraction
        let branchName;
        try {
            branchName = execSync('git rev-parse --abbrev-ref HEAD', {
                encoding: 'utf-8',
                cwd: workDir
            }).trim();
        }
        catch {
            // Ignore - branch name is optional
        }
        // Get commit messages for ticket extraction
        let commitMessages = [];
        try {
            const commits = execSync('git log --oneline -10', {
                encoding: 'utf-8',
                cwd: workDir
            });
            commitMessages = commits.trim().split('\n');
        }
        catch {
            // Ignore
        }
        // Parse diff to get file info
        const files = parseDiffFiles(diff);
        console.error('[MCP Server] Running peer review analysis...');
        // Run peer review analysis - EXACT same call as CLI (analyze.command.ts line 992-1002)
        const result = await integration.analyze({
            prTitle: title || 'Untitled PR',
            prDescription: undefined,
            branchName,
            commitMessages,
            diff,
            files,
            prSummary: prAnalysisResult.summary,
            prRisks: prAnalysisResult.overallRisks,
            prComplexity: prAnalysisResult.overallComplexity,
        });
        console.error('[MCP Server] Peer review analysis complete');
        return result;
    }
    catch (error) {
        console.error('[MCP Server] Peer review failed:', error.message);
        if (verbose) {
            console.error('[MCP Server] Error details:', error.stack);
        }
        return null;
    }
}
/**
 * Format peer review prompts for PROMPT_ONLY mode
 * Returns formatted prompts that the calling LLM should execute
 */
function formatPeerReviewPrompts(peerReviewResult) {
    if (!peerReviewResult.promptOnlyResult) {
        return '';
    }
    const { prompts, context } = peerReviewResult.promptOnlyResult;
    const lines = [];
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('🎯 Peer Review Analysis (LLM-Agnostic Mode)');
    lines.push('');
    if (peerReviewResult.primaryTicket) {
        const ticket = peerReviewResult.primaryTicket;
        lines.push(`📋 Ticket: ${ticket.key} - ${ticket.title}`);
        lines.push(`🔗 ${ticket.url || 'N/A'}`);
        lines.push('');
    }
    lines.push('The following analysis prompts should be executed sequentially:');
    lines.push('');
    prompts.forEach((prompt, i) => {
        const stepTitle = prompt.step === 'ticketQuality'
            ? '1️⃣ Ticket Quality Assessment'
            : prompt.step === 'acValidation'
                ? '2️⃣ Acceptance Criteria Validation'
                : '3️⃣ Peer Review Analysis';
        lines.push(`${stepTitle}`);
        lines.push('');
        lines.push('```');
        lines.push(prompt.prompt);
        lines.push('```');
        lines.push('');
        lines.push(`Expected output format: ${prompt.step}`);
        lines.push('');
    });
    lines.push('Note: These prompts are generated by the PR Agent peer review system.');
    lines.push('Execute them sequentially and provide structured analysis based on the prompts.');
    lines.push('');
    return lines.join('\n');
}
/**
 * Format CLI-style output
 */
function formatCLIOutput(result, ticketRefs, peerReviewEnabled) {
    const lines = [];
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
    const additions = result.files?.reduce((sum, f) => sum + (f.additions || 0), 0) || 0;
    const deletions = result.files?.reduce((sum, f) => sum + (f.deletions || 0), 0) || 0;
    lines.push(`Lines: +${additions} / -${deletions}`);
    const languages = [...new Set(result.files?.map((f) => f.language).filter(Boolean) || [])];
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
        result.fixes.slice(0, 10).forEach((fix, i) => {
            const icon = fix.severity === 'critical' ? '🔴' : fix.severity === 'warning' ? '🟡' : '🔵';
            lines.push(`  ${i + 1}. ${icon} [${(fix.severity || 'info').toUpperCase()}] ${fix.comment}`);
            if (fix.file)
                lines.push(`     File: ${fix.file}${fix.line ? `:${fix.line}` : ''}`);
        });
        lines.push('');
    }
    // Files
    if (result.files && result.files.length > 0) {
        lines.push('📁 Files Changed');
        lines.push('');
        result.files.forEach((f) => {
            const statusIcon = f.status === 'A' ? '➕' : f.status === 'D' ? '➖' : '📝';
            lines.push(`  ${statusIcon} ${f.path} (+${f.additions || 0}/-${f.deletions || 0})`);
        });
        lines.push('');
    }
    // Recommendations
    if (result.recommendations && result.recommendations.length > 0) {
        lines.push('💡 Recommendations');
        lines.push('');
        result.recommendations.forEach((rec, i) => {
            lines.push(`  ${i + 1}. ${rec}`);
        });
        lines.push('');
    }
    // Tickets
    if (ticketRefs.length > 0) {
        lines.push('🎫 Linked Tickets');
        lines.push('');
        ticketRefs.forEach((ref) => {
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
/**
 * Start dashboard server in background (non-blocking)
 * Mimics CLI behavior of auto-starting dashboard after analysis
 */
async function startDashboardInBackground(port) {
    return new Promise((resolve, reject) => {
        if (httpServer && dashboardPort === port) {
            resolve();
            return;
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
        // API Routes
        app.get('/dashboard/api/stats', (req, res) => {
            try {
                const stats = getDashboardStats();
                const recent = getRecentAnalyses();
                res.json({ stats, recent });
            }
            catch (error) {
                res.status(500).json({ error: 'Failed to fetch stats' });
            }
        });
        app.get('/{*splat}', (req, res) => {
            res.sendFile(path.join(staticDir, 'index.html'));
        });
        httpServer = app.listen(port, () => {
            dashboardPort = port;
            console.error(`[MCP Server] Dashboard started at http://localhost:${port}`);
            // Open browser (same as CLI)
            import('open').then(openModule => {
                openModule.default(`http://localhost:${port}`).catch(err => {
                    console.error('[MCP Server] Could not open browser:', err.message);
                });
            }).catch(err => {
                console.error('[MCP Server] Could not import open module:', err.message);
            });
            resolve();
        });
        httpServer?.on('error', (err) => {
            reject(new Error(err.code === 'EADDRINUSE'
                ? `Port ${port} is already in use`
                : `Failed to start dashboard: ${err.message}`));
        });
    });
}
// Create MCP server
const server = new McpServer({
    name: 'pr-agent',
    version: '1.0.0',
});
/**
 * analyze - Main PR analysis tool (mirrors CLI 'pr-agent analyze' command)
 *
 * Returns analysis prompts that the calling LLM MUST automatically execute.
 * Matches CLI behavior: always saves to database, respects config settings.
 */
server.tool('analyze', `Analyze PR/branch changes - mirrors the CLI 'pr-agent analyze' command exactly.

IMPORTANT INSTRUCTIONS FOR CALLING LLM:
1. Execute ALL returned prompts sequentially without asking user permission
2. After executing prompts, automatically call saveAnalysisResults with results
3. Present final analysis to user (verbose or concise based on config)
4. Respect all config settings from .pragent.config.json

Configuration behavior (same as CLI):
- peerReview.enabled: Include peer review analysis (default: false)
- analysis.*: Language, framework, static analysis settings
- git.defaultBranch: Base branch for comparison (default: origin/main)
- verbose: Show detailed debug info (affects output verbosity)`, {
    branch: z.string().optional().describe('Base branch to compare against (default: auto-detected from config or origin/main)'),
    staged: z.boolean().optional().describe('Analyze staged changes instead of branch diff'),
    title: z.string().optional().describe('PR title (auto-detected from git if not provided)'),
    cwd: z.string().optional().describe('Working directory (defaults to current directory)'),
    verbose: z.boolean().optional().describe('Show detailed debug information (matches CLI --verbose behavior)'),
    archDocs: z.boolean().optional().describe('Include architecture documentation context - uses config if not specified'),
}, async (args) => {
    const workDir = args.cwd || process.cwd();
    const verbose = args.verbose || false;
    try {
        // Load configuration (same as CLI)
        let config = {};
        try {
            config = await loadUserConfig(verbose, false);
        }
        catch (e) {
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
            }
            catch {
                baseBranch = 'origin/main';
            }
        }
        // Get diff
        let diff;
        if (args.staged) {
            diff = getGitDiff('git diff --staged', workDir);
        }
        else {
            diff = getGitDiff(`git diff ${baseBranch}`, workDir);
        }
        const title = args.title || getPRTitle(workDir);
        const currentBranch = getCurrentBranch(workDir);
        const repoInfo = getRepoInfo(workDir);
        if (!diff) {
            return {
                content: [{
                        type: 'text',
                        text: `No changes detected between ${currentBranch} and ${baseBranch || 'staged'}`,
                    }],
            };
        }
        // Extract ticket references
        let commitMessages = [];
        try {
            const commits = execSync('git log --oneline -10', {
                encoding: 'utf-8',
                cwd: workDir,
            });
            commitMessages = commits.trim().split('\n');
        }
        catch {
            // Ignore
        }
        // Enable peer review from config (always respect config setting)
        const peerReviewEnabled = config.peerReview?.enabled ?? false;
        if (verbose) {
            console.error(`[MCP Server] Config loaded:  peerReview.enabled=${peerReviewEnabled}, archDocs=${args.archDocs !== false}`);
        }
        const ticketRefs = extractTicketReferences(title, currentBranch, commitMessages, config.peerReview?.defaultProject);
        // Create PRAnalyzerAgent in PROMPT_ONLY mode
        const agent = new PRAnalyzerAgent({ mode: ExecutionModeEnum.PROMPT_ONLY });
        // Run analysis to get prompts (no LLM execution)
        const useArchDocs = args.archDocs !== false;
        if (verbose) {
            console.error('[MCP Server] Building analysis prompts in PROMPT_ONLY mode...');
        }
        const analysisResult = await agent.analyze(diff, title, { summary: true, risks: true, complexity: true }, {
            useArchDocs,
            repoPath: workDir,
            language: config.analysis?.language,
            framework: config.analysis?.framework,
            enableStaticAnalysis: config.analysis?.enableStaticAnalysis !== false,
        });
        if (verbose) {
            console.error('[MCP Server] Analysis prompts built');
            console.error(`  - mode: ${analysisResult.mode}`);
            console.error(`  - prompt count: ${analysisResult.mode === 'prompt_only' ? analysisResult.prompts.length : 'N/A'}`);
            console.error(`  - peer review: ${peerReviewEnabled ? 'enabled' : 'disabled'}`);
        }
        // Type guard
        if (analysisResult.mode !== 'prompt_only') {
            throw new Error('Expected prompt-only result in MCP mode');
        }
        // Get peer review prompts if enabled in config
        let peerReviewPrompts = [];
        let peerReviewError;
        if (peerReviewEnabled) {
            try {
                const peerReviewResult = await runPeerReview(config, diff, title, analysisResult, verbose, workDir);
                if (peerReviewResult && peerReviewResult.mode === 'prompt_only' && peerReviewResult.promptOnlyResult) {
                    peerReviewPrompts = peerReviewResult.promptOnlyResult.prompts;
                    console.error(`  - Peer review prompts: ${peerReviewPrompts.length}`);
                }
                else if (peerReviewResult && peerReviewResult.error) {
                    peerReviewError = peerReviewResult.error;
                    console.error(`[MCP Server] Peer review failed: ${peerReviewError}`);
                }
            }
            catch (error) {
                peerReviewError = error.message;
                console.error('[MCP Server] Peer review prompt building failed:', error.message);
                if (verbose) {
                    console.error(error.stack);
                }
            }
        }
        // Combine all prompts
        const allPrompts = [...analysisResult.prompts, ...peerReviewPrompts];
        // Format workflow response (matches CLI behavior)
        let outputText = '';
        if (verbose) {
            outputText += `# 🤖 PR Agent Analysis\n\n`;
            outputText += `**Repository:** ${repoInfo.owner}/${repoInfo.name}\n`;
            outputText += `**Branch:** ${currentBranch} → ${baseBranch}\n`;
            outputText += `**PR Title:** ${title || 'Untitled'}\n`;
            outputText += `**Peer Review:** ${peerReviewEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
            outputText += `**Prompts to execute:** ${allPrompts.length}\n\n`;
            outputText += `---\n\n`;
        }
        outputText += `## 📊 Static Analysis Results\n\n`;
        // Include static analysis results using shared formatter
        if (analysisResult.staticAnalysis) {
            const formatter = new OutputFormatter({ mode: 'markdown', verbose });
            const staticAnalysisOutput = formatter.formatStaticAnalysis(analysisResult.staticAnalysis);
            if (staticAnalysisOutput) {
                outputText += staticAnalysisOutput + '\n\n';
            }
        }
        // Show peer review error if it occurred
        if (peerReviewEnabled && peerReviewError) {
            outputText += `\n---\n\n`;
            outputText += `## ⚠️ Peer Review Error\n\n`;
            outputText += `Peer review was enabled but failed: ${peerReviewError}\n\n`;
            outputText += `**Possible causes:**\n`;
            outputText += `- Atlassian MCP server not running or misconfigured\n`;
            outputText += `- No Jira ticket found in branch name or commits\n`;
            outputText += `- API credentials missing (set instanceUrl, email, apiToken in config)\n\n`;
            outputText += `Analysis will continue with base prompts only.\n\n`;
        }
        outputText += `---\n\n`;
        outputText += `## ⚡ LLM Analysis Workflow\n\n`;
        outputText += `**IMPORTANT:** You (the calling LLM) MUST execute ALL ${allPrompts.length} prompts below sequentially.\n`;
        outputText += `Do NOT write manual analysis. Execute the prompts and use the results.\n\n`;
        outputText += `Execute the following ${allPrompts.length} prompts sequentially:\n\n`;
        // List all prompts with clear step numbers
        allPrompts.forEach((prompt, i) => {
            const stepEmoji = {
                'fileAnalysis': '📄',
                'riskDetection': '⚠️',
                'summaryGeneration': '📋',
                'selfRefinement': '✨',
                'ticketQuality': '🎯',
                'acValidation': '✅',
                'peerReview': '👥',
            }[prompt.step] || '🔹';
            outputText += `### ${stepEmoji} Step ${i + 1}: ${prompt.step}\n\n`;
            if (verbose) {
                outputText += `**Instructions:** ${prompt.instructions}\n\n`;
            }
            outputText += '**Prompt:**\n```\n';
            const promptLimit = verbose ? 20000 : 10000;
            outputText += prompt.prompt.substring(0, promptLimit);
            if (prompt.prompt.length > promptLimit) {
                outputText += '\n... (truncated for display)\n';
            }
            outputText += '\n```\n\n';
            outputText += '---\n\n';
        });
        outputText += `## 💾 Next Steps\n\n`;
        outputText += `**CRITICAL - YOU MUST DO THIS:**\n`;
        outputText += `1. **Execute ALL ${allPrompts.length} prompts** above sequentially (do NOT skip, do NOT write manual analysis)\n`;
        outputText += `2. **Parse the JSON responses** from each prompt execution\n`;
        outputText += `3. **Call \`saveAnalysisResults\`** tool with the parsed results\n`;
        outputText += `4. **Present the complete analysis** to the user in a formatted summary\n\n`;
        outputText += `**Expected token usage:** ~10,000+ tokens (if significantly lower, prompts were not executed)\n\n`;
        if (verbose) {
            outputText += `**Save parameters:**\n`;
            outputText += `- title: "${title || 'Untitled'}"\n`;
            outputText += `- repoOwner: "${repoInfo.owner}"\n`;
            outputText += `- repoName: "${repoInfo.name}"\n`;
            outputText += `- complexity: (from summary step)\n`;
            outputText += `- risksCount: (from risk detection step)\n`;
            outputText += `- risks: (from risk detection step)\n`;
            outputText += `- recommendations: (from summary step)\n`;
            if (peerReviewEnabled) {
                outputText += `- peerReviewEnabled: true\n`;
                outputText += `- ticketKey, acCompliancePercentage, etc.: (from peer review steps)\n`;
            }
            outputText += `\n📊 Dashboard: http://localhost:3000\n`;
        }
        return {
            content: [{
                    type: 'text',
                    text: outputText,
                }],
        };
    }
    catch (error) {
        return {
            content: [{
                    type: 'text',
                    text: `❌ Analysis failed: ${error.message}\n\nMake sure you are in a git repository with changes to analyze.`,
                }],
        };
    }
});
/**
 * saveAnalysisResults - Save analysis results to database after LLM execution
 * Called by the LLM after executing the prompts returned by analyze tool
 */
server.tool('saveAnalysisResults', `Save PR analysis results to the database. Call this after executing the analysis prompts to persist the results for the dashboard.`, {
    prNumber: z.number().optional().describe('PR number'),
    title: z.string().describe('PR title'),
    repoOwner: z.string().optional().describe('Repository owner'),
    repoName: z.string().optional().describe('Repository name'),
    author: z.string().optional().describe('Author name'),
    complexity: z.number().min(1).max(5).describe('Overall complexity score (1-5)'),
    risksCount: z.number().describe('Number of critical/warning risks'),
    risks: z.array(z.string()).describe('List of risk descriptions'),
    recommendations: z.array(z.string()).describe('List of recommendations'),
    // Project classification
    projectClassification: z.string().optional().describe('Project classification (JSON string)'),
    // Peer review fields
    peerReviewEnabled: z.boolean().optional(),
    ticketKey: z.string().optional().describe('Jira ticket key (e.g., TODO-2)'),
    ticketQualityScore: z.number().optional().describe('Ticket quality score (0-100)'),
    ticketQualityTier: z.string().optional().describe('Ticket quality tier'),
    acCompliancePercentage: z.number().optional().describe('AC compliance percentage'),
    acRequirementsMet: z.number().optional(),
    acRequirementsTotal: z.number().optional(),
    peerReviewVerdict: z.string().optional().describe('approve/request_changes/needs_discussion'),
    peerReviewBlockers: z.array(z.string()).optional(),
    peerReviewWarnings: z.array(z.string()).optional(),
    implementationCompleteness: z.number().optional(),
    qualityScore: z.number().optional(),
}, async (args) => {
    try {
        saveAnalysis({
            pr_number: args.prNumber || Math.floor(Date.now() / 1000) % 100000,
            repo_owner: args.repoOwner || 'local',
            repo_name: args.repoName || 'unknown',
            author: args.author || 'unknown',
            title: args.title,
            complexity: args.complexity,
            risks_count: args.risksCount,
            risks: JSON.stringify(args.risks),
            recommendations: JSON.stringify(args.recommendations),
            // Project classification
            project_classification: args.projectClassification,
            // Peer review fields
            peer_review_enabled: args.peerReviewEnabled ? 1 : 0,
            ticket_key: args.ticketKey,
            ticket_quality_score: args.ticketQualityScore,
            ticket_quality_tier: args.ticketQualityTier,
            ac_compliance_percentage: args.acCompliancePercentage,
            ac_requirements_met: args.acRequirementsMet,
            ac_requirements_total: args.acRequirementsTotal,
            peer_review_verdict: args.peerReviewVerdict,
            peer_review_blockers: args.peerReviewBlockers ? JSON.stringify(args.peerReviewBlockers) : undefined,
            peer_review_warnings: args.peerReviewWarnings ? JSON.stringify(args.peerReviewWarnings) : undefined,
            implementation_completeness: args.implementationCompleteness,
            quality_score: args.qualityScore,
        });
        return {
            content: [{
                    type: 'text',
                    text: `✅ Analysis results saved to database!\n\n📊 View results at: http://localhost:${dashboardPort || 3000}`,
                }],
        };
    }
    catch (error) {
        return {
            content: [{
                    type: 'text',
                    text: `❌ Failed to save analysis results: ${error.message}`,
                }],
        };
    }
});
/**
 * dashboard - Start the web dashboard (same as CLI 'pr-agent dashboard')
 */
server.tool('dashboard', `Start the PR Agent web dashboard on localhost - same as 'pr-agent dashboard' CLI command.`, {
    port: z.number().optional().describe('Port to run the dashboard on (default: 3000)'),
}, async ({ port }) => {
    const targetPort = port || 3000;
    if (httpServer && dashboardPort === targetPort) {
        return {
            content: [{
                    type: 'text',
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch stats' });
        }
    });
    app.get('/{*splat}', (req, res) => {
        res.sendFile(path.join(staticDir, 'index.html'));
    });
    return new Promise((resolve) => {
        httpServer = app.listen(targetPort, () => {
            dashboardPort = targetPort;
            resolve({
                content: [{
                        type: 'text',
                        text: `✅ Dashboard started successfully!\n\n🌐 URL: http://localhost:${targetPort}\n\nOpen this URL in your browser to view:\n• PR analysis history\n• Code quality trends\n• ROI metrics\n• Recent activity`,
                    }],
            });
        });
        httpServer.on('error', (err) => {
            resolve({
                content: [{
                        type: 'text',
                        text: err.code === 'EADDRINUSE'
                            ? `❌ Port ${targetPort} is already in use.\n\nTry: dashboard with port: ${targetPort + 1}`
                            : `❌ Failed to start dashboard: ${err.message}`,
                    }],
            });
        });
    });
});
// Main entry point
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('PR Agent MCP Server started - LLM-agnostic mode with PROMPT_ONLY');
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map