// Parse market metadata from each venue into a canonical strike tuple
// that lets us match identical (asset, operator, strike, expiry) markets
// across Polymarket and Kalshi.

export type Op = "gte" | "lte" | "range";
export type Asset = "BTC" | "ETH";

export interface CanonicalStrike {
  asset: Asset;
  op: Op;
  strike: number;          // for "range" this is the lower bound
  strikeUpper?: number;    // present only for "range"
  expiryUnix: number;      // unix seconds
}

// "150k" → 150000, "1.5M" → 1500000, "76,000" → 76000
function parseNum(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
  if (!m) return null;
  const base = parseFloat(m[1]!);
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  return base;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// "May 13" / "December 31, 2026" / "Dec 31 2026" → unix seconds at 23:59:59 UTC
function parseExpiry(s: string, currentYear: number): number | null {
  const m = s.match(/(?:by |on )?([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase()];
  if (mo === undefined) return null;
  const day = parseInt(m[2]!);
  const year = m[3] ? parseInt(m[3]) : currentYear;
  return Math.floor(Date.UTC(year, mo, day, 23, 59, 59) / 1000);
}

// "in May" / "in June 2026" — treat as end-of-month
function parseMonthEnd(s: string, currentYear: number): number | null {
  const m = s.match(/in\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase()];
  if (mo === undefined) return null;
  const year = m[2] ? parseInt(m[2]) : currentYear;
  const lastDay = new Date(Date.UTC(year, mo + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(year, mo, lastDay, 23, 59, 59) / 1000);
}

const ASSET_PATTERNS: { re: RegExp; asset: Asset }[] = [
  { re: /\b(bitcoin|btc)\b/i, asset: "BTC" },
  { re: /\b(ethereum|eth)\b/i, asset: "ETH" },
];

function findAsset(q: string): Asset | null {
  for (const { re, asset } of ASSET_PATTERNS) if (re.test(q)) return asset;
  return null;
}

// Parse a Polymarket question into a canonical strike, when possible.
export function parsePolymarket(question: string, closesAt: number | null): CanonicalStrike | null {
  const asset = findAsset(question);
  if (!asset) return null;
  const refYear = closesAt
    ? new Date(closesAt * 1000).getUTCFullYear()
    : new Date().getUTCFullYear();

  // Range form: "between $74,000 and $76,000 on May 14"
  const rng = question.match(/between\s+\$([\d,.]+[kKmM]?)\s+and\s+\$([\d,.]+[kKmM]?)/i);
  if (rng) {
    const lo = parseNum(rng[1]!);
    const hi = parseNum(rng[2]!);
    if (lo == null || hi == null) return null;
    const exp = closesAt ?? parseExpiry(question, refYear) ?? parseMonthEnd(question, refYear);
    if (exp == null) return null;
    return { asset, op: "range", strike: lo, strikeUpper: hi, expiryUnix: exp };
  }

  // Threshold form. "above" / "reach" / "hit" / "greater than" / "at or above" → gte.
  // "dip to" / "below" / "less than" / "fall to" → lte.
  let op: Op | null = null;
  if (/\b(above|reach|hit|greater than|over|at or above|exceed)\b/i.test(question)) op = "gte";
  else if (/\b(below|dip to|less than|under|fall to|drop to)\b/i.test(question)) op = "lte";
  if (!op) return null;

  const strikeMatch = question.match(/\$\s*([\d,.]+[kKmM]?)/);
  if (!strikeMatch) return null;
  const strike = parseNum(strikeMatch[1]!);
  if (strike == null) return null;

  const exp = closesAt ?? parseExpiry(question, refYear) ?? parseMonthEnd(question, refYear);
  if (exp == null) return null;

  return { asset, op, strike, expiryUnix: exp };
}

// Map Kalshi's typed fields to the canonical tuple.
export function parseKalshi(raw: {
  title?: string;
  floor_strike?: number;
  cap_strike?: number;
  strike_type?: string;
  expiration_time?: string;
  close_time?: string;
}): CanonicalStrike | null {
  const asset = raw.title ? findAsset(raw.title) : null;
  if (!asset) return null;
  const expIso = raw.expiration_time ?? raw.close_time;
  if (!expIso) return null;
  const expiryUnix = Math.floor(new Date(expIso).getTime() / 1000);
  if (!Number.isFinite(expiryUnix)) return null;

  const st = raw.strike_type;
  if (st === "between" || st === "floor_and_cap") {
    if (raw.floor_strike == null || raw.cap_strike == null) return null;
    return { asset, op: "range", strike: raw.floor_strike, strikeUpper: raw.cap_strike, expiryUnix };
  }
  if (raw.floor_strike != null && (st === "greater_or_equal" || st === "greater")) {
    return { asset, op: "gte", strike: raw.floor_strike, expiryUnix };
  }
  if (raw.cap_strike != null && (st === "less_or_equal" || st === "less")) {
    return { asset, op: "lte", strike: raw.cap_strike, expiryUnix };
  }
  // Fall-back: just a floor strike with no explicit type → treat as gte
  if (raw.floor_strike != null) {
    return { asset, op: "gte", strike: raw.floor_strike, expiryUnix };
  }
  return null;
}
