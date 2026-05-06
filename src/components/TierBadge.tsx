import type { ScoreTier, Tier } from '../types';

interface TierBadgeProps {
  tier: Tier | ScoreTier;
  label?: string;
}

export default function TierBadge({ tier, label }: TierBadgeProps) {
  return <span className={`tier-badge tier-${String(tier).toLowerCase()}`}>{label ?? `${tier}-TIER`}</span>;
}
