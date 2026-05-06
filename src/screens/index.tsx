import { Link, useParams } from 'react-router-dom';
import LiveAlertBanner from '../components/LiveAlertBanner';
import OpportunityCard from '../components/OpportunityCard';
import ProbabilityBar from '../components/ProbabilityBar';
import ResponsibleNotice from '../components/ResponsibleNotice';
import SlipLegChip from '../components/SlipLegChip';
import TierBadge from '../components/TierBadge';
import nba from '../data/nbaGames.json';
import { legFromOutcome, opportunities } from '../lib/opportunities';
import { triggerHaptic } from '../lib/telegram';
import { useSlipStore, useSlipSummary } from '../store/slipStore';

function formatNullablePercent(value: number | null) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatNullableOdds(value: number | null) {
  return value === null ? 'N/A' : `×${value.toFixed(2)}`;
}

export function Home() {
  const addLeg = useSlipStore((state) => state.addLeg);

  const addTopLeg = (matchId: string, score: string) => {
    const leg = legFromOutcome(matchId, score);
    if (!leg) return;
    addLeg(leg);
    triggerHaptic('medium');
  };

  return (
    <main className="screen">
      <section className="hero">
        <p className="eyebrow">SlipIQ · First Set Lab</p>
        <h1>Today's Best Opportunities</h1>
        <p className="muted">Tennis first-set probability, fair odds, market comparison, and slip fit in one terminal-style feed.</p>
      </section>

      <LiveAlertBanner />

      <section className="section-stack">
        {opportunities.map((opportunity) => (
          <OpportunityCard key={opportunity.id} opportunity={opportunity} onAddTopLeg={addTopLeg} />
        ))}
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function FirstSetLab() {
  const { id } = useParams();
  const match = opportunities.find((item) => item.id === id);
  const addLeg = useSlipStore((state) => state.addLeg);

  if (!match) {
    return (
      <main className="screen">
        <h1>Opportunity not found</h1>
        <Link className="button" to="/">
          Back to Home
        </Link>
      </main>
    );
  }

  const addOutcome = (score: string) => {
    const leg = legFromOutcome(match.id, score);
    if (!leg) return;
    addLeg(leg);
    triggerHaptic('medium');
  };

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">🎾 Probability Deep Dive · {match.surface}</p>
        <h1>{match.player1} vs {match.player2}</h1>
        <p className="muted">{match.tournament} · Data freshness: seed model</p>
      </section>

      <section className="stat-grid card">
        <div>
          <p className="muted">{match.player1}</p>
          <strong className="mono">{(match.hold1 * 100).toFixed(1)}% hold</strong>
          <span>1st in {(match.player1Stats.fs1 * 100).toFixed(0)}%</span>
          <span>1st won {(match.player1Stats.w1s * 100).toFixed(0)}%</span>
          <span>2nd won {(match.player1Stats.w2s * 100).toFixed(0)}%</span>
          <span>BP save {(match.player1Stats.bpSave * 100).toFixed(0)}%</span>
        </div>
        <div>
          <p className="muted">{match.player2}</p>
          <strong className="mono">{(match.hold2 * 100).toFixed(1)}% hold</strong>
          <span>1st in {(match.player2Stats.fs1 * 100).toFixed(0)}%</span>
          <span>1st won {(match.player2Stats.w1s * 100).toFixed(0)}%</span>
          <span>2nd won {(match.player2Stats.w2s * 100).toFixed(0)}%</span>
          <span>BP save {(match.player2Stats.bpSave * 100).toFixed(0)}%</span>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>First-set score distribution</h2>
          <span className="muted">All modeled outcomes</span>
        </div>

        <div className="outcome-list">
          {match.outcomes.map((outcome) => (
            <article key={outcome.score} className="outcome-card">
              <div className="outcome-head">
                <div>
                  <strong className="mono">{outcome.score}</strong>
                  <p className="muted">{outcome.classLabel.label}</p>
                </div>
                <TierBadge tier={outcome.classLabel.tier} label={outcome.classLabel.label} />
              </div>
              <ProbabilityBar label="Model probability" probability={outcome.modelProbability} tier={outcome.classLabel.tier} />
              <div className="metric-grid">
                <span>Fair {formatNullableOdds(outcome.fairOdds)}</span>
                <span>Book {formatNullableOdds(outcome.bookmakerOdds)}</span>
                <span>Edge {formatNullablePercent(outcome.edge)}</span>
                <span>EV {formatNullablePercent(outcome.expectedValue)}</span>
              </div>
              <button className="button" type="button" disabled={!outcome.bookmakerOdds} onClick={() => addOutcome(outcome.score)}>
                {outcome.bookmakerOdds ? '+ Add to Slip' : 'Market odds unavailable'}
              </button>
            </article>
          ))}
        </div>
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function SlipBuilder() {
  const { legs, stake, setStake, removeLeg, addLeg, clear } = useSlipStore();
  const summary = useSlipSummary();

  const updateStake = (raw: string) => {
    const parsed = Number(raw);
    setStake(raw.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed);
  };

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Slip Builder</p>
        <h1>Build Your Slip</h1>
        <p className="muted">Add First Set Lab legs and supporting NBA legs, then watch probability, payout, EV, and tier update live.</p>
      </section>

      <section className="card">
        <label className="field-label" htmlFor="stake">
          Stake
        </label>
        <input id="stake" className="stake-input mono" value={stake || ''} inputMode="decimal" type="number" min="0" onChange={(event) => updateStake(event.target.value)} />
        <div className="quick-stakes">
          {[10, 15, 20, 25, 30].map((amount) => (
            <button key={amount} type="button" onClick={() => setStake(amount)}>
              ${amount}
            </button>
          ))}
        </div>
      </section>

      <section className="stats-bar">
        <div>
          <span>Combined Odds</span>
          <strong className="mono">×{summary.combinedOdds.toFixed(2)}</strong>
        </div>
        <div>
          <span>Hit Rate</span>
          <strong className="mono">{(summary.hitRate * 100).toFixed(2)}%</strong>
        </div>
        <div>
          <span>Payout</span>
          <strong className="mono">${summary.payout.toFixed(2)}</strong>
        </div>
        <div>
          <span>Tier</span>
          <TierBadge tier={summary.tier} />
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>Active Legs</h2>
          <button className="text-button" type="button" onClick={clear} disabled={legs.length === 0}>
            Clear
          </button>
        </div>
        {legs.length === 0 ? <p className="muted">No legs yet. Add a first-set outcome from Home or First Set Lab.</p> : null}
        <div className="leg-stack">
          {legs.map((leg) => (
            <SlipLegChip key={leg.id} leg={leg} onRemove={removeLeg} />
          ))}
        </div>
      </section>

      <section className="card suggestion-card">
        <h2>SlipIQ Notes</h2>
        <p>✅ EV is calculated from model probability × actual book odds, not from internally generated fair odds.</p>
        {legs.filter((leg) => leg.sport === 'tennis').length > 2 ? <p>⚠️ Several tennis legs are active. Watch same-match/correlation risk before saving.</p> : null}
        <p className="muted">Estimated days to hit: {summary.daysToHit ?? 'N/A'} · EV per $1: {summary.expectedValue.toFixed(3)}</p>
      </section>

      <section className="card">
        <h2>NBA support legs</h2>
        <div className="support-leg-grid">
          {(nba as Array<{ id: string; label: string; odds: number; modelProbability: number }>).map((game) => (
            <button
              key={game.id}
              className="support-leg"
              type="button"
              onClick={() => {
                addLeg({ id: game.id, label: game.label, sport: 'nba', odds: game.odds, modelProbability: game.modelProbability, eventId: game.id });
                triggerHaptic('light');
              }}
            >
              <span>{game.label}</span>
              <span className="mono">×{game.odds.toFixed(2)} · {(game.modelProbability * 100).toFixed(1)}%</span>
            </button>
          ))}
        </div>
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function Placeholder({ title }: { title: string }) {
  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">SlipIQ</p>
        <h1>{title}</h1>
        <p className="muted">This screen is staged for the next MVP pass.</p>
      </section>
      <ResponsibleNotice />
    </main>
  );
}
