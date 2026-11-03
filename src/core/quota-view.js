const percent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;
export function quotaWindows(data) {
  const meters = (data?.meters ?? []).filter((row) =>
    percent(row.remainingPercent),
  );
  const short = meters.find(
    (row) =>
      row.windowMinutes === 300 ||
      /^(?:five_hour|five-hour|5h|session)$/.test(row.id),
  );
  const weekly = meters.find(
    (row) =>
      row.windowMinutes === 10080 ||
      /^(?:seven_day|seven-day|weekly_all|weekly|week|7d)$/.test(row.id),
  );
  return {
    short: short?.remainingPercent ?? null,
    weekly: weekly?.remainingPercent ?? null,
    text: `${short ? short.remainingPercent + "%" : "—"}/${weekly ? weekly.remainingPercent + "%" : "—"}`,
    available: !!short || !!weekly,
  };
}
