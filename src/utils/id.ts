export function formatExternalId(prefix: string, sequence: number): string {
  return `${prefix}-${sequence.toString().padStart(4, "0")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
