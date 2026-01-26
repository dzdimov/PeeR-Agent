/**
 * Baseline Scanner Tool for First-Run Codebase Analysis
 * Scans entire codebase to establish a baseline for incremental PR analysis
 */

import fs from 'fs';
import path from 'path';
import {
    getCoverageAnalysis,
    runEslintAnalysis,
    type CoverageAnalysis,
    type StaticAnalysis,
} from './coverage-analyzer.js';
import { detectTestFramework, generateTestTemplate, suggestTestFilePath } from './test-suggestion-tool.js';
import type { TestSuggestion } from '../types/agent.types.js';

// ========== Types ==========

export interface BaselineIssue {
    type: 'no-test' | 'low-coverage' | 'eslint-error' | 'eslint-warning' | 'untested-function';
    file: string;
    line?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
    ruleId?: string;
    functionName?: string;
}

export interface BaselineScanResult {
    coverage: CoverageAnalysis;
    staticAnalysis: StaticAnalysis;
    testGaps: {
        filesWithoutTests: string[];
        untestedFunctions: Array<{ file: string; name: string }>;
        coverageByFile: Record<string, number>;
    };
    issues: BaselineIssue[];
    summary: {
        totalSourceFiles: number;
        totalTestFiles: number;
        overallCoverage: number;
        filesWithoutTests: number;
        eslintErrors: number;
        eslintWarnings: number;
        totalIssues: number;
    };
    scannedAt: string;
}

// ========== File Discovery ==========

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'];
const TEST_PATTERNS = ['.test.', '.spec.', '_test.', 'test_'];
const IGNORE_DIRS = ['node_modules', 'dist', 'build', '.git', 'coverage', '__pycache__'];

/**
 * Recursively find files in a directory
 */
function findFilesRecursive(dir: string, filterFn: (filePath: string) => boolean): string[] {
    const results: string[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Skip ignored directories
                if (IGNORE_DIRS.includes(entry.name)) continue;
                results.push(...findFilesRecursive(fullPath, filterFn));
            } else if (entry.isFile()) {
                if (filterFn(fullPath)) {
                    results.push(fullPath);
                }
            }
        }
    } catch (e) {
        // Skip directories we can't read
    }

    return results;
}

/**
 * Check if a file is a source file (not a test file)
 */
function isSourceFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath);

    // Must have a source extension
    if (!SOURCE_EXTENSIONS.includes(ext)) return false;

    // Skip .d.ts files
    if (filePath.endsWith('.d.ts')) return false;

    // Skip test files
    if (TEST_PATTERNS.some(p => basename.includes(p))) return false;

    // Skip files in test directories
    if (filePath.includes('/tests/') || filePath.includes('/test/') || filePath.includes('/__tests__/')) {
        return false;
    }

    return true;
}

/**
 * Check if a file is a test file
 */
function isTestFileCheck(filePath: string): boolean {
    const basename = path.basename(filePath);
    return TEST_PATTERNS.some(p => basename.includes(p)) ||
        filePath.includes('/tests/') ||
        filePath.includes('/test/') ||
        filePath.includes('/__tests__/');
}

/**
 * Find all source files in the codebase
 */
export async function findSourceFiles(repoPath: string): Promise<string[]> {
    const files = findFilesRecursive(repoPath, isSourceFile);
    // Convert to relative paths
    return files.map(f => path.relative(repoPath, f));
}

/**
 * Find all test files in the codebase
 */
export async function findTestFiles(repoPath: string): Promise<string[]> {
    const files = findFilesRecursive(repoPath, (f) => {
        const ext = path.extname(f);
        return SOURCE_EXTENSIONS.includes(ext) && isTestFileCheck(f);
    });
    // Convert to relative paths
    return files.map(f => path.relative(repoPath, f));
}


/**
 * Find files that have no corresponding test file
 */
export function findFilesWithoutTests(sourceFiles: string[], testFiles: string[]): string[] {
    const testPatterns = new Set<string>();

    // Build a set of base names that have tests
    for (const testFile of testFiles) {
        // Extract base name: foo.test.ts -> foo
        const baseName = path.basename(testFile)
            .replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '')
            .replace(/^test_/, '')
            .replace(/_test\.(py|go)$/, '');
        testPatterns.add(baseName.toLowerCase());
    }

    // Find source files without corresponding tests
    return sourceFiles.filter(sourceFile => {
        const baseName = path.basename(sourceFile)
            .replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '')
            .toLowerCase();

        // Skip index files, types, and configs
        if (['index', 'types', 'config', 'constants', 'utils'].includes(baseName)) {
            return false;
        }

        return !testPatterns.has(baseName);
    });
}

// ========== Baseline Scanner ==========

/**
 * Scan the entire codebase to establish a baseline
 */
