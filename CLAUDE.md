# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PR Agent is an AI-powered pull request analyzer available as both a CLI tool and a GitHub Action. It analyzes code changes using multiple AI providers (Anthropic Claude, OpenAI GPT, Google Gemini) and provides summaries, risk detection, complexity scoring, and architecture-aware recommendations.

## Build & Development Commands

```bash
# Install dependencies (--legacy-peer-deps required for LangChain peer dependency conflicts)
npm install --legacy-peer-deps

# Build everything (TypeScript + GitHub Action bundle)
npm run build

# Build TypeScript only
npm run build:tsc

# Build GitHub Action only (uses @vercel/ncc)
npm run build:action

# Clean and rebuild
npm run build:clean

# Run tests
npm test
npm test -- --watch        # Watch mode
npm test -- --coverage     # With coverage

# Run single test file
npm test -- tests/config-loader.test.ts

# Development mode (no build needed)
npm run dev

# Run CLI from built dist
npm run cli
```

## Architecture

The project follows a modular monolith pattern with four layers:

### Entry Points
- `src/cli/index.ts` - CLI entry point using Commander.js
- `src/action.ts` - GitHub Action entry point
- `src/index.ts` - Probot app integration

### Core Analysis Engine
- `src/agents/pr-analyzer-agent.ts` - Main LangChain-based analysis workflow
- `src/agents/base-pr-agent-workflow.ts` - LangGraph workflow orchestration

### AI Provider Layer
- `src/providers/` - Provider implementations (Anthropic, OpenAI, Google)
- `src/providers/provider.factory.ts` - Factory pattern for instantiation
- `src/providers/provider.interface.ts` - Common interface all providers implement

### Tools & Utilities
- `src/tools/pr-analysis-tools.ts` - Diff parsing and analysis tools
- `src/utils/arch-docs-parser.ts` - Parse `.arch-docs` documentation folder
- `src/utils/arch-docs-rag.ts` - RAG (Retrieval-Augmented Generation) for architecture context
- `src/utils/branch-resolver.ts` - Git branch detection and resolution
- `src/cli/utils/config-loader.ts` - Configuration file management

### Data Flow
```
User Input → CLI/Action Interface → Config Loader → PRAnalyzerAgent
    → Parse Diff → Load Architecture Docs (optional) → Build RAG Context
    → Provider Factory → AI Provider → Structured Analysis Results
    → Format Output (CLI terminal or GitHub PR comment)
```

## Key Configuration Files

- `.pragent.config.json` - User configuration (AI provider, model, API keys, analysis settings)
- `.pr-analyzer.yml` - GitHub Action configuration
- `action.yml` - GitHub Action manifest

## Technology Stack

- **Framework**: TypeScript/Node.js (ES Modules), requires Node.js >=18.0.0
- **AI Orchestration**: LangChain v1.x with LangGraph for workflow management
- **CLI Framework**: Commander.js with Inquirer for interactive prompts
- **Testing**: Jest with ts-jest
- **Action Bundling**: @vercel/ncc bundles the GitHub Action into a single file

## Important Notes

- Large diffs (>50KB) automatically use agent-based chunking (configurable via `analysis.agentThreshold`)
- The GitHub Action bundle in `dist/` must be committed after changes to action code
- Environment variables `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY` can be used instead of config file
- Default branch detection uses: config file → GitHub API → git commands → fallback to `origin/main`

## Peer Review Verbosity Levels

The peer review output supports 5 verbosity levels to control the amount of detail shown:

### Configuration

**In `.pragent.config.json`:**
```json
{
  "peerReview": {
    "enabled": true,
    "verbosity": "compact"  // minimal | compact | standard | detailed | verbose
  }
}
```

**Via CLI flag (overrides config):**
```bash
pr-agent analyze --peer-review-verbosity minimal
pr-agent analyze --peer-review-verbosity detailed
```

### Verbosity Levels

#### `minimal` (3 lines)
Ultra-compact single-line summary for CI/CD status checks:
```
═══════════════════════════════════════════════════════════════
🔍 PEER REVIEW: ✅ APPROVED | 85% compliant | PROJ-123 | 🚫 0 blockers | ⚠️ 2 warnings
═══════════════════════════════════════════════════════════════
```

#### `compact` (15-30 lines) - **DEFAULT**
Essential information for code review:
- Ticket key + title
- Verdict + confidence
- Compliance percentage
- Top 5 unmet requirements (no explanations)
- Top 3 coverage gaps (no impact details)
- Top 3 warnings (no reasons)
- Top 3 recommendations

**Use case**: Most users, GitHub PR comments (with collapsible sections)

#### `standard` (40-80 lines)
Thorough code review with details:
- All from `compact` +
- Ticket type/status/story points
- Full quality dimensions (7 scores)
- All requirements with explanations
- All gaps with impact analysis
- Top 3 regression risks (names only)
- Scope creep detection
- Top 5 recommendations

**Use case**: Senior developers, thorough reviews

#### `detailed` (100-150 lines)
Deep analysis for investigation:
- All from `standard` +
- Derived requirements from ticket
- All regression risks (with affected areas + reasoning)
- Uncovered scenarios
- Missing behaviors
- Out-of-scope changes

**Use case**: Debugging ticket issues, compliance audits

#### `verbose` (150-230+ lines)
Debug mode with maximum detail:
- All from `detailed` +
- Ticket weaknesses
- Full explanations for partial matches
- Related criteria for scenarios

**Use case**: Development, training the sub-agent

### Examples

**Quick feedback (CI/CD):**
```json
{ "peerReview": { "verbosity": "minimal" } }
```

**Code reviews (default):**
```json
{ "peerReview": { "verbosity": "compact" } }  // or omit - it's the default
```

**Debugging/audits:**
```json
{ "peerReview": { "verbosity": "verbose" } }
```

**CLI override:**
```bash
# Use verbose output for this analysis only
pr-agent analyze --peer-review-verbosity verbose

# Use minimal output
pr-agent analyze --peer-review-verbosity minimal
```
