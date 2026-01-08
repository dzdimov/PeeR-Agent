import { Probot } from 'probot';
import express, { Request, Response, Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRAnalyzerAgent } from './agents/pr-analyzer-agent.js';
import { saveAnalysis, getDashboardStats, getRecentAnalyses } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase() as 'anthropic' | 'openai' | 'google';
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY;
const model = process.env.AI_MODEL;

/**
 * Format agent analysis result for GitHub comment
 */
function formatAnalysisForGitHub(result: any): string {
  let output = '';

  const criticalFixes = result.fixes?.filter((f: any) => f.severity === 'critical') || [];
  const warningFixes = result.fixes?.filter((f: any) => f.severity === 'warning') || [];
  const totalFixes = result.fixes?.length || 0;

  // Concise summary
  if (result.summary) {
    output += `### 📋 Summary\n${result.summary}\n\n`;
  }

  // Combined quick actions section (fixes + recommendations)
  const allActions: Array<{type: 'fix' | 'recommendation'; content: any; source: string}> = [];
  
  // Add fixes (from Semgrep or AI)
  if (totalFixes > 0) {
    const topFixes = [...criticalFixes, ...warningFixes].slice(0, 5);
    topFixes.forEach((fix: any) => {
      allActions.push({
        type: 'fix',
        content: fix,
        source: fix.source || 'ai',
      });
    });
  }
  
  // Add recommendations (from AI)
  if (result.recommendations && result.recommendations.length > 0) {
    result.recommendations.slice(0, 3).forEach((rec: string) => {
      allActions.push({
        type: 'recommendation',
        content: rec,
        source: 'ai',
      });
    });
  }
  
  if (allActions.length > 0) {
    output += `### 💡 Quick Actions\n\n`;
    
    let actionIndex = 1;
    allActions.forEach((action) => {
      if (action.type === 'fix') {
        const fix = action.content;
        const severityIcon = fix.severity === 'critical' ? '🔴' : '🟡';
        const severityLabel = fix.severity === 'critical' ? 'CRITICAL' : 'WARNING';
        const sourceLabel = action.source === 'semgrep' ? ' [Semgrep]' : ' [AI]';
        const shortComment = fix.comment.split('\n')[0].substring(0, 150);
        
        // Format exactly like Semgrep: Number. Icon `file:line` - LABEL [Source]
        output += `  ${actionIndex}. ${severityIcon} \`${fix.file}:${fix.line}\` - ${severityLabel}${sourceLabel}\n`;
        // Indented comment line
        output += `     ${shortComment}${fix.comment.length > 150 ? '...' : ''}\n\n`;
      } else {
        // Format recommendations to match Semgrep format
        const rec = action.content;
        const sourceLabel = action.source === 'semgrep' ? ' [Semgrep]' : ' [AI]';
        
        // Parse recommendation to extract severity
        let severityIcon = '🟡';
        let severityLabel = 'WARNING';
        let recText = rec;
        
        // Check if recommendation starts with **CRITICAL: or **WARNING:
        if (rec.match(/^\*\*CRITICAL:/i)) {
          severityIcon = '🔴';
          severityLabel = 'CRITICAL';
          recText = rec.replace(/^\*\*CRITICAL:\s*/i, '').replace(/\*\*/g, '');
        } else if (rec.match(/^\*\*WARNING:/i)) {
          severityIcon = '🟡';
          severityLabel = 'WARNING';
          recText = rec.replace(/^\*\*WARNING:\s*/i, '').replace(/\*\*/g, '');
        } else if (rec.toLowerCase().includes('critical')) {
          severityIcon = '🔴';
          severityLabel = 'CRITICAL';
        }
        
        // Format exactly like Semgrep: Number. Icon - LABEL [Source]
        output += `  ${actionIndex}. ${severityIcon} - ${severityLabel}${sourceLabel}\n`;
        // Indented comment line with severity prefix
        output += `     ${severityIcon} **${severityLabel === 'CRITICAL' ? 'Critical' : 'Warning'}**: ${recText.substring(0, 150)}${recText.length > 150 ? '...' : ''}\n\n`;
      }
      actionIndex++;
    });
    
    if (totalFixes > 5) {
      output += `_${totalFixes - 5} more issues found._\n\n`;
    }
  } else {
    output += `### ✅ Status\n\nNo critical issues found.\n\n`;
  }

  // Token count at the end
  if (result.totalTokensUsed) {
    output += `\n---\n_Total tokens used: ${result.totalTokensUsed.toLocaleString()}_`;
  }

  return output;
}

