/** Format a "HH:MM" 24h time string to the user's locale format */
export function formatTime(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const date = new Date(2000, 0, 1, h, m);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
