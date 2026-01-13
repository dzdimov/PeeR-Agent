/**
 * Peer Review Integration
 *
 * This module integrates the Jira sub-agent with the main PR analysis workflow.
 * It handles:
 * - Extracting ticket references from PR metadata
 * - Fetching tickets from issue trackers
 * - Running the Jira sub-agent analysis
 * - Formatting the combined output
 */

import { JiraMcpClient, JiraConfig } from './jira-mcp-client.js';
import { JiraSubAgent, JiraSubAgentResult, JiraSubAgentContext } from '../agents/jira-sub-agent.js';
import {
  IssueTrackerProvider,
  IssueTrackerConfig,
  IssueTrackerType,
  IssueTicket,
  TicketReference,
  PeerReviewVerbosity,
} from '../types/issue-tracker.types.js';
import { BaseLanguageModel } from '@langchain/core/language_models/base';

// ========== Types ==========

export interface PeerReviewConfig {
  issueTracker: IssueTrackerConfig;
}

export interface PeerReviewContext {
  prTitle: string;
  prDescription?: string;
  branchName?: string;
  commitMessages?: string[];
  diff: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  // From existing PR analysis
  prSummary?: string;
  prRisks?: string[];
  prComplexity?: number;
}

export interface PeerReviewResult {
  enabled: boolean;
  ticketReferences: TicketReference[];
  linkedTickets: IssueTicket[];
  primaryTicket?: IssueTicket;
  analysis?: JiraSubAgentResult;
  error?: string;
}

// ========== Main Integration Class ==========

export class PeerReviewIntegration {
  private provider: IssueTrackerProvider | null = null;
  private subAgent: JiraSubAgent | null = null;
  private config: IssueTrackerConfig;

  constructor(config: IssueTrackerConfig, llm?: BaseLanguageModel) {
    this.config = config;
    this.initializeProvider();
    if (llm) {
      this.subAgent = new JiraSubAgent(llm);
    }
  }

  /**
   * Set the LLM for the sub-agent
   */
  setLLM(llm: BaseLanguageModel): void {
    this.subAgent = new JiraSubAgent(llm);
  }

  /**
   * Set MCP callback for the Jira client
   */
  setMcpCallback(
    callback: (tool: string, params: Record<string, unknown>) => Promise<unknown>
  ): void {
    if (this.provider && this.provider instanceof JiraMcpClient) {
      (this.provider as JiraMcpClient).setMcpCallback(callback);
    }
  }

  /**
   * Check if peer review is enabled and properly configured
   */
  isEnabled(): boolean {
    return this.config.enabled && this.provider !== null && this.provider.isConfigured();
  }