export default (app: Probot, { getRouter }: { getRouter?: (path?: string) => Router } = {}) => {
  app.log.info('🤖 PR Agent (LangChain) started');

  // Dashboard Routes
  if (getRouter) {
    // Determine public path for static assets
    const finalPublicPath = path.join(__dirname, 'public');
    
    const router = getRouter('/dashboard');
    if (router) {
      // Serve static files
      router.use(express.static(finalPublicPath));
      
      // API Endpoints
      router.get('/api/stats', (req: Request, res: Response) => {
        try {
          const stats = getDashboardStats();
          const recent = getRecentAnalyses();
          res.json({ stats, recent });
        } catch (error) {
          app.log.error('Error fetching stats:', error);
          res.status(500).json({ error: 'Failed to fetch stats' });
        }
      });

      router.get('/', (req: Request, res: Response) => {
        res.sendFile(path.join(finalPublicPath, 'index.html'));
      });
      
      app.log.info('NOTE: Dashboard available at /dashboard');
    }

    // Handle root path
    const rootRouter = getRouter();
    if (rootRouter) {
        // Serve static files at root
        rootRouter.use(express.static(finalPublicPath));

        // Serve index.html at root
        rootRouter.get('/', (req: Request, res: Response) => {
            res.sendFile(path.join(finalPublicPath, 'index.html'));
        });
        
        app.log.info('Dashboard configured at root /');
    }
  }

  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const { pull_request: pr, repository } = context.payload;
    
    app.log.info(`Analyzing PR #${pr.number} in ${repository.full_name}`);

    try {
      app.log.info('Getting PR diffs');
      const diff = await getPRDiffs(context);

      if (!apiKey) {
        throw new Error('AI provider API key is not set (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY)');
      }

      // Use LangChain agent for intelligent analysis
      app.log.info(`Running LangChain agent analysis with ${provider}...`);
      const agent = new PRAnalyzerAgent({
        provider: provider as any,
        apiKey,
        model,
      });
      const result = await agent.analyze(diff, pr.title);

      // Save to Database
      try {
        saveAnalysis({
          pr_number: pr.number,
          repo_owner: repository.owner.login,
          repo_name: repository.name,
          author: pr.user.login,
          title: pr.title,
          complexity: result.overallComplexity || 0,
          risks_count: result.overallRisks ? result.overallRisks.length : 0,
          risks: JSON.stringify(result.overallRisks || []),
          recommendations: JSON.stringify(result.recommendations || [])
        });
      } catch (dbError) {
        app.log.error('Failed to save analysis to DB:', dbError);
      }

      // Format the analysis for GitHub comment
      const summary = formatAnalysisForGitHub(result);
      
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pr.number,
        body: `## 🤖 AI Analysis (LangChain Agent)\n\n${summary}`
      });

      app.log.info(`Analysis posted for PR #${pr.number}`);

    } catch (error) {
      app.log.error('Error analyzing PR:', error);
    }
  });
};

async function getPRDiffs(context: any): Promise<string> {
  try {
    const { pull_request: pr, repository } = context.payload;
    
    const { data: files } = await context.octokit.pulls.listFiles({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pr.number
    });
    
    const diff = files.map((f: any) => `--- ${f.filename}\n${f.patch}`).join('\n');
    return diff;
  } catch (error) {
    console.error('Error fetching PR diff:', error);
    throw new Error('Failed to fetch PR diff');
  }
}
