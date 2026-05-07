import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import IQRebuildCard from '../components/IQRebuildCard';
import LiveAlertBanner from '../components/LiveAlertBanner';
import OpportunityCard from '../components/OpportunityCard';
import ProbabilityBar from '../components/ProbabilityBar';
import ResponsibleNotice from '../components/ResponsibleNotice';
import SlipLegChip from '../components/SlipLegChip';
import TierBadge from '../components/TierBadge';
import nba from '../data/nbaGames.json';
import { fetchLiveOpportunities } from '../lib/liveData';
import { legFromOutcome, opportunities as seedOpportunities } from '../lib/opportunities';
import { setfoxConfidenceBadge, setfoxManifest, explainSetFox } from '../lib/setfoxExplain';
import { classifyOddsBucket, classifyScoreFamily } from '../lib/setfoxStrategy';
import { fetchSavedSlips, saveSlipToSupabase, type SavedSlip } from '../lib/slipsData';
import { triggerHaptic } from '../lib/telegram';
import { useSlipStore, useSlipSummary } from '../store/slipStore';
import type { FirstSetOpportunity, ScannerStats } from '../types';

const historyData = [
  { day: 'Mon', value: 18 },
  { day: 'Tue', value: 42 },
  { day: 'Wed', value: 31 },
  { day: 'Thu', value: 77 },
  { day: 'Fri', value: 58 },
  { day: 'Sat', value: 96 },
  { day: 'Sun', value: 124 },
];

const alertCards = [
  { icon: '🔔', title: 'A-TIER WINDOW OPEN', body: 'A combination crossed the configured opportunity threshold.', enabled: true },
  { icon: '⚡', title: 'VALUE LEG DETECTED', body: 'Market price is meaningfully different from model probability.', enabled: true },
  { icon: '📊', title: 'NEW MATCH DATA', body: 'Serve and hold inputs were refreshed for an upcoming match.', enabled: false },
  { icon: '🎯', title: 'YOUR SLIP ALERT', body: 'One of your saved legs changed status.', enabled: true },
  { icon: '💎', title: 'S-TIER ALERT', body: 'Rare high-upside windows. Limited to a small number per week.', enabled: false },
];

const onboardingSlides = [
  { title: 'Your slips. Supercharged.', body: 'Turn first-set tennis probability into a clearer view of risk, payout, and parlay fit.' },
  { title: 'Real math. Not guesses.', body: 'First Set Lab models hold strength, set-score outcomes, fair odds, market odds, and edge.' },
  { title: 'Never miss a window.', body: 'Alerts and saved slips will help you monitor the opportunities you care about most.' },
];