  /**
   * Run peer review analysis
   */
  async analyze(context: PeerReviewContext): Promise<PeerReviewResult> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        ticketReferences: [],
        linkedTickets: [],
      };
    }

    if (!this.provider) {
      return {
        enabled: true,
        ticketReferences: [],
        linkedTickets: [],
        error: 'Issue tracker provider not configured',
      };
    }

    try {
      // Step 1: Extract ticket references from PR metadata
      const ticketReferences = this.provider.extractTicketReferences({
        prTitle: context.prTitle,
        prDescription: context.prDescription,
        branchName: context.branchName,
        commitMessages: context.commitMessages,
      });

      if (ticketReferences.length === 0) {
        return {
          enabled: true,
          ticketReferences: [],
          linkedTickets: [],
          error: 'No ticket references found in PR title, description, or branch name',
        };
      }

      // Step 2: Fetch tickets
      const ticketKeys = [...new Set(ticketReferences.map((r) => r.key))];
      const linkedTickets = await this.provider.getTickets(ticketKeys);

      if (linkedTickets.length === 0) {
        return {
          enabled: true,
          ticketReferences,
          linkedTickets: [],
          error: `Could not fetch tickets: ${ticketKeys.join(', ')}`,
        };
      }

      // Primary ticket is the one with highest confidence reference
      const primaryTicket = linkedTickets[0];

      // Step 3: Run sub-agent analysis (if configured)
      let analysis: JiraSubAgentResult | undefined;
      if (this.subAgent && primaryTicket) {
        const subAgentContext: JiraSubAgentContext = {
          ticket: primaryTicket,
          prTitle: context.prTitle,
          prDescription: context.prDescription,
          diff: context.diff,
          files: context.files,
          prSummary: context.prSummary,
          prRisks: context.prRisks,
        };

        analysis = await this.subAgent.analyze(subAgentContext);
      }

      return {
        enabled: true,
        ticketReferences,
        linkedTickets,
        primaryTicket,
        analysis,
      };
    } catch (error) {
      return {
        enabled: true,
        ticketReferences: [],
        linkedTickets: [],
        error: `Peer review analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ========== Private Methods ==========

  private initializeProvider(): void {
    if (!this.config.enabled) return;

    switch (this.config.provider) {
      case 'jira':
        this.provider = new JiraMcpClient(this.config.providerConfig as unknown as JiraConfig);
        break;

      // Future providers
      case 'linear':
      case 'azure-devops':
      case 'github-issues':
      case 'gitlab-issues':
        console.warn(`Provider ${this.config.provider} not yet implemented, using Jira fallback`);
        break;

      default:
        console.warn(`Unknown provider: ${this.config.provider}`);
    }
  }
}

// ========== Factory Function ==========

/**
 * Create a PeerReviewIntegration from user config
 */
export function createPeerReviewIntegration(
  userConfig: PeerReviewUserConfig,
  llm?: BaseLanguageModel
): PeerReviewIntegration {
  const issueTrackerConfig: IssueTrackerConfig = {
    enabled: userConfig.enabled ?? false,
    provider: (userConfig.provider as IssueTrackerType) || 'jira',
    providerConfig: {
      useMcp: userConfig.useMcp ?? true,
      instanceUrl: userConfig.instanceUrl,
      email: userConfig.email,
      apiToken: userConfig.apiToken,
      defaultProject: userConfig.defaultProject,
      acceptanceCriteriaField: userConfig.acceptanceCriteriaField,
      storyPointsField: userConfig.storyPointsField,
      ticketPatterns: userConfig.ticketPatterns,
    },
    analyzeAcceptanceCriteria: userConfig.analyzeAcceptanceCriteria ?? true,
    rateTicketQuality: userConfig.rateTicketQuality ?? true,
    generateTestSuggestions: userConfig.generateTestSuggestions ?? true,
    checkScopeCreep: userConfig.checkScopeCreep ?? true,
    ticketPatterns: userConfig.ticketPatterns,
    includeTicketDetails: userConfig.includeTicketDetails ?? true,
    verbose: userConfig.verbose ?? false,
    verbosity: userConfig.verbosity ?? 'compact',
  };

  return new PeerReviewIntegration(issueTrackerConfig, llm);
}

// ========== User Config Type ==========

/**
 * User-facing configuration for peer review
 * This is what goes in .pragent.config.json
 */
export interface PeerReviewUserConfig {
  // Enable/disable peer review feature
  enabled?: boolean;

  // Issue tracker provider
  provider?: string; // 'jira' | 'linear' | 'azure-devops' | 'github-issues'

  // MCP-based access (preferred for Jira)
  useMcp?: boolean;

  // Direct API access (fallback)
  instanceUrl?: string; // e.g., "https://company.atlassian.net"
  email?: string;
  apiToken?: string;

  // Project settings
  defaultProject?: string;

  // Custom field mappings (Jira-specific)
  acceptanceCriteriaField?: string;
  storyPointsField?: string;

  // Ticket patterns for extraction (regex)
  ticketPatterns?: string[];

  // Analysis settings
  analyzeAcceptanceCriteria?: boolean;
  rateTicketQuality?: boolean;
  generateTestSuggestions?: boolean;
  checkScopeCreep?: boolean;

  // Output settings
  includeTicketDetails?: boolean;
  verbose?: boolean;
  verbosity?: 'minimal' | 'compact' | 'standard' | 'detailed' | 'verbose';
}

// ========== Output Formatting ==========

/**
 * Format peer review results for CLI output
 */
export function formatPeerReviewOutput(
  result: PeerReviewResult,
  verbosity: PeerReviewVerbosity = 'compact'
): string {
  const lines: string[] = [];

  if (!result.enabled) {
    return ''; // Silently skip if not enabled
  }

  if (result.error) {
    if (verbosity !== 'minimal') {
      lines.push('');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('                    🔍 PEER REVIEW ANALYSIS');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('');
    }
    lines.push(`⚠️  ${result.error}`);
    lines.push('');
    return lines.join('\n');
  }

  // MINIMAL MODE: Ultra-compact single-line output
  if (verbosity === 'minimal') {
    return formatMinimalOutput(result);
  }

  // All other modes: Start with header
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('                    🔍 PEER REVIEW ANALYSIS');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  // Ticket Information (show in compact+)
  if (result.primaryTicket) {
    const ticket = result.primaryTicket;
    lines.push('📋 LINKED TICKET');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`   Key:    ${ticket.key}`);
    lines.push(`   Title:  ${ticket.title}`);

    // Show type/status for standard+
    if (verbosity !== 'compact') {
      lines.push(`   Type:   ${ticket.type.toUpperCase()}`);
      lines.push(`   Status: ${ticket.status}`);
      if (ticket.storyPoints) {
        lines.push(`   Points: ${ticket.storyPoints}`);
      }
    }
    lines.push('');
  }

  // Ticket Quality Rating (show in standard+)
  if (result.analysis?.ticketQuality && shouldShowTicketQuality(verbosity)) {
    const quality = result.analysis.ticketQuality;
    const scoreEmoji = getScoreEmoji(quality.overallScore);

    lines.push('📊 TICKET QUALITY RATING');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`   Overall Score: ${scoreEmoji} ${quality.overallScore}/100 (${quality.tier.toUpperCase()})`);
    lines.push('');

    // Show dimension scores for standard+
    lines.push('   Dimension Scores:');
    lines.push(`   • Description Clarity:     ${formatScore(quality.dimensions.descriptionClarity)}`);
    lines.push(`   • Acceptance Criteria:     ${formatScore(quality.dimensions.acceptanceCriteriaQuality)}`);
    lines.push(`   • Testability:             ${formatScore(quality.dimensions.testabilityScore)}`);
    lines.push(`   • Scope Definition:        ${formatScore(quality.dimensions.scopeDefinition)}`);
    lines.push(`   • Technical Context:       ${formatScore(quality.dimensions.technicalContext)}`);
    lines.push(`   • Visual Documentation:    ${formatScore(quality.dimensions.visualDocumentation)}`);
    lines.push(`   • Completeness:            ${formatScore(quality.dimensions.completeness)}`);
    lines.push('');

    if (!quality.reviewable) {
      lines.push(`   ⚠️  Ticket Not Reviewable: ${quality.reviewabilityReason}`);
      lines.push('');
    }

    // Show weaknesses only in verbose mode
    if (verbosity === 'verbose' && quality.feedback.weaknesses.length > 0) {
      lines.push('   ⚠️  Ticket Weaknesses:');
      quality.feedback.weaknesses.forEach((w) => lines.push(`      • ${w}`));
      lines.push('');
    }
  }

  // Requirements Validation (derived from ticket analysis)
  if (result.analysis?.acValidation) {
    const validation = result.analysis.acValidation;
    const complianceEmoji = getScoreEmoji(validation.compliancePercentage);

    lines.push('✅ REQUIREMENTS VALIDATION');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`   Compliance: ${complianceEmoji} ${validation.compliancePercentage}%`);
    lines.push('');

    // Show derived requirements (show in detailed+)
    if (shouldShowDerivedRequirements(verbosity) && validation.derivedRequirements && validation.derivedRequirements.length > 0) {
      lines.push('   📋 DERIVED REQUIREMENTS (from ticket analysis):');
      validation.derivedRequirements.forEach((req) => {
        const importanceIcon = {
          essential: '🔴',
          expected: '🟡',
          nice_to_have: '🟢',
        }[req.importance];
        const sourceLabel = {
          description: 'desc',
          explicit_ac: 'AC',
          implied: 'implied',
          ticket_type: 'type',
          technical_context: 'tech',
        }[req.source];
        lines.push(`   ${importanceIcon} [${sourceLabel}] ${req.requirement}`);
      });
      lines.push('');
    }

    // Show requirement status (compact+: show unmet only, standard+: show all)
    const maxRequirements = verbosity === 'compact' ? 5 : Infinity;
    const requirementsToShow = verbosity === 'compact'
      ? validation.criteriaAnalysis.filter(c => c.status !== 'met').slice(0, maxRequirements)
      : validation.criteriaAnalysis;

    if (requirementsToShow.length > 0) {
      lines.push('   📊 REQUIREMENT STATUS:');
      requirementsToShow.forEach((c) => {
        const statusEmoji = {
          met: '✅',
          partial: '🟡',
          unmet: '❌',
          unclear: '❓',
        }[c.status];
        lines.push(`   ${statusEmoji} ${c.criteriaText.substring(0, 60)}${c.criteriaText.length > 60 ? '...' : ''}`);
        if (c.status !== 'met' && verbosity !== 'compact') {
          lines.push(`      └─ ${c.explanation.substring(0, 70)}${c.explanation.length > 70 ? '...' : ''}`);
        }
      });
      lines.push('');
    }

    // Show gaps with impact (compact: top 3, standard+: all)
    if (validation.gaps.length > 0) {
      const maxGaps = verbosity === 'compact' ? 3 : Infinity;
      const gapsToShow = validation.gaps.slice(0, maxGaps);

      lines.push('   ❌ COVERAGE GAPS:');
      gapsToShow.forEach((gap) => {
        const severityEmoji = { critical: '🔴', major: '🟠', minor: '🟡' }[gap.severity];
        lines.push(`   ${severityEmoji} [${gap.severity.toUpperCase()}] ${gap.gapDescription}`);
        if (verbosity !== 'compact') {
          lines.push(`      └─ Impact: ${gap.impact}`);
        }
      });
      lines.push('');
    }

    // Show missing behaviors (detailed+ only)
    if ((verbosity === 'detailed' || verbosity === 'verbose') && validation.missingBehaviors && validation.missingBehaviors.length > 0) {
      lines.push('   ⚠️  MISSING BEHAVIORS:');
      validation.missingBehaviors.forEach((b) => lines.push(`      • ${b}`));
      lines.push('');
    }
  }

  // Overall Peer Review Assessment
  if (result.analysis?.peerReview) {
    const review = result.analysis.peerReview;

    // Final verdict banner
    const verdictEmoji = {
      approve: '✅',
      request_changes: '❌',
      needs_discussion: '💬',
    }[review.verdict.recommendation];
    const verdictText = {
      approve: 'APPROVED',
      request_changes: 'CHANGES REQUESTED',
      needs_discussion: 'NEEDS DISCUSSION',
    }[review.verdict.recommendation];

    lines.push('🎯 PEER REVIEW VERDICT');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push(`   ${verdictEmoji} ${verdictText} (Confidence: ${review.verdict.confidenceLevel}%)`);
    lines.push('');
    lines.push(`   ${review.verdict.summary}`);
    lines.push('');

    lines.push('   Scores:');
    lines.push(`   • Implementation Completeness: ${formatScore(review.implementationCompleteness)}`);
    lines.push(`   • Quality Score:               ${formatScore(review.qualityScore)}`);
    lines.push('');

    // Blockers with details
    if (review.blockers.length > 0) {
      lines.push('   🚫 BLOCKERS (must fix before merge):');
      review.blockers.forEach((b) => {
        lines.push(`      • ${b.issue}`);
        lines.push(`        Reason: ${b.reason}`);
        if (b.location) {
          lines.push(`        Location: ${b.location}`);
        }
      });
      lines.push('');
    }

    // Warnings with details (limit based on verbosity)
    if (review.warnings.length > 0) {
      const maxWarnings = getMaxWarnings(verbosity);
      const warningsToShow = review.warnings.slice(0, maxWarnings);

      if (warningsToShow.length > 0) {
        lines.push('   ⚠️  WARNINGS (should address):');
        warningsToShow.forEach((w) => {
          lines.push(`      • ${w.issue}`);
          if (w.reason && verbosity !== 'compact') {
            lines.push(`        Reason: ${w.reason}`);
          }
        });
        lines.push('');
      }
    }

    // Regression risks (show in standard+, limit based on verbosity)
    if (review.regressionRisks && review.regressionRisks.length > 0 && verbosity !== 'compact') {
      const maxRisks = shouldShowAllRisks(verbosity) ? Infinity : 3;
      const risksToShow = review.regressionRisks.slice(0, maxRisks);

      lines.push('   ⚡ POTENTIAL REGRESSION RISKS:');
      risksToShow.forEach((r) => {
        const likelihoodEmoji = { high: '🔴', medium: '🟠', low: '🟡' }[r.likelihood];
        lines.push(`      ${likelihoodEmoji} ${r.risk}`);
        if (verbosity !== 'standard') {
          lines.push(`        Affected: ${r.affectedArea}`);
          lines.push(`        Why: ${r.reasoning}`);
        }
      });
      lines.push('');
    }

    // Uncovered scenarios (show in detailed+)
    if ((verbosity === 'detailed' || verbosity === 'verbose') && review.uncoveredScenarios && review.uncoveredScenarios.length > 0) {
      lines.push('   🔍 SCENARIOS NOT HANDLED:');
      review.uncoveredScenarios.forEach((s) => {
        const impactEmoji = { critical: '🔴', major: '🟠', minor: '🟡' }[s.impact];
        lines.push(`      ${impactEmoji} ${s.scenario}`);
        if (s.relatedCriteria && verbosity === 'verbose') {
          lines.push(`        Related to: ${s.relatedCriteria}`);
        }
      });
      lines.push('');
    }

    // Scope analysis (show in standard+)
    if (verbosity !== 'compact' && review.scopeAnalysis.scopeCreepRisk) {
      lines.push('   ⚠️  SCOPE CREEP DETECTED:');
      lines.push(`      ${review.scopeAnalysis.scopeCreepDetails || 'Changes may exceed ticket scope'}`);
      if ((verbosity === 'detailed' || verbosity === 'verbose') && review.scopeAnalysis.outOfScope.length > 0) {
        lines.push('      Out of scope changes:');
        review.scopeAnalysis.outOfScope.slice(0, 3).forEach((s) => lines.push(`      • ${s}`));
      }
      lines.push('');
    }

    // Recommendations (limit based on verbosity)
    if (review.recommendations.length > 0) {
      const maxRecs = verbosity === 'compact' ? 3 : verbosity === 'standard' ? 5 : Infinity;
      const recsToShow = review.recommendations.slice(0, maxRecs);

      lines.push('   💡 RECOMMENDATIONS:');
      recsToShow.forEach((r) => lines.push(`      • ${r}`));
      lines.push('');
    }
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format minimal output (ultra-compact single line)
 */
function formatMinimalOutput(result: PeerReviewResult): string {
  const lines: string[] = [];

  // Build compact summary line
  const parts: string[] = [];

  // Verdict
  if (result.analysis?.peerReview) {
    const review = result.analysis.peerReview;
    const verdictEmoji = {
      approve: '✅',
      request_changes: '❌',
      needs_discussion: '💬',
    }[review.verdict.recommendation];
    const verdictText = {
      approve: 'APPROVED',
      request_changes: 'CHANGES REQUESTED',
      needs_discussion: 'NEEDS DISCUSSION',
    }[review.verdict.recommendation];
    parts.push(`${verdictEmoji} ${verdictText}`);
  }

  // Compliance
  if (result.analysis?.acValidation) {
    parts.push(`${result.analysis.acValidation.compliancePercentage}% compliant`);
  }

  // Ticket reference
  if (result.primaryTicket) {
    parts.push(`${result.primaryTicket.key}: ${result.primaryTicket.title.substring(0, 40)}${result.primaryTicket.title.length > 40 ? '...' : ''}`);
  }

  // Blockers/Warnings count
  if (result.analysis?.peerReview) {
    const blockers = result.analysis.peerReview.blockers.length;
    const warnings = result.analysis.peerReview.warnings.length;
    parts.push(`🚫 ${blockers} blockers`);
    parts.push(`⚠️  ${warnings} warnings`);
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`🔍 PEER REVIEW: ${parts.join(' | ')}`);
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

function shouldShowTicketQuality(verbosity: PeerReviewVerbosity): boolean {
  return ['standard','detailed','verbose'].includes(verbosity);
}

function shouldShowDerivedRequirements(verbosity: PeerReviewVerbosity): boolean {
  return ['detailed','verbose'].includes(verbosity);
}

function shouldShowAllRisks(verbosity: PeerReviewVerbosity): boolean {
  return ['detailed','verbose'].includes(verbosity);
}

function getMaxWarnings(verbosity: PeerReviewVerbosity): number {
  switch (verbosity) {
    case 'minimal': return 0;
    case 'compact': return 3;
    case 'standard': return 5;
    case 'detailed': 
    case 'verbose': return Infinity;
  }
}

function getScoreEmoji(score: number): string {
  if (score >= 85) return '🟢';
  if (score >= 70) return '🟡';
  if (score >= 50) return '🟠';
  return '🔴';
}

function formatScore(score: number): string {
  const emoji = getScoreEmoji(score);
  const bar = '█'.repeat(Math.floor(score / 10)) + '░'.repeat(10 - Math.floor(score / 10));
  return `${emoji} ${bar} ${score}`;
}

/**
 * Format peer review results for GitHub PR comment
 */
export function formatPeerReviewMarkdown(
  result: PeerReviewResult,
  verbosity: PeerReviewVerbosity = 'compact'
): string {
  if (!result.enabled || result.error) {
    return '';
  }

  const lines: string[] = [];

  lines.push('## 🔍 Peer Review Analysis');
  lines.push('');

  // Verdict banner at the top
  if (result.analysis?.peerReview) {
    const review = result.analysis.peerReview;
    const verdictEmoji = {
      approve: '✅',
      request_changes: '❌',
      needs_discussion: '💬',
    }[review.verdict.recommendation];
    const verdictText = {
      approve: 'APPROVED',
      request_changes: 'CHANGES REQUESTED',
      needs_discussion: 'NEEDS DISCUSSION',
    }[review.verdict.recommendation];

    lines.push(`### ${verdictEmoji} Verdict: ${verdictText}`);
    lines.push('');
    lines.push(`> ${review.verdict.summary}`);
    lines.push('');
  }

  // Ticket Information (show in compact+)
  if (result.primaryTicket) {
    const ticket = result.primaryTicket;
    lines.push(`### 📋 Linked Ticket: [${ticket.key}](${ticket.url})`);
    lines.push('');
    lines.push(`**${ticket.title}**`);
    lines.push('');

    // Show details for standard+ (use collapsible for compact)
    if (verbosity === 'compact') {
      lines.push('<details>');
      lines.push('<summary>Ticket Details</summary>');
      lines.push('');
    }

    lines.push(`| Property | Value |`);
    lines.push(`|----------|-------|`);
    lines.push(`| Type | ${ticket.type} |`);
    lines.push(`| Status | ${ticket.status} |`);
    if (ticket.storyPoints) {
      lines.push(`| Story Points | ${ticket.storyPoints} |`);
    }

    if (verbosity === 'compact') {
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }

  // Ticket Quality (show in standard+, collapsed in compact)
  if (result.analysis?.ticketQuality && shouldShowTicketQuality(verbosity)) {
    const quality = result.analysis.ticketQuality;

    if (verbosity === 'compact') {
      // Compact: Just show score, collapse details
      lines.push('<details>');
      lines.push(`<summary>📊 Ticket Quality: ${quality.overallScore}/100 (${quality.tier})</summary>`);
      lines.push('');
    } else {
      lines.push('### 📊 Ticket Quality');
      lines.push('');
      lines.push(`**Overall Score: ${quality.overallScore}/100** (${quality.tier})`);
      lines.push('');
    }

    if (!quality.reviewable) {
      lines.push(`> ⚠️ **Warning:** ${quality.reviewabilityReason}`);
      lines.push('');
    }

    if (verbosity === 'verbose' && quality.feedback.weaknesses.length > 0) {
      lines.push('**Ticket Weaknesses:**');
      lines.push('');
      quality.feedback.weaknesses.forEach((w) => lines.push(`- ${w}`));
      lines.push('');
    }

    if (verbosity === 'compact') {
      lines.push('</details>');
      lines.push('');
    }
  }

  // Requirements Validation (derived from ticket)
  if (result.analysis?.acValidation) {
    const validation = result.analysis.acValidation;
    lines.push('### ✅ Requirements Validation');
    lines.push('');
    lines.push(`**Compliance: ${validation.compliancePercentage}%**`);
    lines.push('');

    // Show derived requirements (detailed+ only, always collapsible)
    if (shouldShowDerivedRequirements(verbosity) && validation.derivedRequirements && validation.derivedRequirements.length > 0) {
      lines.push('<details>');
      lines.push('<summary>📋 Derived Requirements (from ticket analysis)</summary>');
      lines.push('');
      lines.push('| Importance | Source | Requirement |');
      lines.push('|------------|--------|-------------|');
      validation.derivedRequirements.forEach((req) => {
        const importanceEmoji = { essential: '🔴', expected: '🟡', nice_to_have: '🟢' }[req.importance];
        lines.push(`| ${importanceEmoji} ${req.importance} | ${req.source} | ${req.requirement} |`);
      });
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    // Show requirement status (compact: unmet only, standard+: all)
    const requirementsToShow = verbosity === 'compact'
      ? validation.criteriaAnalysis.filter(c => c.status !== 'met').slice(0, 5)
      : validation.criteriaAnalysis;

    if (requirementsToShow.length > 0) {
      lines.push('| Status | Requirement |');
      lines.push('|--------|-------------|');
      requirementsToShow.forEach((c) => {
        const statusEmoji = { met: '✅', partial: '🟡', unmet: '❌', unclear: '❓' }[c.status];
        lines.push(`| ${statusEmoji} ${c.status} | ${c.criteriaText.substring(0, 80)}${c.criteriaText.length > 80 ? '...' : ''} |`);
      });
      lines.push('');
    }

    if (validation.gaps.length > 0) {
      const maxGaps = verbosity === 'compact' ? 3 : Infinity;
      const gapsToShow = validation.gaps.slice(0, maxGaps);

      lines.push('#### ❌ Coverage Gaps');
      lines.push('');
      gapsToShow.forEach((gap) => {
        lines.push(`- **[${gap.severity}]** ${gap.gapDescription}`);
        if (verbosity !== 'compact') {
          lines.push(`  - _Impact:_ ${gap.impact}`);
        }
      });
      lines.push('');
    }
  }

  // Peer Review Details
  if (result.analysis?.peerReview) {
    const review = result.analysis.peerReview;
    lines.push('### 🎯 Assessment Details');
    lines.push('');
    lines.push(`| Metric | Score |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Implementation Completeness | ${review.implementationCompleteness}% |`);
    lines.push(`| Quality Score | ${review.qualityScore}% |`);
    lines.push(`| Confidence | ${review.verdict.confidenceLevel}% |`);
    lines.push('');

    if (review.blockers.length > 0) {
      lines.push('#### 🚫 Blockers (Must Fix)');
      lines.push('');
      review.blockers.forEach((b) => {
        lines.push(`- **${b.issue}**`);
        lines.push(`  - ${b.reason}`);
        if (b.location) {
          lines.push(`  - 📍 ${b.location}`);
        }
      });
      lines.push('');
    }

    if (review.warnings.length > 0) {
      const maxWarnings = getMaxWarnings(verbosity);
      const warningsToShow = review.warnings.slice(0, maxWarnings);

      if (warningsToShow.length > 0) {
        lines.push('#### ⚠️ Warnings (Should Address)');
        lines.push('');
        warningsToShow.forEach((w) => {
          lines.push(`- **${w.issue}**`);
          if (w.reason && verbosity !== 'compact') {
            lines.push(`  - ${w.reason}`);
          }
        });
        lines.push('');
      }
    }

    // Regression risks (show in standard+, always collapsible)
    if (review.regressionRisks && review.regressionRisks.length > 0 && verbosity !== 'compact') {
      const maxRisks = shouldShowAllRisks(verbosity) ? Infinity : 3;
      const risksToShow = review.regressionRisks.slice(0, maxRisks);

      lines.push('<details>');
      lines.push('<summary>⚡ Potential Regression Risks</summary>');
      lines.push('');
      risksToShow.forEach((r) => {
        lines.push(`- **${r.risk}** (${r.likelihood} likelihood)`);
        lines.push(`  - Affects: ${r.affectedArea}`);
        lines.push(`  - Reason: ${r.reasoning}`);
      });
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    // Uncovered scenarios (detailed+ only)
    if ((verbosity === 'detailed' || verbosity === 'verbose') && review.uncoveredScenarios && review.uncoveredScenarios.length > 0) {
      lines.push('<details>');
      lines.push('<summary>🔍 Scenarios Not Handled</summary>');
      lines.push('');
      review.uncoveredScenarios.forEach((s) => {
        lines.push(`- **[${s.impact}]** ${s.scenario}`);
        if (s.relatedCriteria && verbosity === 'verbose') {
          lines.push(`  - Related to: ${s.relatedCriteria}`);
        }
      });
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    // Scope creep (standard+ only)
    if (verbosity !== 'compact' && review.scopeAnalysis.scopeCreepRisk) {
      lines.push('> ⚠️ **Scope Creep Detected:** ' + (review.scopeAnalysis.scopeCreepDetails || 'Changes may exceed ticket scope'));
      lines.push('');
    }
  }

  return lines.join('\n');
}
