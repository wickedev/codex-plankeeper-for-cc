// Strict first-line contract, mirrored in prompts/plan-review.md. Anything
// that does not match counts as a judge error and feeds the circuit breaker.
export const VERDICT_KINDS = ["APPROVE", "REVISE"];

export function parseVerdict(lastMessage) {
  const firstLine = String(lastMessage).split(/\r?\n/, 1)[0].trim();
  for (const kind of VERDICT_KINDS) {
    if (firstLine.startsWith(`${kind}:`)) {
      // REVISE details usually run past the first line (numbered fixes), so
      // fall back to the whole message when the first line alone is empty —
      // and for REVISE always hand Claude the full text.
      const firstLineDetail = firstLine.slice(kind.length + 1).trim();
      const fullDetail = String(lastMessage).trim();
      return { kind, detail: kind === "REVISE" ? fullDetail.slice(kind.length + 1).trim() : firstLineDetail || fullDetail };
    }
  }
  return null;
}
