export type RoundingRule = 'texas';

/**
 * Texas 8-minute rule:
 * - Full units = floor(minutes / 15)
 * - Remainder >= 8 → round up; < 8 → round down
 * - Minimum billable: 8 minutes = 1 unit; < 8 = 0
 */
export function calculateBillableUnits(
  durationMinutes: number,
  rule: RoundingRule = 'texas',
): number {
  if (durationMinutes < 0) return 0;
  const minutes = Math.floor(durationMinutes);
  if (rule === 'texas') {
    if (minutes < 8) return 0;
    const fullUnits = Math.floor(minutes / 15);
    const remainder = minutes % 15;
    return remainder >= 8 ? fullUnits + 1 : fullUnits;
  }
  return 0;
}
