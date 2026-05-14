import { isIP } from "node:net";

export function containsIpLiteral(text) {
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(text)) return true;
  const candidates =
    text.match(/\[?(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.%]+\]?/gu) ?? [];
  return candidates.some((candidate) => {
    const unwrapped =
      candidate.startsWith("[") && candidate.endsWith("]")
        ? candidate.slice(1, -1)
        : candidate;
    const withoutZone = unwrapped.split("%", 1)[0] ?? unwrapped;
    return isIP(withoutZone) === 6;
  });
}

export function containsRawUserAgent(text) {
  return (
    /"(?:(?:raw[_-]?)?user[_-]?agent|User-Agent)"\s*:\s*"(?!\[REDACTED\])[^"]+"/iu.test(
      text,
    ) ||
    /\b(?:(?:raw[_-]?)?user[_-]?agent|User-Agent)\s*[:=]\s*(?:"(?!\[REDACTED\])[^"]+"|'(?!\[REDACTED\])[^']+'|[^\r\n,;&]+)/iu.test(
      text,
    ) ||
    /\b(?:Mozilla|Chrome|Chromium|Firefox|Safari|Edg|curl|PostmanRuntime)\/[0-9][^\s",;]*/iu.test(
      text,
    )
  );
}
