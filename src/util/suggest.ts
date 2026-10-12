/** The candidate closest to `input`, if it's close enough to be a plausible typo. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  if (input.length > 64) return undefined;
  const target = input.toLowerCase();
  const limit = Math.max(2, Math.floor(input.length / 3));
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower === target) return candidate;
    if (Math.abs(lower.length - target.length) > limit) continue;
    const d = editDistance(target, lower);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

/** Levenshtein distance, one row at a time. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}
