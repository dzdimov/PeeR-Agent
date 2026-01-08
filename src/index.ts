import { Probot } from 'probot';
import express, { Request, Response, Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRAnalyzerAgent } from './agents/pr-analyzer-agent.js';
import { CouncilAgent } from './agents/council-agent.js';
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

  // --- Council Logic ---
  app.on('issue_comment.created', async (context) => {
      const { comment, repository, issue } = context.payload;
      
      // 1. Check trigger command "active the council"
      const body = comment.body.toLowerCase();
      if (!body.includes('assemble the council')) return;

      // 2. Verify it's a PR
      if (!issue.pull_request) return;

      app.log.info(`⚖️ Council assembled for PR #${issue.number}`);

      // 3. Rate Limit / Cost Check (Optional, implied by explicit command)
      // Acknowledge
      await context.octokit.reactions.createForIssueComment({
        owner: repository.owner.login,
        repo: repository.name,
        comment_id: comment.id,
        content: 'eyes'
      });

      try {
        // 4. Fetch diff manually (since we are in issue_comment context)
        const { data: files } = await context.octokit.pulls.listFiles({
          owner: repository.owner.login,
          repo: repository.name,
          pull_number: issue.number
        });
        const diff = files.map((f: any) => `--- ${f.filename}\n${f.patch}`).join('\n');

        // 5. Instantiate Council
        // We reuse the global provider/model config for the "Chairperson"
        const council = new CouncilAgent(provider, apiKey);

        const metadata = {
            title: issue.title,
            author: issue.user.login,
            repo: `${repository.owner.login}/${repository.name}`
        };

        const result = await council.analyze(diff, metadata);
        const summary = formatAnalysisForGitHub(result);

        const councilHeader = `## 🧙‍♂️ The AI Council Has Spoken\n> *Consensus review by multiple AI models*\n\n`;
        
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issue.number,
          body: councilHeader + summary
        });

      } catch (error) {
        app.log.error('Council Execution Failed:', error);
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issue.number,
          body: `**Council Adjourned**: An error occurred. ${error}`
        });
      }
  });
  // ---------------------

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
        // Calculate overall complexity from file analyses
        let overallComplexity = 1;
        if (result.fileAnalyses && result.fileAnalyses.size > 0) {
          const complexities = Array.from(result.fileAnalyses.values()).map((f: any) => f.complexity || 1);
          overallComplexity = Math.round(complexities.reduce((a: number, b: number) => a + b, 0) / complexities.length);
        }

        // Get risks from fixes with critical/warning severity
        const risks = result.fixes?.filter((f: any) => f.severity === 'critical' || f.severity === 'warning').map((f: any) => f.comment) || [];

        saveAnalysis({
          pr_number: pr.number,
          repo_owner: repository.owner.login,
          repo_name: repository.name,
          author: pr.user.login,
          title: pr.title,
          complexity: overallComplexity,
          risks_count: risks.length,
          risks: JSON.stringify(risks),
          recommendations: JSON.stringify(result.recommendations || [])
        });
      } catch (dbError) {
        app.log.error('Failed to save analysis to DB:', dbError);
      }

      // Format the analysis for GitHub comment
      let summary = formatAnalysisForGitHub(result);

      // --- Council Suggestion --
      if (overallComplexity >= 4) {
          summary += `\n\n---\n> 🧙‍♂️ **Effectively Complex**: This PR has a high complexity score. To initiate a multi-model consensus review, reply to this comment with: \`assemble the council\`.`;
      }
      // ------------------------
      
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
