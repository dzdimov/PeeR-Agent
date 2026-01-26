/**
 * Init Command - First-run baseline analysis
 * Scans entire codebase and establishes baseline for incremental PR analysis
 */

import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import {
    scanCodebaseBaseline,
    formatBaselineReport,
    formatBaselineIssues,
    generateBaselineTestSuggestions,
} from '../../tools/baseline-scanner.js';
import {
    saveCodebaseBaseline,
    hasBaseline,
    getCodebaseBaseline,
    getBaselineIssues,
    getFilesWithoutTests,
    type CodebaseBaseline,
} from '../../db/index.js';

interface InitOptions {
    force?: boolean;
    branch?: string;
    verbose?: boolean;
}

interface BaselineOptions {
    show?: boolean;
    suggestTests?: boolean;
    filter?: string;
    limit?: number;
    verbose?: boolean;
}

/**
 * Get repository info from git remote URL
 */
function getRepoInfo(): { owner: string; name: string } {
    try {
        const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
        const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
            return { owner: sshMatch[1], name: sshMatch[2] };
        }
        const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
        if (httpsMatch) {
            return { owner: httpsMatch[1], name: httpsMatch[2] };
        }
        return { owner: 'local', name: process.cwd().split(/[\\/]/).pop() || 'unknown' };
    } catch {
        return { owner: 'local', name: process.cwd().split(/[\\/]/).pop() || 'unknown' };
    }
}

/**
 * Get current git branch
 */
function getCurrentBranch(): string {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch {
        return 'main';
    }
}

/**
 * Initialize codebase baseline
 */
export async function initBaseline(options: InitOptions = {}): Promise<void> {
    const repoInfo = getRepoInfo();
    const branch = options.branch || getCurrentBranch();

    console.log(chalk.cyan.bold('\n🚀 PR Agent Baseline Initialization\n'));
    console.log(chalk.gray(`   Repository: ${repoInfo.owner}/${repoInfo.name}`));
    console.log(chalk.gray(`   Branch: ${branch}\n`));

    // Check if baseline exists
    if (hasBaseline(repoInfo.owner, repoInfo.name, branch) && !options.force) {
        console.log(chalk.yellow('⚠️  Baseline already exists for this repository.'));
        console.log(chalk.gray('   Use --force to overwrite the existing baseline.\n'));

        const existing = getCodebaseBaseline(repoInfo.owner, repoInfo.name, branch);
        if (existing) {
            console.log(chalk.gray(`   Created: ${existing.created_at}`));
            console.log(chalk.gray(`   Coverage: ${existing.overall_coverage.toFixed(1)}%`));
            console.log(chalk.gray(`   Files without tests: ${existing.files_without_tests ? JSON.parse(existing.files_without_tests).length : 0}`));
        }
        return;
    }

    const spinner = ora('Scanning codebase...').start();

    try {
        // Run baseline scan
        spinner.stop();
        const result = await scanCodebaseBaseline(process.cwd());

        // Save to database
        const baseline: Omit<CodebaseBaseline, 'id' | 'created_at' | 'updated_at'> = {
            repo_owner: repoInfo.owner,
            repo_name: repoInfo.name,
            branch,
            overall_coverage: result.summary.overallCoverage,
            line_coverage: result.coverage.overall.lines.pct,
            branch_coverage: result.coverage.overall.branches.pct,
            eslint_errors: result.summary.eslintErrors,
            eslint_warnings: result.summary.eslintWarnings,
            files_without_tests: JSON.stringify(result.testGaps.filesWithoutTests),
            untested_functions: JSON.stringify(result.testGaps.untestedFunctions),
            total_source_files: result.summary.totalSourceFiles,
            total_test_files: result.summary.totalTestFiles,
            coverage_by_file: JSON.stringify(result.testGaps.coverageByFile),
            all_issues: JSON.stringify(result.issues),
        };

        saveCodebaseBaseline(baseline);

        console.log(chalk.green('\n✅ Baseline saved to database!\n'));
        console.log(formatBaselineReport(result));

        if (options.verbose) {
            console.log(chalk.gray('\n--- Verbose Details ---'));
            console.log(chalk.gray(`Issues stored: ${result.issues.length}`));
            console.log(chalk.gray(`Files without tests: ${result.testGaps.filesWithoutTests.length}`));
        }

    } catch (error: any) {
        spinner.fail('Baseline scan failed');
        console.error(chalk.red(`\n❌ Error: ${error.message}`));
        process.exit(1);
    }
}

