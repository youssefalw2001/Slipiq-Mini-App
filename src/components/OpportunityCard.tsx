import { Link } from 'react-router-dom';
import type { FirstSetOpportunity } from '../types';
import ProbabilityBar from './ProbabilityBar';
import TierBadge from './TierBadge';

interface OpportunityCardProps {
  opportunity: FirstSetOpportunity;
  onAddTopLeg: (matchId: string, score: string) => void;
}

function cardTier(opportunity: FirstSetOpportunity) {
  const bestMarket = opportunity.top.find((outcome) => outcome.bookmakerOdds);
  const odds = bestMarket?.bookmakerOdds ?? 0;
  if (odds >= 25) return 'S';
  if (odds >= 10) return 'A';
  if (odds >= 5) return 'B';
  return 'C';
}

export default function OpportunityCard({ opportunity, onAddTopLeg }: OpportunityCardProps) {
  const topMarket = opportunity.top.find((outcome) => outcome.bookmakerOdds);
  const tier = cardTier(opportunity);

  return (
    <article className={`opportunity-card tier-left-${tier.toLowerCase()}`}>
      <div className="card-header">
        <div>
          <p className="eyebrow">🎾 First Set Lab · {opportunity.surface}</p>
          <Link to={`/lab/${opportunity.id}`} className="match-link">
            {opportunity.player1} vs {opportunity.player2}
          </Link>
          <p className="muted">{opportunity.tournament}</p>
        </div>
        <TierBadge tier={tier} />
      </div>

      <div className="key-stat">
        Serve Dominance: <span className="mono">{(opportunity.hold1 * 100).toFixed(1)}%</span> hold vs{' '}
        <span className="mono">{(opportunity.hold2 * 100).toFixed(1)}%</span>
      </div>

      <div className="probability-stack">
        {opportunity.top.map((outcome) => (
          <ProbabilityBar
            key={outcome.score}
            label={outcome.score}
            probability={outcome.modelProbability}
            tier={outcome.classLabel.tier}
            meta={
              outcome.bookmakerOdds
                ? `Fair ×${outcome.fairOdds.toFixed(2)} · Book ×${outcome.bookmakerOdds.toFixed(2)} · Edge ${((outcome.edge ?? 0) * 100).toFixed(1)}%`
                : `Fair ×${outcome.fairOdds.toFixed(2)} · market odds unavailable`
            }
          />
        ))}
      </div>

      <div className="card-actions">
        <div className="chip mono">{topMarket ? `×${topMarket.bookmakerOdds?.toFixed(2)}` : 'No market odds'}</div>
        {opportunity.setfoxPassedCount > 0 ? (
          <span className="chip mono setfox-pass" title="At least one outcome passes SetFox Strict Mode (research-grade)">
            SetFox · {opportunity.setfoxPassedCount}
          </span>
        ) : (
          <span className="chip mono setfox-fail" title="No outcome on this match passes SetFox Strict Mode">
            SetFox · 0
          </span>
        )}
        <button
          className="button"
          type="button"
          disabled={!topMarket}
          onClick={() => topMarket && onAddTopLeg(opportunity.id, topMarket.score)}
        >
          + Add to Slip
        </button>
      </div>
    </article>
  );
}
