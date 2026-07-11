import { isIP } from "node:net";

const secretAssignmentPattern =
  /["']?\b(?:AUTH_SECRET|AUTH_SECRET_PREVIOUS|TURNSTILE_SECRET_KEY)\b["']?\s*[:=]\s*(?!["']?\[REDACTED(?:_[A-Z]+)?\]["']?)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,\r\n,;&]+)/iu;
const authRootSecretPattern = /\b[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}\b/u;
const sensitiveTokenNamePattern =
  /\b(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|NODE_AUTH_TOKEN|NPM_TOKEN)\b/iu;
const npmTokenPattern = /\b_authToken\b|\bnpm_[A-Za-z0-9]{20,}\b/u;
const authorizationBearerPattern =
  /["']?\bAuthorization\b["']?\s*[:=]\s*(?:"Bearer\s+(?!\[REDACTED\])[^"\r\n]{12,}"|'Bearer\s+(?!\[REDACTED\])[^'\r\n]{12,}'|Bearer\s+(?!\[REDACTED\])\S{12,})/iu;

export function containsRawSecretMaterial(text) {
  return (
    secretAssignmentPattern.test(text) ||
    authRootSecretPattern.test(text) ||
    sensitiveTokenNamePattern.test(text) ||
    npmTokenPattern.test(text) ||
    authorizationBearerPattern.test(text)
  );
}

export function containsSensitiveEvidence(text) {
  return (
    containsRawSecretMaterial(text) ||
    /\bcfauth\.(?:ses|magic|verify|reset)\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{20,}/u.test(
      text,
    ) ||
    /\b(?:__Host-|__Secure-)?cfauth-session=/u.test(text) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text) ||
    containsIpLiteral(text) ||
    containsRawUserAgent(text)
  );
}

export function containsSensitiveEvidenceValue(value) {
  if (typeof value === "string") return containsSensitiveEvidence(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveEvidenceValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        containsSensitiveEvidence(key) || containsSensitiveEvidenceValue(item),
    );
  }
  return false;
}

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
