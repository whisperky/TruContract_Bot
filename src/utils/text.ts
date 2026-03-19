export function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function overlapScore(a: string[], b: string[]): number {
  const setB = new Set(b.map((item) => item.toLowerCase()));
  return a.reduce((score, item) => score + (setB.has(item.toLowerCase()) ? 1 : 0), 0);
}
