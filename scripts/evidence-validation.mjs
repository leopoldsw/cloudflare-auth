const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function isIsoDateString(value) {
  return isoDateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}
