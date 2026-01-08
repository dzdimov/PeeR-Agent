import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Get the directory where this module is located, then navigate to project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve DB path relative to the project root (from src/db or dist/db)
// This ensures the database is always in the same location regardless of cwd
function resolveDbPath(): string {
  // Try environment variable first
  if (process.env.PR_AGENT_DB_PATH) {
    return process.env.PR_AGENT_DB_PATH;
  }

  // Navigate up from src/db or dist/db to project root
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'pr-agent.db');
}

const DB_PATH = resolveDbPath();

export interface AnalysisRecord {
  id?: number;
  pr_number: number;
  repo_owner: string;
  repo_name: string;
  author: string;
  title: string;
  complexity: number;
  risks_count: number;
  risks: string; // JSON
  recommendations: string; // JSON
  timestamp: string;
}

let db: Database.Database;

export function getDB(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    initDB();
  }
  return db;
}

function initDB() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER,
      repo_owner TEXT,
      repo_name TEXT,
      author TEXT,
      title TEXT,
      complexity INTEGER,
      risks_count INTEGER,
      risks TEXT,
      recommendations TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function saveAnalysis(record: Omit<AnalysisRecord, 'id' | 'timestamp'> & { timestamp?: string }) {
  const db = getDB();
  
  if (record.timestamp) {
      const stmt = db.prepare(`
        INSERT INTO pr_analysis (
          pr_number, repo_owner, repo_name, author, title, 
          complexity, risks_count, risks, recommendations, timestamp
        ) VALUES (
          @pr_number, @repo_owner, @repo_name, @author, @title, 
          @complexity, @risks_count, @risks, @recommendations, @timestamp
        )
      `);
      stmt.run(record);
  } else {
      const stmt = db.prepare(`
        INSERT INTO pr_analysis (
          pr_number, repo_owner, repo_name, author, title, 
          complexity, risks_count, risks, recommendations
        ) VALUES (
          @pr_number, @repo_owner, @repo_name, @author, @title, 
          @complexity, @risks_count, @risks, @recommendations
        )
      `);
      stmt.run(record);
  }
}


export function getCommonRecommendations(limit = 5) {
  const db = getDB();
  const rows = db.prepare('SELECT recommendations FROM pr_analysis').all() as { recommendations: string }[];
  
  const frequency: Record<string, number> = {};
  
  rows.forEach(row => {
    try {
      const recs = JSON.parse(row.recommendations) as string[];
      recs.forEach(rec => {
        // Simple normalization: first 50 chars to group similar start phrases
        // In reality, this needs NLP clustering, but simple grouping works for identical strings
        const key = rec.trim();
        frequency[key] = (frequency[key] || 0) + 1;
      });
    } catch (e) {
      // ignore parse errors
    }
  });

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1]) // Descending order
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

export function getComplexityDistribution() {
  const db = getDB();
  // Group by complexity buckets
  const rows = db.prepare(`
    SELECT 
      CASE 
        WHEN complexity <= 2 THEN 'Low'
        WHEN complexity <= 4 THEN 'Medium'
        ELSE 'High'
      END as category,
      COUNT(*) as count
    FROM pr_analysis
    GROUP BY category
  `).all() as { category: string, count: number }[];
  
  const distribution = { Low: 0, Medium: 0, High: 0 };
  rows.forEach(r => {
    if (r.category === 'Low') distribution.Low = r.count;
    else if (r.category === 'Medium') distribution.Medium = r.count;
    else if (r.category === 'High') distribution.High = r.count;
  });
  
  return Object.values(distribution); // [Low, Medium, High]
}

export function getWeeklyQualityTrend() {
  const db = getDB();
  // SQLite doesn't have great date functions, so we'll group by YYYY-MM-DD and aggregate in JS or simple substr
  // Grouping by day for better granularity, frontend can aggregate to weeks if needed
  const rows = db.prepare(`
    SELECT 
      substr(timestamp, 1, 10) as date,
      AVG(complexity) as avg_complexity,
      COUNT(*) as count
    FROM pr_analysis 
    GROUP BY date
    ORDER BY date ASC
    LIMIT 30
  `).all() as { date: string, avg_complexity: number, count: number }[];
  
  return rows;
}

export function getDashboardStats() {
  const db = getDB();

  // Total PRs
  const totalPRs = db.prepare('SELECT COUNT(*) as count FROM pr_analysis').get() as { count: number };

  // "Successful" PRs (defined as complexity < 3 and 0 risks for this MVP)
  const successfulPRs = db.prepare('SELECT COUNT(*) as count FROM pr_analysis WHERE complexity < 3 AND risks_count = 0').get() as { count: number };

  // Average Complexity
  const avgComplexity = db.prepare('SELECT AVG(complexity) as avg FROM pr_analysis').get() as { avg: number };

  // Stats per Creator
  const perCreator = db.prepare(`
    SELECT author, COUNT(*) as count, AVG(complexity) as avg_complexity
    FROM pr_analysis
    GROUP BY author
    ORDER BY count DESC
    LIMIT 10
  `).all();
  
  const commonRecommendations = getCommonRecommendations(5);
  const complexityDistribution = getComplexityDistribution();
  const qualityTrend = getWeeklyQualityTrend();

  // ROI Calculation assumptions: 
  // 1. Avg PR takes 30 mins to review manually.
  // 2. AI saves 15 mins (0.25 hours) per PR by catching trivial issues/risks early.
  // 3. Dev cost $60/hr. -> $15 saved per PR.
  const hoursSaved = totalPRs.count * 0.25;
  const moneySaved = hoursSaved * 60;

  return {
    totalPRs: totalPRs.count,
    successRate: totalPRs.count > 0 ? (successfulPRs.count / totalPRs.count) * 100 : 0,
    avgComplexity: avgComplexity.avg || 0,
    perCreator,
    commonRecommendations,
    complexityDistribution,
    qualityTrend,
    roi: {
        hoursSaved,
        moneySaved
    }
  };
}

export function getRecentAnalyses(limit = 10) {
  const db = getDB();
  return db.prepare('SELECT * FROM pr_analysis ORDER BY timestamp DESC LIMIT ?').all(limit);
}
