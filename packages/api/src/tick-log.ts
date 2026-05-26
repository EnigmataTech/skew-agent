// Ring buffer for tick runner log output.
const MAX_LINES = 1000;
const lines: string[] = [];

export function appendLog(...args: unknown[]) {
  const line = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function getLog(n = 200): string[] {
  return lines.slice(-n);
}

export function clearLog() {
  lines.length = 0;
}
