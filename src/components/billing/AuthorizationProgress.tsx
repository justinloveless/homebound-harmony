interface Props {
  unitsUsed: number;
  unitsAuthorized: number;
  showLabel?: boolean;
}

export function AuthorizationProgress({ unitsUsed, unitsAuthorized, showLabel = true }: Props) {
  const pct = unitsAuthorized > 0 ? Math.min((unitsUsed / unitsAuthorized) * 100, 100) : 0;
  const overLimit = unitsUsed > unitsAuthorized;

  const barColor =
    overLimit || pct >= 100
      ? 'bg-red-500'
      : pct >= 80
        ? 'bg-amber-400'
        : 'bg-green-500';

  const textColor =
    overLimit || pct >= 100
      ? 'text-red-600'
      : pct >= 80
        ? 'text-amber-600'
        : 'text-muted-foreground';

  return (
    <div className="space-y-1">
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <p className={`text-xs ${textColor}`}>
          {unitsUsed} / {unitsAuthorized} units used
          {overLimit && ' (exceeded)'}
        </p>
      )}
    </div>
  );
}
