import cronParser from 'cron-parser';

/** Returns true if `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) return false;
  try {
    cronParser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the next time the cron expression fires after `after`, evaluated in
 * the given IANA timezone. Throws if the expression is invalid.
 */
export function computeNextFireAt(expr: string, timezone: string, after: Date): Date {
  const it = cronParser.parseExpression(expr, {
    currentDate: after,
    tz: timezone,
  });
  return it.next().toDate();
}
