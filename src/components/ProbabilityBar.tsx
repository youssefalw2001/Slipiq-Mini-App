import type { ScoreTier } from '../types';

interface ProbabilityBarProps {
  label: string;
  probability: number;
  tier?: ScoreTier;
  meta?: string;
}

export default function ProbabilityBar({ label, probability, tier = 'ORANGE', meta }: ProbabilityBarProps) {
  const pct = Math.max(0, Math.min(100, probability * 100));

  return (
    <div className="probability-row">
      <div className="probability-row__head">
        <span>{label}</span>
        <span className="mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="probability-track" aria-label={`${label} probability ${pct.toFixed(1)}%`}>
        <div className={`probability-fill score-${tier.toLowerCase()}`} style={{ width: `${pct}%` }} />
      </div>
      {meta ? <p className="probability-meta">{meta}</p> : null}
    </div>
  );
}