export async function scanCodebaseBaseline(repoPath: string): Promise<BaselineScanResult> {
    console.log('📊 Scanning codebase for baseline analysis...\n');

    const issues: BaselineIssue[] = [];

    // 1. Discover files
    console.log('   🔍 Discovering files...');
    const sourceFiles = await findSourceFiles(repoPath);
    const testFiles = await findTestFiles(repoPath);
    console.log(`      Found ${sourceFiles.length} source files, ${testFiles.length} test files`);

    // 2. Find files without tests
    console.log('   🧪 Identifying files without tests...');
    const filesWithoutTests = findFilesWithoutTests(sourceFiles, testFiles);
    console.log(`      Found ${filesWithoutTests.length} files without tests`);

    for (const file of filesWithoutTests) {
        issues.push({
            type: 'no-test',
            file,
            message: `File has no corresponding test file`,
            severity: 'warning',
        });
    }

    // 3. Get coverage analysis
    console.log('   📈 Analyzing test coverage...');
    const coverage = getCoverageAnalysis(repoPath);

    const coverageByFile: Record<string, number> = {};
    const untestedFunctions: Array<{ file: string; name: string }> = [];

    if (coverage.hasReport) {
        console.log(`      Overall coverage: ${coverage.overall.lines.pct.toFixed(1)}%`);

        for (const fileCov of coverage.files) {
            coverageByFile[fileCov.path] = fileCov.metrics.lines.pct;

            // Flag low coverage files
            if (fileCov.metrics.lines.pct < 50) {
                issues.push({
                    type: 'low-coverage',
                    file: fileCov.path,
                    message: `Low test coverage: ${fileCov.metrics.lines.pct.toFixed(1)}%`,
                    severity: 'warning',
                });
            }

            // Track untested functions
            for (const funcName of fileCov.uncoveredFunctions) {
                untestedFunctions.push({ file: fileCov.path, name: funcName });
                issues.push({
                    type: 'untested-function',
                    file: fileCov.path,
                    functionName: funcName,
                    message: `Function '${funcName}' has no test coverage`,
                    severity: 'info',
                });
            }
        }
    } else {
        console.log('      No coverage report available');
    }

    // 4. Run ESLint static analysis
    console.log('   🔬 Running static analysis (ESLint)...');
    const staticAnalysis = await runEslintAnalysis(repoPath);

    if (staticAnalysis.hasResults) {
        console.log(`      Found ${staticAnalysis.summary.errors} errors, ${staticAnalysis.summary.warnings} warnings`);

        for (const issue of staticAnalysis.issues) {
            issues.push({
                type: issue.severity === 'error' ? 'eslint-error' : 'eslint-warning',
                file: issue.filePath,
                line: issue.line,
                message: issue.message,
                severity: issue.severity === 'error' ? 'error' : 'warning',
                ruleId: issue.ruleId,
            });
        }
    } else {
        console.log('      No ESLint issues found (or ESLint not configured)');
    }

    // 5. Build summary
    const summary = {
        totalSourceFiles: sourceFiles.length,
        totalTestFiles: testFiles.length,
        overallCoverage: coverage.hasReport ? coverage.overall.lines.pct : 0,
        filesWithoutTests: filesWithoutTests.length,
        eslintErrors: staticAnalysis.summary.errors,
        eslintWarnings: staticAnalysis.summary.warnings,
        totalIssues: issues.length,
    };

    console.log('\n✅ Baseline scan complete!');
    console.log(`   Total issues found: ${issues.length}`);

    return {
        coverage,
        staticAnalysis,
        testGaps: {
            filesWithoutTests,
            untestedFunctions,
            coverageByFile,
        },
        issues,
        summary,
        scannedAt: new Date().toISOString(),
    };
}

// ========== Test Suggestion Generation ==========

/**
 * Generate test suggestions for files without tests
 */
