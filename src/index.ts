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

  // Summary
  if (result.summary) {
    output += `### 📋 Summary\n${result.summary}\n\n`;
  }

  // Risks
  if (result.overallRisks && result.overallRisks.length > 0) {
    output += `### ⚠️ Risks Identified\n`;
    result.overallRisks.forEach((risk: string, i: number) => {
      output += `${i + 1}. ${risk}\n`;
    });
    output += '\n';
  }

  // Complexity
  if (result.overallComplexity) {
    output += `### 📊 Complexity Score: ${result.overallComplexity}/5\n\n`;
  }

  // Recommendations
  if (result.recommendations && result.recommendations.length > 0) {
    output += `### 💡 Recommendations\n`;
    result.recommendations.forEach((rec: string, i: number) => {
      output += `${i + 1}. ${rec}\n`;
    });
    output += '\n';
  }

  // File-level details (top 5 most complex)
  if (result.fileAnalyses && result.fileAnalyses.size > 0) {
    const files = Array.from(result.fileAnalyses.entries()) as Array<[string, any]>;
    const sortedFiles = files
      .sort((a, b) => b[1].complexity - a[1].complexity)
      .slice(0, 5);

    if (sortedFiles.length > 0) {
      output += `### 📁 Files of Interest\n`;
      sortedFiles.forEach(([path, analysis]) => {
        output += `- **${path}** (complexity: ${analysis.complexity}/5)\n`;
        if (analysis.risks && analysis.risks.length > 0) {
          output += `  - ⚠️ ${analysis.risks.join(', ')}\n`;
        }
      });
    }
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

  // TODO: Re-implement code suggestions using the new agent's code suggestion tool
  // The old code suggestion implementation has been removed
  // To implement this feature:
  // 1. Use the agent's createCodeSuggestionTool() from tools/pr-analysis-tools.ts
  // 2. Call the agent with the tool to generate code fixes based on reviewer comments
  // 
  // app.on(['pull_request_review_comment.created', 'pull_request_review_comment.edited'], async (context) => {
  //   // Implementation goes here
  // });
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
