import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { env } from "./env";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS markets (
  id           TEXT PRIMARY KEY,           -- venue:venueMarketId
  venue        TEXT NOT NULL,              -- 'polymarket' | 'kalshi'
  venue_id     TEXT NOT NULL,
  question     TEXT NOT NULL,
  category     TEXT,                       -- our normalized tag, e.g. 'btc-price'
  closes_at    INTEGER,                    -- unix seconds
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0, -- 0/1
  resolved_as  TEXT,                       -- 'yes' | 'no' | 'void'
  resolved_at  INTEGER,
  raw_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_markets_venue_open ON markets(venue, resolved, closes_at);

CREATE TABLE IF NOT EXISTS snapshots (
  market_id     TEXT NOT NULL,
  outcome       TEXT NOT NULL,             -- 'yes' | 'no' (or outcome name)
  captured_at   INTEGER NOT NULL,
  implied_prob  REAL NOT NULL,             -- 0..1
  bid_prob      REAL,
  ask_prob      REAL,
  volume_24h    REAL,
  liquidity     REAL,
  PRIMARY KEY (market_id, outcome, captured_at),
  FOREIGN KEY (market_id) REFERENCES markets(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(captured_at);

CREATE TABLE IF NOT EXISTS cross_venue_matches (
  poly_market_id   TEXT NOT NULL,
  kalshi_market_id TEXT NOT NULL,
  confidence       REAL NOT NULL,          -- 0..1 from LLM judge
  judged_at        INTEGER NOT NULL,
  rationale        TEXT,
  PRIMARY KEY (poly_market_id, kalshi_market_id)
);

CREATE TABLE IF NOT EXISTS calls (
  call_id          TEXT PRIMARY KEY,
  venue            TEXT NOT NULL,
  market_id        TEXT NOT NULL,
  side             TEXT NOT NULL,          -- 'yes' | 'no'
  model_prob       REAL NOT NULL,
  market_prob      REAL NOT NULL,
  edge_bps         INTEGER NOT NULL,
  size_usdc        REAL NOT NULL,
  reasoning        TEXT NOT NULL,
  published_at     INTEGER NOT NULL,
  attestation_tx   TEXT,
  resolved_pnl_bps INTEGER,
  resolved_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_published ON calls(published_at DESC);
`;

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  const path = env.dbPath();
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec(SCHEMA);
  return _db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