export async function generateBaselineTestSuggestions(
    repoPath: string,
    filesWithoutTests: string[],
    maxSuggestions: number = 10
): Promise<TestSuggestion[]> {
    const suggestions: TestSuggestion[] = [];
    const frameworkInfo = detectTestFramework(repoPath);

    for (const file of filesWithoutTests.slice(0, maxSuggestions)) {
        const fullPath = path.join(repoPath, file);

        if (!fs.existsSync(fullPath)) continue;

        try {
            const content = fs.readFileSync(fullPath, 'utf-8');

            // Extract function names
            const functionMatches = content.match(/(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(\w+)/g) || [];
            const functionNames = functionMatches
                .map(m => m.replace(/(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+/, ''))
                .filter(name => name.length > 2 && !['the', 'and', 'for', 'import', 'from'].includes(name))
                .slice(0, 5);

            if (functionNames.length === 0) continue;

            const testCode = generateTestTemplate(
                frameworkInfo.framework,
                file,
                content.substring(0, 2000), // First 2000 chars for context
                functionNames
            );

            suggestions.push({
                forFile: file,
                testFramework: frameworkInfo.framework,
                testCode,
                description: `Suggested tests for ${path.basename(file)} (${functionNames.length} functions)`,
                testFilePath: suggestTestFilePath(file, frameworkInfo.framework),
            });
        } catch (e) {
            // Skip files that can't be read
            continue;
        }
    }

    return suggestions;
}

// ========== Formatting ==========

/**
 * Format baseline scan result for CLI output
 */
export function formatBaselineReport(result: BaselineScanResult): string {
    const lines: string[] = [];

    lines.push('═'.repeat(60));
    lines.push('📊 CODEBASE BASELINE REPORT');
    lines.push('═'.repeat(60));
    lines.push('');

    // Summary section
    lines.push('📁 File Inventory');
    lines.push('─'.repeat(40));
    lines.push(`   Source files:     ${result.summary.totalSourceFiles}`);
    lines.push(`   Test files:       ${result.summary.totalTestFiles}`);
    lines.push(`   Files w/o tests:  ${result.summary.filesWithoutTests}`);
    lines.push('');

    // Coverage section
    lines.push('📈 Test Coverage');
    lines.push('─'.repeat(40));
    if (result.coverage.hasReport) {
        lines.push(`   Overall:   ${result.summary.overallCoverage.toFixed(1)}%`);
        lines.push(`   Lines:     ${result.coverage.overall.lines.pct.toFixed(1)}%`);
        lines.push(`   Branches:  ${result.coverage.overall.branches.pct.toFixed(1)}%`);
        lines.push(`   Functions: ${result.coverage.overall.functions.pct.toFixed(1)}%`);
    } else {
        lines.push('   No coverage report available');
        lines.push('   Run: npm test -- --coverage');
    }
    lines.push('');

    // Static analysis section
    lines.push('🔬 Static Analysis (ESLint)');
    lines.push('─'.repeat(40));
    lines.push(`   Errors:    ${result.summary.eslintErrors}`);
    lines.push(`   Warnings:  ${result.summary.eslintWarnings}`);
    lines.push('');

    // Issues breakdown
    const noTestIssues = result.issues.filter(i => i.type === 'no-test');
    const lowCovIssues = result.issues.filter(i => i.type === 'low-coverage');
    const eslintIssues = result.issues.filter(i => i.type.startsWith('eslint'));

    lines.push('📋 Issues Summary');
    lines.push('─'.repeat(40));
    lines.push(`   Files without tests:  ${noTestIssues.length}`);
    lines.push(`   Low coverage files:   ${lowCovIssues.length}`);
    lines.push(`   ESLint issues:        ${eslintIssues.length}`);
    lines.push(`   ─────────────────────────`);
    lines.push(`   Total issues:         ${result.summary.totalIssues}`);
    lines.push('');

    // Top files without tests
    if (noTestIssues.length > 0) {
        lines.push('🧪 Top Files Without Tests');
        lines.push('─'.repeat(40));
        for (const issue of noTestIssues.slice(0, 5)) {
            lines.push(`   • ${issue.file}`);
        }
        if (noTestIssues.length > 5) {
            lines.push(`   ... and ${noTestIssues.length - 5} more`);
        }
        lines.push('');
    }

    lines.push('═'.repeat(60));
    lines.push(`Scanned at: ${result.scannedAt}`);
    lines.push('');
    lines.push('💡 Run "pr-agent baseline --show" to view all issues');
    lines.push('💡 Run "pr-agent baseline --suggest-tests" for test suggestions');

    return lines.join('\n');
}

/**
 * Format issues list for CLI output
 */
export function formatBaselineIssues(issues: BaselineIssue[], filter?: string): string {
    const lines: string[] = [];

    let filteredIssues = issues;
    if (filter) {
        filteredIssues = issues.filter(i => i.type === filter || i.severity === filter);
    }

    lines.push(`📋 Baseline Issues (${filteredIssues.length} total)`);
    lines.push('═'.repeat(60));
    lines.push('');

    // Group by type
    const byType = new Map<string, BaselineIssue[]>();
    for (const issue of filteredIssues) {
        const key = issue.type;
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(issue);
    }

    for (const [type, typeIssues] of byType) {
        const icon = type === 'no-test' ? '🧪' :
            type === 'low-coverage' ? '📉' :
                type === 'eslint-error' ? '❌' :
                    type === 'eslint-warning' ? '⚠️' : '📝';

        lines.push(`${icon} ${type.replace('-', ' ').toUpperCase()} (${typeIssues.length})`);
        lines.push('─'.repeat(40));

        for (const issue of typeIssues.slice(0, 10)) {
            const loc = issue.line ? `:${issue.line}` : '';
            lines.push(`   ${issue.file}${loc}`);
            lines.push(`      ${issue.message}`);
        }

        if (typeIssues.length > 10) {
            lines.push(`   ... and ${typeIssues.length - 10} more`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
