import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import ResponsibleNotice from '../components/ResponsibleNotice';
import { fetchLiveOpportunities, type LiveFeedResult } from '../lib/liveData';
import type { FirstSetOpportunity, ScannerStats } from '../types';
import './OpsControlCenter.css';

const STALE_AFTER_MINUTES = 90;

const RESEARCH_CANDIDATE = {
  name: 'Grass Lab Candidate',
  label: 'Research only / under validation',
  surface: 'grass',
  oddsBucket: 'odds_5_8',
  tournamentLevel: 'tour_other',
  minProbability: '3%',
  minEv: '0',
  minEdge: '0',
  roi: '+9.67%',
  hitRate: '16.73%',
  unitResult: '+98.25u',
  sampleSize: '1,016',
  positiveFolds: '3/3',
  warning: 'High overfit risk. Needs fresh live validation before becoming a product rule.',
};

const REJECTION_LABELS: Record<string, string> = {
  no_market_odds: 'No market odds',
  tiebreak_blocked: 'Tiebreak blocked',
  doubles_blocked: 'Doubles blocked',
  score_family_blocked: 'Score family blocked',
  tournament_level_blocked: 'Tournament level blocked',
  odds_bucket_blocked: 'Odds bucket blocked',
  odds_above_cap: 'Odds above cap',
  probability_below_min: 'Probability below minimum',
  ev_below_min: 'EV below minimum',
  edge_below_min: 'Edge below minimum',
};

function deriveScannerStats(feed: FirstSetOpportunity[]): ScannerStats {
  let totalScanned = 0;
  let passed = 0;
  let tiebreakBlocked = 0;

  for (const opportunity of feed) {
    for (const outcome of opportunity.outcomes) {
      totalScanned += 1;
      if (outcome.setfox.passed) passed += 1;
      if (outcome.setfox.rejections.includes('tiebreak_blocked')) tiebreakBlocked += 1;
    }
  }

  return {
    ruleVersion: feed[0]?.outcomes[0]?.setfox.ruleVersion ?? 'setfox.v3.research.itf-normal-12to18',
    totalScanned,
    passed,
    rejected: Math.max(0, totalScanned - passed),
    tiebreakBlocked,
    capturedAt: null,
  };
}