/**
 * View or interact with existing baseline
 */
export async function viewBaseline(options: BaselineOptions = {}): Promise<void> {
    const repoInfo = getRepoInfo();
    const branch = 'main'; // Default to main for baseline lookup

    console.log(chalk.cyan.bold('\n📊 PR Agent Baseline\n'));

    // Check if baseline exists
    if (!hasBaseline(repoInfo.owner, repoInfo.name, branch)) {
        console.log(chalk.yellow('⚠️  No baseline found for this repository.'));
        console.log(chalk.gray('   Run: pr-agent init\n'));
        return;
    }

    const baseline = getCodebaseBaseline(repoInfo.owner, repoInfo.name, branch);
    if (!baseline) {
        console.log(chalk.red('❌ Failed to load baseline'));
        return;
    }

    // Show baseline summary
    console.log(chalk.gray(`Repository: ${repoInfo.owner}/${repoInfo.name}`));
    console.log(chalk.gray(`Branch: ${branch}`));
    console.log(chalk.gray(`Created: ${baseline.created_at}`));
    console.log(chalk.gray(`Updated: ${baseline.updated_at}`));
    console.log('');

    if (options.show) {
        // Show all issues
        const issues = getBaselineIssues(repoInfo.owner, repoInfo.name, branch);
        console.log(formatBaselineIssues(issues, options.filter));

    } else if (options.suggestTests) {
        // Generate test suggestions
        console.log(chalk.cyan('🧪 Generating test suggestions...\n'));

        const filesWithoutTests = getFilesWithoutTests(repoInfo.owner, repoInfo.name, branch);
        const limit = options.limit || 5;

        if (filesWithoutTests.length === 0) {
            console.log(chalk.green('✅ All files have tests!'));
            return;
        }

        const suggestions = await generateBaselineTestSuggestions(
            process.cwd(),
            filesWithoutTests,
            limit
        );

        console.log(chalk.cyan(`📝 Test Suggestions (${suggestions.length} files)\n`));
        console.log('─'.repeat(60));

        for (const suggestion of suggestions) {
            console.log(chalk.yellow(`\n📄 ${suggestion.forFile}`));
            console.log(chalk.gray(`   Test file: ${suggestion.testFilePath}`));
            console.log(chalk.gray(`   Framework: ${suggestion.testFramework}`));
            console.log(chalk.gray(`   ${suggestion.description}`));
            console.log('');
            console.log(chalk.cyan('   Suggested test code:'));
            console.log(chalk.gray('   ' + '─'.repeat(50)));

            // Show first 30 lines of test code
            const lines = suggestion.testCode.split('\n').slice(0, 30);
            for (const line of lines) {
                console.log(chalk.gray('   ' + line));
            }
            if (suggestion.testCode.split('\n').length > 30) {
                console.log(chalk.gray('   ... (truncated)'));
            }
            console.log('');
        }

        if (filesWithoutTests.length > limit) {
            console.log(chalk.gray(`\n💡 ${filesWithoutTests.length - limit} more files need tests.`));
            console.log(chalk.gray(`   Run with --limit ${filesWithoutTests.length} to see all.`));
        }

    } else {
        // Show summary
        console.log('📁 File Inventory');
        console.log('─'.repeat(40));
        console.log(`   Source files:     ${baseline.total_source_files}`);
        console.log(`   Test files:       ${baseline.total_test_files}`);

        const filesWithoutTests = baseline.files_without_tests ? JSON.parse(baseline.files_without_tests).length : 0;
        console.log(`   Files w/o tests:  ${filesWithoutTests}`);
        console.log('');

        console.log('📈 Test Coverage');
        console.log('─'.repeat(40));
        console.log(`   Overall:   ${baseline.overall_coverage.toFixed(1)}%`);
        console.log(`   Lines:     ${baseline.line_coverage.toFixed(1)}%`);
        console.log(`   Branches:  ${baseline.branch_coverage.toFixed(1)}%`);
        console.log('');

        console.log('🔬 Static Analysis');
        console.log('─'.repeat(40));
        console.log(`   ESLint Errors:   ${baseline.eslint_errors}`);
        console.log(`   ESLint Warnings: ${baseline.eslint_warnings}`);
        console.log('');

        console.log(chalk.gray('💡 Run "pr-agent baseline --show" to view all issues'));
        console.log(chalk.gray('💡 Run "pr-agent baseline --suggest-tests" for test suggestions'));
    }
}
