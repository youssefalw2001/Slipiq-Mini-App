export default function TierBadge({ tier }: { tier: 'S' | 'A' | 'B' | 'C' }) {
  return <span className={`tier tier-${tier}`}>{tier}-tier</span>;
}
