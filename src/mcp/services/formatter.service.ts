/**
 * Formatter Service
 * Formats analysis output for MCP responses
 * Single Responsibility: Output formatting and presentation
 */

import type { AnalysisOutputOptions } from '../types.js';
import { OutputFormatter } from '../../utils/output-formatter.js';
import {
  PROMPT_STEP_EMOJIS,
  DEFAULT_PROMPT_EMOJI,
  DEFAULT_PROMPT_LIMIT_VERBOSE,
  DEFAULT_PROMPT_LIMIT_NORMAL,
  INSTRUCTIONS,
  PEER_REVIEW_ERROR_CAUSES,
  ERROR_MESSAGES,
} from '../constants.js';

export class FormatterService {
  /**
   * Format complete analysis output for MCP response
   */
  static formatAnalysisOutput(options: AnalysisOutputOptions): string {
    const lines: string[] = [];

    // Header (verbose only)
    if (options.verbose) {
      lines.push(`# 🤖 PR Agent Analysis\n`);
      lines.push(`**Repository:** ${options.repoInfo.owner}/${options.repoInfo.name}`);
      lines.push(`**Branch:** ${options.currentBranch} → ${options.baseBranch}`);
      lines.push(`**PR Title:** ${options.title || 'Untitled'}`);
      lines.push(`**Peer Review:** ${options.peerReviewEnabled ? '✅ Enabled' : '❌ Disabled'}`);
      lines.push(`**Prompts to execute:** ${options.allPrompts.length}\n`);
      lines.push(`---\n`);
    }

    // Static Analysis Results
    lines.push(`## 📊 Static Analysis Results\n`);

    if (options.staticAnalysis) {
      const formatter = new OutputFormatter({ mode: 'markdown', verbose: options.verbose });
      const staticOutput = formatter.formatStaticAnalysis(options.staticAnalysis);
      if (staticOutput) {
        lines.push(staticOutput);
        lines.push('\n');
      }
    }

    // Peer Review Error (if occurred)
    if (options.peerReviewEnabled && options.peerReviewError) {
      lines.push(`\n---\n`);
      lines.push(`## ⚠️ Peer Review Error\n`);
      lines.push(ERROR_MESSAGES.PEER_REVIEW_FAILED(options.peerReviewError));
      lines.push('\n');
      lines.push(`**Possible causes:**`);
      PEER_REVIEW_ERROR_CAUSES.forEach((cause) => lines.push(cause));
      lines.push('\n');
      lines.push(`Analysis will continue with base prompts only.\n`);
    }

    // LLM Analysis Workflow
    lines.push(`---\n`);
    lines.push(`## ⚡ LLM Analysis Workflow\n`);
    lines.push(INSTRUCTIONS.PROMPT_EXECUTION_WARNING);
    lines.push('\n');
    lines.push(`Execute the following ${options.allPrompts.length} prompts sequentially:\n`);

    // Format each prompt
    options.allPrompts.forEach((prompt, i) => {
      const stepEmoji = PROMPT_STEP_EMOJIS[prompt.step] || DEFAULT_PROMPT_EMOJI;
      lines.push(`### ${stepEmoji} Step ${i + 1}: ${prompt.step}\n`);

      if (options.verbose) {
        lines.push(`**Instructions:** ${prompt.instructions}\n`);
      }

      lines.push('**Prompt:**\n```');
      const promptLimit = options.verbose
        ? DEFAULT_PROMPT_LIMIT_VERBOSE
        : DEFAULT_PROMPT_LIMIT_NORMAL;
      lines.push(prompt.prompt.substring(0, promptLimit));

      if (prompt.prompt.length > promptLimit) {
        lines.push('\n... (truncated for display)');
      }
      lines.push('\n```\n');
      lines.push('---\n');
    });

    // Next Steps
    lines.push(`## 💾 Next Steps\n`);
    lines.push(INSTRUCTIONS.NEXT_STEPS_HEADER);
    INSTRUCTIONS.NEXT_STEPS(options.allPrompts.length).forEach((step) => {
      lines.push(step);
    });
    lines.push('\n');
    lines.push(INSTRUCTIONS.EXPECTED_TOKEN_USAGE);

    if (options.verbose) {
      lines.push('\n');
      lines.push(`**Save parameters:**`);
      lines.push(`- title: "${options.title || 'Untitled'}"`);
      lines.push(`- repoOwner: "${options.repoInfo.owner}"`);
      lines.push(`- repoName: "${options.repoInfo.name}"`);
      lines.push(`- complexity: (from summary step)`);
      lines.push(`- risksCount: (from risk detection step)`);
      lines.push(`- risks: (from risk detection step)`);
      lines.push(`- recommendations: (from summary step)`);

      if (options.peerReviewEnabled) {
        lines.push(`- peerReviewEnabled: true`);
        lines.push(`- ticketKey, acCompliancePercentage, etc.: (from peer review steps)`);
      }

      lines.push(`\n📊 Dashboard: http://localhost:3000`);
    }

    return lines.join('\n');
  }
}
