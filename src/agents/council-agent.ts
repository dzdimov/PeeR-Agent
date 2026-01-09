
import { AgentResult, AgentMetadata } from '../types/agent.types.js';
import { PRAnalyzerAgent } from './pr-analyzer-agent.js';
import { ProviderFactory } from '../providers/provider.factory.js';
import { BasePRAgentWorkflow } from './base-pr-agent-workflow.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

/**
 * Council Agent
 * Orchestrates multiple AI models to review a PR and synthesized a consensus result.
 */
export class CouncilAgent {
  private primaryAgent: PRAnalyzerAgent;

  constructor(private primaryProvider = 'anthropic', private primaryApiKey?: string) {
    // We instantiate a primary agent to act as the "Chairperson"
    this.primaryAgent = new PRAnalyzerAgent({
      provider: primaryProvider as any,
      apiKey: primaryApiKey,
      model: process.env.AI_MODEL
    });
  }

  getMetadata(): AgentMetadata {
    return {
      name: 'llm-council',
      version: '1.0.0',
      description: 'Multi-model consensus review',
      capabilities: ['consensus-building', 'multi-perspective analysis', 'conflict resolution']
    };
  }

  /**
   * Run the Council Analysis
   */
  async analyze(diff: string, prMetadata: any): Promise<AgentResult> {
    console.log('🧙 Council Assembled. Analyzing PR...');

    // 1. Identify available Council Members based on Env Vars
    const members = this.recruitCouncilMembers();
    
    if (members.length < 2) {
      console.warn('⚠️ Council requires at least 2 distinct providers. Falling back to single agent.');
      return this.primaryAgent.analyze(diff, prMetadata);
    }

    // 2. Run Parallel Reviews
    console.log(`running reviews with ${members.length} members: ${members.map(m => m.provider).join(', ')}`);
    
    // We run the "analyze" method of independent agents
    // Note: We create lightweight instances just for this pass
    const reviewPromises = members.map(member => {
      const agent = new PRAnalyzerAgent({
        provider: member.provider as any,
        apiKey: member.apiKey,
        temperature: 0.2 // Low temp for analytical consistency
      });
      return agent.analyze(diff, prMetadata)
        .then(result => ({ provider: member.provider, result }))
        .catch(err => ({ provider: member.provider, error: err }));
    });

    const outcomes = await Promise.all(reviewPromises);
    const successfulReviews = outcomes.filter((o: any) => !o.error && o.result);

    if (successfulReviews.length === 0) {
      throw new Error('All council members failed to review the PR.');
    }

    // 3. Chairperson Synthesis
    return this.synthesizeReviews(successfulReviews, prMetadata);
  }

  /**
   * Detects available providers from environment variables
   */
  private recruitCouncilMembers() {
    const members = [];
    
    // Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      members.push({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY });
    }
    
    // OpenAI
    if (process.env.OPENAI_API_KEY) {
      members.push({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
    }

    // Google
    if (process.env.GOOGLE_API_KEY) {
      members.push({ provider: 'google', apiKey: process.env.GOOGLE_API_KEY });
    }

    // Zhipu (if added)
    if (process.env.ZHIPU_API_KEY) {
        members.push({ provider: 'zhipu', apiKey: process.env.ZHIPU_API_KEY });
    }

    return members;
  }

  /**
   * Uses the primary model to merge reviews
   */
  private async synthesizeReviews(reviews: any[], metadata: any): Promise<AgentResult> {
    console.log('⚖️ Chairperson synthesizing results...');

    const aggregatedReviews = reviews.map(r => {
      return `### Report from ${r.provider.toUpperCase()}\nJSON Output: ${JSON.stringify(r.result, null, 2)}`;
    }).join('\n\n---\n\n');

    const prompt = `
      You are the Chairperson of the LLM Council, a supreme code review board.
      You have received independent reviews from ${reviews.length} different AI models regarding the same Pull Request.
      
      PR Title: ${metadata.title}
      PR Author: ${metadata.author}

      Your Goal: Harmonize these reviews into a single, authoritative JSON report.

      Guidelines:
      1. COMPLEXITY: Average the complexity scores.
      2. RISKS: If ANY model found a High/Critical risk, you must include it. Do not suppress safety warnings.
      3. SUMMARY: Write a summary that acknowledges the consensus (e.g. "The Council unanimously agrees..." or "The Council detected conflicting views on...").
      4. RECOMMENDATIONS: Merge duplicate recommendations. Keep the most insightful ones.

      Format:
      Return ONLY valid JSON matching this schema:
      {
        "summary": "string",
        "complexity": number (1-5),
        "risks": [ { "type": "string", "severity": "low|medium|high|critical", "description": "string", "file": "string" } ],
        "suggestions": [ "string" ],
        "fixes": [ { "file": "string", "line": number, "description": "string", "suggestion": "string" } ]
      }

      Here are the reviews:
      ${aggregatedReviews}
    `;

    // Access the LLM directly from the primary agent's underlying workflow or create a direct call
    // Since BasePRAgentWorkflow wraps the model, we can just use the model directly via the Factory for this specific call
    const chairpersonModel = ProviderFactory.createChatModel({
        provider: this.primaryAgent['model'] ? this.primaryProvider as any : 'anthropic', // simplifying access
        apiKey: this.primaryApiKey,
        temperature: 0.1 // precise synthesis
    });

    const response = await chairpersonModel.invoke([
        new SystemMessage("You are a code review synthesizer. Output JSON only."),
        new HumanMessage(prompt)
    ]);

    let content = response.content.toString();
    
    // Clean up markdown code blocks if present
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
        const parsed = JSON.parse(content);
        return {
            summary: parsed.summary,
            analysis: {
                complexity: parsed.complexity,
                risks: parsed.risks,
                recommendations: parsed.suggestions || [], // detailed agent uses 'suggestions' sometimes
                commonIssues: [] 
            },
            // Map back to AgentResult structure
            fixes: parsed.fixes || []
        };
    } catch (e) {
        console.error('Failed to parse Chairman response:', content);
        // Fallback: return the first review but marked as such
        const fallback = reviews[0].result;
        fallback.summary = `[Council Synthesis Failed] Displaying result from ${reviews[0].provider}. Error: ${e}`;
        return fallback;
    }
  }
}
