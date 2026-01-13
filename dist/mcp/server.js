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
import { getDashboardStats, getRecentAnalyses } from '../db/index.js';
import { loadUserConfig } from '../cli/utils/config-loader.js';
import { resolveDefaultBranch } from '../utils/branch-resolver.js';
import { ExecutionMode as ExecutionModeEnum } from '../types/agent.types.js';
import { createPeerReviewIntegration, PeerReviewMode } from '../issue-tracker/index.js';
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
// Create MCP server
const server = new McpServer({
    name: 'pr-agent',
    version: '1.0.0',
});
/**
 * analyze - Main entry point (uses same PRAnalyzerAgent as CLI)
 */
server.tool('analyze', `Analyze PR/branch changes - mirrors the CLI 'pr-agent analyze' command exactly.
Uses the same configuration file (.pragent.config.json) and supports all CLI features.
Returns formatted analysis for the calling LLM to display and enhance with AI insights.`, {
    branch: z.string().optional().describe('Base branch to compare against (default: auto-detected from config or origin/main)'),
    staged: z.boolean().optional().describe('Analyze staged changes instead of branch diff'),
    title: z.string().optional().describe('PR title (auto-detected from git if not provided)'),
    cwd: z.string().optional().describe('Working directory (defaults to current directory)'),
    verbose: z.boolean().optional().describe('Include additional debug information'),
    peerReview: z.boolean().optional().describe('Enable peer review (Jira ticket validation) - uses config if not specified'),
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
        // Enable peer review by default if configured (same as CLI)
        const peerReviewEnabled = args.peerReview ?? config.peerReview?.enabled ?? true;
        const ticketRefs = extractTicketReferences(title, currentBranch, commitMessages, config.peerReview?.defaultProject);
        // Create PRAnalyzerAgent in PROMPT_ONLY mode (LLM-agnostic)
        // Instead of executing prompts with an API key, we return prompts for the calling LLM to execute
        // This works with all MCP clients (Claude Code, Cursor, Windsurf, etc.) without API keys
        const agent = new PRAnalyzerAgent({ mode: ExecutionModeEnum.PROMPT_ONLY });
        // Run analysis to get prompts (no LLM execution)
        const useArchDocs = args.archDocs !== false;
        console.error('[MCP Server] Building analysis prompts in PROMPT_ONLY mode...');
        const analysisResult = await agent.analyze(diff, title, { summary: true, risks: true, complexity: true }, {
            useArchDocs,
            repoPath: workDir,
            language: config.analysis?.language,
            framework: config.analysis?.framework,
            enableStaticAnalysis: config.analysis?.enableStaticAnalysis !== false,
        });
        console.error('[MCP Server] Prompts built successfully');
        console.error('  - mode:', analysisResult.mode);
        console.error('  - prompt count:', analysisResult.mode === 'prompt_only' ? analysisResult.prompts.length : 'N/A');
        // Type guard: MCP server always uses PROMPT_ONLY mode
        if (analysisResult.mode !== 'prompt_only') {
            throw new Error('Expected prompt-only result in MCP PROMPT_ONLY mode');
        }
        // Get peer review prompts if enabled
        let peerReviewPrompts = [];
        if (peerReviewEnabled) {
            try {
                const peerReviewResult = await runPeerReview(config, diff, title, analysisResult, // Pass context - runPeerReview will get prompts too
                verbose, workDir);
                if (peerReviewResult && peerReviewResult.mode === 'prompt_only' && peerReviewResult.promptOnlyResult) {
                    peerReviewPrompts = peerReviewResult.promptOnlyResult.prompts;
                }
            }
            catch (error) {
                console.error('[MCP Server] Peer review prompt building failed:', error.message);
            }
        }
        // Format all prompts for output
        const allPrompts = [...analysisResult.prompts, ...peerReviewPrompts];
        let outputText = '🤖 **PR Agent Analysis - LLM-Agnostic Mode**\n\n';
        outputText += 'The following prompts should be executed sequentially using your LLM:\n\n';
        outputText += '---\n\n';
        allPrompts.forEach((prompt, i) => {
            const stepTitle = {
                'fileAnalysis': `📄 Step ${i + 1}: File Analysis`,
                'riskDetection': `⚠️  Step ${i + 1}: Risk Detection`,
                'summaryGeneration': `📋 Step ${i + 1}: Summary Generation`,
                'selfRefinement': `✨ Step ${i + 1}: Self Refinement`,
                'ticketQuality': `🎯 Step ${i + 1}: Ticket Quality Assessment`,
                'acValidation': `✅ Step ${i + 1}: Acceptance Criteria Validation`,
                'peerReview': `👥 Step ${i + 1}: Peer Review Analysis`,
            }[prompt.step] || `Step ${i + 1}`;
            outputText += `## ${stepTitle}\n\n`;
            outputText += `**Instructions:** ${prompt.instructions}\n\n`;
            outputText += '**Prompt:**\n```\n';
            outputText += prompt.prompt.substring(0, 5000); // Limit prompt size
            if (prompt.prompt.length > 5000) {
                outputText += '\n... (truncated for display)\n';
            }
            outputText += '\n```\n\n';
            outputText += '---\n\n';
        });
        outputText += '\n**Note:** These prompts are generated by PR Agent. Execute them sequentially and analyze the results.\n';
        // Return formatted output
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
/* OLD CODE REMOVED - MCP server now uses PROMPT_ONLY mode
     Removed old EXECUTE mode logic that is no longer needed
     (database saving, result property access, etc.)
*/
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
    app.get('*', (req, res) => {
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