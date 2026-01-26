/**
 * Baseline Scanner Tool for First-Run Codebase Analysis
 * Scans entire codebase to establish a baseline for incremental PR analysis
 */
import { type CoverageAnalysis, type StaticAnalysis } from './coverage-analyzer.js';
import type { TestSuggestion } from '../types/agent.types.js';
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
        untestedFunctions: Array<{
            file: string;
            name: string;
        }>;
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
/**
 * Find all source files in the codebase
 */
export declare function findSourceFiles(repoPath: string): Promise<string[]>;
/**
 * Find all test files in the codebase
 */
export declare function findTestFiles(repoPath: string): Promise<string[]>;
/**
 * Find files that have no corresponding test file
 */
export declare function findFilesWithoutTests(sourceFiles: string[], testFiles: string[]): string[];
/**
 * Scan the entire codebase to establish a baseline
 */
export declare function scanCodebaseBaseline(repoPath: string): Promise<BaselineScanResult>;
/**
 * Generate test suggestions for files without tests
 */
export declare function generateBaselineTestSuggestions(repoPath: string, filesWithoutTests: string[], maxSuggestions?: number): Promise<TestSuggestion[]>;
/**
 * Format baseline scan result for CLI output
 */
export declare function formatBaselineReport(result: BaselineScanResult): string;
/**
 * Format issues list for CLI output
 */
export declare function formatBaselineIssues(issues: BaselineIssue[], filter?: string): string;
