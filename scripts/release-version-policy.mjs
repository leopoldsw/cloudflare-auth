export function isPrivateAlpha(version) {
  if (typeof version !== "string") return false;
  return /^\d+\.\d+\.\d+-alpha[.-].+$/u.test(version);
}

export function isPublicBeta(version) {
  if (typeof version !== "string") return false;
  return /^\d+\.\d+\.\d+-beta[.-].+$/u.test(version);
}

export function isStableOneOrLater(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u);
  if (!match || version.includes("-")) return false;
  return Number(match[1]) >= 1;
}

export function isSupportedReleaseVersion(version) {
  return (
    isPrivateAlpha(version) ||
    isPublicBeta(version) ||
    isStableOneOrLater(version)
  );
}

export function isBetaPackageTag(value) {
  return value === "beta" || isPublicBeta(value);
}

export function isPublishedReleaseVersion(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u);
  if (!match) return false;
  return version !== "0.0.0";
}

export function isPlaceholderPrerelease(version) {
  return typeof version === "string" && /^0\.0\.0-.+/u.test(version);
}

export function isPlaceholderReleaseVersion(version) {
  return typeof version === "string" && /^0\.0\.0(?:-.+)?$/u.test(version);
}
