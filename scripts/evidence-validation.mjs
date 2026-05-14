const isoDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/u;

export function isIsoDateString(value) {
  const match = isoDateTimePattern.exec(value);
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText = "0",
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(millisecondText.padEnd(3, "0"));
  const offsetHour =
    typeof offsetHourText === "string" ? Number(offsetHourText) : 0;
  const offsetMinute =
    typeof offsetMinuteText === "string" ? Number(offsetMinuteText) : 0;

  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }

  const localDate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
  );
  return (
    !Number.isNaN(Date.parse(value)) &&
    localDate.getUTCFullYear() === year &&
    localDate.getUTCMonth() === month - 1 &&
    localDate.getUTCDate() === day &&
    localDate.getUTCHours() === hour &&
    localDate.getUTCMinutes() === minute &&
    localDate.getUTCSeconds() === second &&
    localDate.getUTCMilliseconds() === millisecond
  );
}

export function isFutureIsoDateString(
  value,
  nowMs = Date.now(),
  clockSkewMs = 5 * 60 * 1000,
) {
  return isIsoDateString(value) && Date.parse(value) > nowMs + clockSkewMs;
}