function deriveRejectionReasons(feed: FirstSetOpportunity[]) {
  const counts = new Map<string, number>();
  for (const opportunity of feed) {
    for (const outcome of opportunity.outcomes) {
      for (const reason of outcome.setfox.rejections) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function getDataAgeMinutes(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function formatAge(minutes: number | null) {
  if (minutes === null) return 'Unknown';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h ago` : `${hours}h ${remainder}m ago`;
}

function HealthMetric({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <div className={`ops-metric ops-metric-${tone}`}>
      <span>{label}</span>
      <strong className="mono">{value}</strong>
    </div>
  );
}

function StatusCallout({ stale, source, error }: { stale: boolean; source: 'live' | 'seed'; error: string }) {
  if (error) {
    return (
      <article className="card ops-status ops-status-bad">
        <p className="eyebrow">Action needed</p>
        <h2>Live data could not be loaded.</h2>
        <p className="muted">Check the data API URL, Supabase function, and recent GitHub Actions refresh runs.</p>
      </article>
    );
  }

  if (stale) {
    return (
      <article className="card ops-status ops-status-warn">
        <p className="eyebrow">Data may be stale</p>
        <h2>Scanner should pause claims until the next refresh.</h2>
        <p className="muted">If this stays yellow, run data-refresh manually or check the scheduled refresh workflow.</p>
      </article>
    );
  }

  return (
    <article className="card ops-status ops-status-good">
      <p className="eyebrow">System healthy</p>
      <h2>{source === 'live' ? 'Live feed is connected.' : 'Seed fallback is active.'}</h2>
      <p className="muted">
        {source === 'live'
          ? 'SlipIQ is receiving scanner data from the live Supabase/API-Tennis pipeline.'
          : 'The app is usable, but live data should be restored before wider launch posts.'}
      </p>
    </article>
  );
}

export default function OpsControlCenter() {
  const [result, setResult] = useState<LiveFeedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchLiveOpportunities()
      .then((live) => {
        if (!cancelled) {
          setResult(live);
          setError('');
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load live data.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const feed = result?.opportunities ?? [];
  const scanner = result?.scanner ?? (feed.length > 0 ? deriveScannerStats(feed) : null);
  const source: 'live' | 'seed' = result ? 'live' : 'seed';
  const ageMinutes = getDataAgeMinutes(scanner?.capturedAt);
  const isStale = source === 'live' && (ageMinutes === null || ageMinutes > STALE_AFTER_MINUTES);
  const rejectionReasons = useMemo(() => deriveRejectionReasons(feed), [feed]);

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Founder Ops · Research Mode</p>
        <h1>Ops Control Center</h1>
        <p className="muted">One place to check whether SlipIQ is healthy before posting signals or inviting users.</p>
      </section>

      <Link className="button button-ghost" to="/">Back to Home</Link>
      {loading ? <p className="muted">Checking SlipIQ systems...</p> : null}
      <StatusCallout stale={isStale} source={source} error={error} />

      <section className="card">
        <div className="section-title">
          <div>
            <p className="eyebrow">Live pipeline</p>
            <h2>API-Tennis → data-refresh → Supabase → app</h2>
          </div>
          <span className={`chip mono ${isStale || error ? 'setfox-confidence-research' : 'setfox-confidence-validated'}`}>{isStale || error ? 'CHECK' : 'OK'}</span>
        </div>

        <div className="ops-grid">
          <HealthMetric label="App" value="Online" tone="good" />
          <HealthMetric label="Source" value={source === 'live' ? 'Live' : 'Seed'} tone={source === 'live' ? 'good' : 'warn'} />
          <HealthMetric label="Last refresh" value={formatDateTime(scanner?.capturedAt)} tone={isStale ? 'warn' : 'good'} />
          <HealthMetric label="Data age" value={formatAge(ageMinutes)} tone={isStale ? 'warn' : 'good'} />
          <HealthMetric label="Matches" value={feed.length} />
          <HealthMetric label="Scanned" value={scanner?.totalScanned ?? 0} />
          <HealthMetric label="Passed" value={scanner?.passed ?? 0} tone={(scanner?.passed ?? 0) > 0 ? 'good' : 'neutral'} />
          <HealthMetric label="Rejected" value={scanner?.rejected ?? 0} />
          <HealthMetric label="Tiebreak blocks" value={scanner?.tiebreakBlocked ?? 0} tone="warn" />
        </div>
      </section>

      {scanner && scanner.passed === 0 ? (
        <section className="card ops-zero-pass">
          <p className="eyebrow">0 passes is not broken</p>
          <h2>No SetFox passes right now.</h2>
          <p className="muted">The scanner is live and rejecting weak markets until a research-grade setup appears. Strict Mode blocks tiebreaks, doubles, weak score families, bad odds buckets, and low EV/edge.</p>
        </section>
      ) : null}

      <section className="card">
        <div className="section-title">
          <div>
            <p className="eyebrow">Reject reasons</p>
            <h2>What the scanner blocked</h2>
          </div>
        </div>
        {rejectionReasons.length === 0 ? <p className="muted">No rejection breakdown available from the current feed.</p> : null}
        <div className="ops-reason-list">
          {rejectionReasons.slice(0, 8).map(([reason, count]) => (
            <div key={reason} className="ops-reason-row">
              <span>{REJECTION_LABELS[reason] ?? reason}</span>
              <strong className="mono">{count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="card research-candidate-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">Research Candidate</p>
            <h2>{RESEARCH_CANDIDATE.name}</h2>
          </div>
          <span className="chip mono setfox-confidence-research">UNDER VALIDATION</span>
        </div>
        <p className="muted">{RESEARCH_CANDIDATE.label}. This is not a product rule yet.</p>
        <div className="ops-grid compact-grid">
          <HealthMetric label="Surface" value={RESEARCH_CANDIDATE.surface} />
          <HealthMetric label="Odds bucket" value={RESEARCH_CANDIDATE.oddsBucket} />
          <HealthMetric label="Level" value={RESEARCH_CANDIDATE.tournamentLevel} />
          <HealthMetric label="Min prob" value={RESEARCH_CANDIDATE.minProbability} />
          <HealthMetric label="Min EV" value={RESEARCH_CANDIDATE.minEv} />
          <HealthMetric label="Min edge" value={RESEARCH_CANDIDATE.minEdge} />
          <HealthMetric label="Walk-forward ROI" value={RESEARCH_CANDIDATE.roi} tone="good" />
          <HealthMetric label="Hit rate" value={RESEARCH_CANDIDATE.hitRate} />
          <HealthMetric label="Unit result" value={RESEARCH_CANDIDATE.unitResult} tone="good" />
          <HealthMetric label="Sample" value={RESEARCH_CANDIDATE.sampleSize} />
          <HealthMetric label="Positive folds" value={RESEARCH_CANDIDATE.positiveFolds} tone="good" />
        </div>
        <p className="muted small warning-copy">{RESEARCH_CANDIDATE.warning}</p>
      </section>

      <section className="card">
        <p className="eyebrow">Founder checklist</p>
        <h2>Before you post or launch wider</h2>
        <ul className="ops-checklist muted">
          <li>Data status is green or recently refreshed.</li>
          <li>SetFox language stays in Research Mode.</li>
          <li>Avoid certainty language in public posts.</li>
          <li>18+ and responsible-use language remains visible.</li>
        </ul>
      </section>

      <ResponsibleNotice />
    </main>
  );
}
