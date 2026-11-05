const PATTERNS = [
  /\bAuthorization\s*[:=]\s*["\']?\s*(?:Bearer|Basic)\s+[A-Za-z0-9_+./=-]{12,}/gi,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_.-]{16,}|GOCSPX-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
  /\b(?:sbp_|sb_secret_)[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`]+:[^\s'"`]+@[^\s'"`]+/gi,
  /\b(?:[A-Z0-9]+[_-])*(?:api[_-]?key|client[_-]?secret|secret[_-]?key|(?:access|refresh|oauth|id)[_-]?token|password)\s*[:=]\s*(?:["'][^"'\r\n]{12,}["']|[A-Za-z0-9_+./=-]{16,})/gi,
];
export function redact(value) {
  return PATTERNS.reduce((text, pattern) => text.replace(pattern, "[보호된 비밀값]"), value);
}
export function secretFinding(content) {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    pattern.lastIndex = 0;
    if (match) return content.slice(0, match.index).split("\n").length;
  }
  return null;
}
export function redactData(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactData(item)]));
  return value;
}
export function providerSnapshot(snapshot) {
  return { ...snapshot, files: snapshot.files.map((file) => ({ ...file, content: redact(file.content) })) };
}