function formatNullablePercent(value: number | null) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatNullableOdds(value: number | null) {
  return value === null ? 'N/A' : `×${value.toFixed(2)}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function MiniTrendChart() {
  const max = Math.max(...historyData.map((item) => item.value));
  return (
    <div className="mini-chart" aria-label="7-day learning curve chart">
      {historyData.map((item) => (
        <div key={item.day} className="mini-chart__bar-wrap">
          <div className="mini-chart__bar" style={{ height: `${Math.max(10, (item.value / max) * 100)}%` }} />
          <span>{item.day}</span>
        </div>
      ))}
    </div>
  );
}

function useOpportunityFeed() {
  const [feed, setFeed] = useState<FirstSetOpportunity[]>(seedOpportunities);
  const [source, setSource] = useState<'seed' | 'live'>('seed');
  const [scanner, setScanner] = useState<ScannerStats | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchLiveOpportunities()
      .then((live) => {
        if (!cancelled && live) {
          setFeed(live.opportunities);
          setSource('live');
          setScanner(live.scanner);
        }
      })
      .catch((error) => {
        console.warn('SlipIQ live data unavailable, using seed feed.', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { feed, source, scanner };
}

function deriveScannerStats(feed: FirstSetOpportunity[]): ScannerStats {
  let totalScanned = 0;
  let passed = 0;
  let tiebreakBlocked = 0;
  for (const opp of feed) {
    for (const outcome of opp.outcomes) {
      totalScanned += 1;
      if (outcome.setfox.passed) passed += 1;
      if (outcome.setfox.rejections.includes('tiebreak_blocked')) tiebreakBlocked += 1;
    }
  }
  return {
    ruleVersion: feed[0]?.outcomes[0]?.setfox.ruleVersion ?? 'setfox.v3.research.itf-normal-12to18',
    totalScanned,
    passed,
    rejected: totalScanned - passed,
    tiebreakBlocked,
    capturedAt: null,
  };
}

function ScannerCard({ stats, source }: { stats: ScannerStats; source: 'seed' | 'live' }) {
  const badge = setfoxConfidenceBadge();
  const manifest = setfoxManifest();
  return (
    <article className="card scanner-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">SetFox Scanner · {source === 'live' ? 'Live' : 'Seed'}</p>
          <h2>{stats.passed} passed · {stats.rejected} rejected</h2>
        </div>
        <span className={`chip mono setfox-confidence-${badge.tone}`}>{badge.label}</span>
      </div>
      <div className="stats-bar compact">
        <div>
          <span>Scanned</span>
          <strong className="mono">{stats.totalScanned}</strong>
        </div>
        <div>
          <span>SetFox Pass</span>
          <strong className="mono">{stats.passed}</strong>
        </div>
        <div>
          <span>Tiebreak Blocks</span>
          <strong className="mono">{stats.tiebreakBlocked}</strong>
        </div>
        <div>
          <span>Reject Rate</span>
          <strong className="mono">
            {stats.totalScanned > 0 ? `${Math.round((stats.rejected / stats.totalScanned) * 100)}%` : '0%'}
          </strong>
        </div>
      </div>
      <ul className="setfox-manifest muted">
        {manifest.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="muted small">
        SetFox rules are research-grade. Forward-test results need to confirm them before any premium claims.
      </p>
    </article>
  );
}

function DataStatusBadge({ source, count }: { source: 'seed' | 'live'; count: number }) {
  const isLive = source === 'live';

  return (
    <div className={`data-status-badge ${isLive ? 'is-live' : 'is-seed'}`}>
      <div>
        <span className="mono">{isLive ? 'LIVE DATA CONNECTED' : 'SEED MODE'}</span>
        <p>{isLive ? 'Supabase model feed active' : 'Backup local feed active until refresh returns rows'}</p>
      </div>
      <strong className="mono">{count}</strong>
    </div>
  );
}

function SavedSlipCard({ slip }: { slip: SavedSlip }) {
  return (
    <article className="card saved-slip-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">Saved · {formatDateTime(slip.created_at)}</p>
          <h2>{slip.legs.length} legs · ${Number(slip.stake).toFixed(2)} stake</h2>
        </div>
        <TierBadge tier={slip.tier} />
      </div>
      <div className="stats-bar compact">
        <div>
          <span>Odds</span>
          <strong className="mono">×{Number(slip.combined_odds).toFixed(2)}</strong>
        </div>
        <div>
          <span>Hit Rate</span>
          <strong className="mono">{(Number(slip.hit_rate) * 100).toFixed(2)}%</strong>
        </div>
        <div>
          <span>EV/$1</span>
          <strong className="mono">{Number(slip.expected_value).toFixed(3)}</strong>
        </div>
      </div>
      <div className="leg-stack">
        {slip.legs.map((leg) => (
          <SlipLegChip key={`${slip.id}-${leg.id}`} leg={leg} />
        ))}
      </div>
    </article>
  );
}

export function Home() {
  const { feed, source, scanner } = useOpportunityFeed();
  const addLeg = useSlipStore((state) => state.addLeg);
  const scannerStats = scanner ?? deriveScannerStats(feed);

  const addTopLeg = (matchId: string, score: string) => {
    const liveMatch = feed.find((opportunity) => opportunity.id === matchId);
    const liveOutcome = liveMatch?.outcomes.find((outcome) => outcome.score === score && outcome.bookmakerOdds);
    const leg = liveOutcome?.bookmakerOdds
      ? {
          id: `${matchId}-${score}`,
          label: `${liveMatch?.player1} vs ${liveMatch?.player2} ${score}`,
          sport: 'tennis' as const,
          odds: liveOutcome.bookmakerOdds,
          modelProbability: liveOutcome.modelProbability,
          eventId: matchId,
          setfoxPassed: liveOutcome.setfox.passed,
          setfoxRuleVersion: liveOutcome.setfox.ruleVersion,
        }
      : legFromOutcome(matchId, score);

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

      <DataStatusBadge source={source} count={feed.length} />
      <ScannerCard stats={scannerStats} source={source} />
      <LiveAlertBanner />
      <IQRebuildCard compact />

      <section className="section-stack" id="opportunities">
        {feed.map((opportunity) => (
          <OpportunityCard key={opportunity.id} opportunity={opportunity} onAddTopLeg={addTopLeg} />
        ))}
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function FirstSetLab() {
  const { id } = useParams();
  const match = seedOpportunities.find((item) => item.id === id);
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
          {match.outcomes.map((outcome) => {
            const explanation = explainSetFox(
              {
                score: outcome.score,
                modelProbability: outcome.modelProbability,
                bookmakerOdds: outcome.bookmakerOdds,
                edge: outcome.edge,
                expectedValue: outcome.expectedValue,
                scoreFamily: classifyScoreFamily(outcome.score),
                oddsBucket: outcome.bookmakerOdds ? classifyOddsBucket(outcome.bookmakerOdds) : 'odds_30_plus',
                tournamentLevel: match.tournamentLevel ?? 'tour_other',
                matchType: match.matchType ?? 'singles',
              },
              outcome.setfox,
            );
            return (
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
                <p className={`muted small ${outcome.setfox.passed ? 'setfox-pass-line' : 'setfox-fail-line'}`}>
                  {explanation}
                </p>
                <button className="button" type="button" disabled={!outcome.bookmakerOdds} onClick={() => addOutcome(outcome.score)}>
                  {outcome.bookmakerOdds ? '+ Add to Slip' : 'Market odds unavailable'}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function SlipBuilder() {
  const { legs, stake, setStake, removeLeg, addLeg, clear } = useSlipStore();
  const summary = useSlipSummary();
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveMessage, setSaveMessage] = useState('');

  const updateStake = (raw: string) => {
    const parsed = Number(raw);
    setStake(raw.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed);
  };

  const saveSlip = async () => {
    if (legs.length === 0 || saveState === 'saving') return;
    setSaveState('saving');
    setSaveMessage('');

    try {
      await saveSlipToSupabase({ legs, stake, summary });
      setSaveState('saved');
      setSaveMessage('Saved to My Slips.');
      triggerHaptic('medium');
    } catch (error) {
      setSaveState('error');
      setSaveMessage(error instanceof Error ? error.message : 'Could not save slip.');
    }
  };

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Slip Builder</p>
        <h1>Build Your Slip</h1>
        <p className="muted">Add First Set Lab legs and supporting NBA legs, then watch probability, payout, EV, and tier update live.</p>
      </section>

      <IQRebuildCard />

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
        <button className="button button-gold" type="button" disabled={legs.length === 0 || saveState === 'saving'} onClick={saveSlip}>
          {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : 'Save Slip'}
        </button>
        {saveMessage ? <p className={saveState === 'error' ? 'error-text' : 'success-text'}>{saveMessage}</p> : null}
      </section>

      <section className="card suggestion-card">
        <h2>SetFox Notes</h2>
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

export function MySlips() {
  const { legs, stake } = useSlipStore();
  const summary = useSlipSummary();
  const [savedSlips, setSavedSlips] = useState<SavedSlip[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const activeCount = savedSlips.length + (legs.length > 0 ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchSavedSlips()
      .then((slips) => {
        if (!cancelled) {
          setSavedSlips(slips);
          setLoadError('');
        }
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load saved slips.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Tracker & History</p>
        <h1>My Slips</h1>
        <p className="muted">Track saved slips from Supabase. Live result sync comes later with match resolution data.</p>
      </section>

      <section className="stats-bar">
        <div>
          <span>Active</span>
          <strong className="mono">{activeCount}</strong>
        </div>
        <div>
          <span>Current Stake</span>
          <strong className="mono">${stake.toFixed(2)}</strong>
        </div>
        <div>
          <span>Projected Return</span>
          <strong className="mono">${summary.payout.toFixed(2)}</strong>
        </div>
        <div>
          <span>Tier</span>
          <TierBadge tier={summary.tier} />
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>Current Builder Slip</h2>
          <span className="muted">Unsaved working slip</span>
        </div>
        {legs.length === 0 ? <p className="muted">No active builder slip. Build one from the Home feed, save it, then return here.</p> : null}
        <div className="leg-stack">
          {legs.map((leg) => (
            <SlipLegChip key={leg.id} leg={leg} />
          ))}
        </div>
      </section>

      <section className="section-stack">
        <div className="section-title">
          <h2>Saved Slips</h2>
          <span className="muted">Supabase history</span>
        </div>
        {loading ? <p className="muted">Loading saved slips...</p> : null}
        {loadError ? <p className="error-text">{loadError}</p> : null}
        {!loading && !loadError && savedSlips.length === 0 ? <p className="muted">No saved slips yet. Save one from Builder.</p> : null}
        {savedSlips.map((slip) => (
          <SavedSlipCard key={slip.id} slip={slip} />
        ))}
      </section>

      <section className="card chart-card">
        <div className="section-title">
          <h2>7-day learning curve</h2>
          <span className="muted">Mock P&L preview</span>
        </div>
        <MiniTrendChart />
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function Alerts() {
  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Don't Miss A Window</p>
        <h1>Alerts</h1>
        <p className="muted">Configure which model events should become Telegram notifications once backend automation is connected.</p>
      </section>

      <div className="section-stack">
        {alertCards.map((alert) => (
          <article key={alert.title} className="alert-card card">
            <div>
              <p className="eyebrow">{alert.icon} {alert.title}</p>
              <p className="muted">{alert.body}</p>
            </div>
            <span className={`toggle-pill ${alert.enabled ? 'is-on' : ''}`}>{alert.enabled ? 'ON' : 'OFF'}</span>
          </article>
        ))}
      </div>

      <section className="card suggestion-card">
        <h2>Automation plan</h2>
        <p>Next backend pass will run combinations on a schedule, store alert state, and send Telegram Bot notifications to eligible users.</p>
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function Profile() {
  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Profile + Premium</p>
        <h1>Upgrade your lab</h1>
        <p className="muted">Feature gates are staged here now. Telegram identity, Stars invoices, and Supabase subscriptions come next.</p>
      </section>

      <section className="pricing-grid">
        <article className="pricing-card card">
          <p className="eyebrow">Free</p>
          <h2>Starter</h2>
          <strong className="mono">3 analyses/day</strong>
          <p className="muted">1 saved slip, B-tier suggestions, and watermarked sharing.</p>
        </article>
        <article className="pricing-card card is-featured">
          <p className="eyebrow">Premium</p>
          <h2>$9.99/mo</h2>
          <strong className="mono">≈ 500 Stars</strong>
          <p className="muted">Unlimited analyses, alerts, 30-day history, exports, and EDGE indicators.</p>
        </article>
        <article className="pricing-card card">
          <p className="eyebrow">VIP</p>
          <h2>$29.99/mo</h2>
          <strong className="mono">≈ 1,500 Stars</strong>
          <p className="muted">Early alerts, weekly report, channel access, and monthly simulations.</p>
        </article>
      </section>

      <section className="card referral-card">
        <h2>Referral engine</h2>
        <p className="muted">Invite 3 friends who install SlipIQ to unlock 1 month Premium. Tracking will use Telegram IDs after backend setup.</p>
      </section>

      <ResponsibleNotice />
    </main>
  );
}

export function Onboarding() {
  return (
    <main className="screen onboarding-screen">
      <section className="detail-header">
        <p className="eyebrow">Welcome to SlipIQ</p>
        <h1>Don't guess. Calculate.</h1>
      </section>

      <div className="section-stack">
        {onboardingSlides.map((slide, index) => (
          <article key={slide.title} className="onboarding-card card">
            <span className="slide-number mono">0{index + 1}</span>
            <h2>{slide.title}</h2>
            <p className="muted">{slide.body}</p>
          </article>
        ))}
      </div>

      <Link className="button button-gold" to="/">
        Get Started Free
      </Link>
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
