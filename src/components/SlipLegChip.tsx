import type { SlipLeg } from '../types';

interface SlipLegChipProps {
  leg: SlipLeg;
  onRemove?: (id: string) => void;
}

export default function SlipLegChip({ leg, onRemove }: SlipLegChipProps) {
  const icon = leg.sport === 'tennis' ? '🎾' : '🏀';

  return (
    <div className="slip-leg-chip">
      <span>{icon}</span>
      <span className="slip-leg-chip__label">{leg.label}</span>
      <span className="mono">×{leg.odds.toFixed(2)}</span>
      <span className="mono">{(leg.modelProbability * 100).toFixed(1)}%</span>
      {onRemove ? (
        <button className="chip-remove" type="button" onClick={() => onRemove(leg.id)} aria-label={`Remove ${leg.label}`}>
          ×
        </button>
      ) : null}
    </div>
  );
}
