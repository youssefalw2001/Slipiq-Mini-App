import ResponsibleNotice from '../components/ResponsibleNotice';
import proofLog from '../data/scoreHunterProofLog.json';

interface PaperProofSignal {
  id: string;
  foundAt: string;
  match: string;
  tournament: string;
  score: string;
  odds: number;
  signalStrength: number;
  status: 'pending' | 'won' | 'lost' | 'void';
  result: string | null;
  profitUnits: number;
  note: string;
}

const proofStats = [
  { label: 'V2 audit bets', value: '1,664', helper: 'one pick per match' },
  { label: 'Hit rate', value: '16.11%', helper: 'most plays still lose' },
  { label: 'Historical ROI', value: '+16.12%', helper: '+268.2u in audit' },
  { label: 'Positive months', value: '9 / 13', helper: 'not a guarantee' },
];

const proofWarnings = [
  'The old Grass Lab name is deprecated. Surface labels are not trusted enough for product claims.',
  'Score Hunter is high variance: roughly 84 of every 100 historical plays lost.',
  'The model probability was overconfident, so the app should show signal strength and historical hit band instead of certainty.',
  'Live paper tracking is required before stronger paid claims or aggressive marketing.',
];

const nextChecks = [
  'Confirm users can actually get odds near the historical x7.26 zone before match start.',
  'Test stricter variants: 4-6 only, odds 6.50-8.00, and max 1-3 plays per day.',
  'Track every live signal, miss, win, loss, and drawdown in a public proof log.',
  'Add bankroll guardrails before a $99/month pro plan: unit sizing, stop-loss, and losing-streak warnings.',
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function statusLabel(status: PaperProofSignal['status']) {
  if (status === 'won') return 'Won';
  if (status === 'lost') return 'Lost';
  if (status === 'void') return 'Void';
  return 'Pending';
}

function summarizePaperLog(rows: PaperProofSignal[]) {
  const settled = rows.filter((row) => row.status === 'won' || row.status === 'lost');
  const wins = settled.filter((row) => row.status === 'won').length;
  const profitUnits = rows.reduce((sum, row) => sum + row.profitUnits, 0);
  return {
    tracked: rows.length,
    pending: rows.filter((row) => row.status === 'pending').length,
    settled: settled.length,
    wins,
    hitRate: settled.length > 0 ? wins / settled.length : null,
    profitUnits,
  };
}

export default function ProofLog() {
  const rows = proofLog as PaperProofSignal[];
  const paperSummary = summarizePaperLog(rows);

  return (
    <main className="screen">
      <section className="detail-header">
        <p className="eyebrow">Score Hunter Lab · Proof Log</p>
        <h1>Transparent research, not hype.</h1>
        <p className="muted">
          Score Hunter is the renamed research lane from the Grass Lab audit. The signal survived one-pick-per-match testing, but live proof is still required.
        </p>
      </section>

      <section className="card score-hunter-proof-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">Blind Sim V2 Audit</p>
            <h2>Score Hunter baseline</h2>
          </div>
          <span className="chip mono setfox-confidence-research">RESEARCH</span>
        </div>
        <div className="stats-bar compact proof-stat-grid">
          {proofStats.map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong className="mono">{item.value}</strong>
              <small>{item.helper}</small>
            </div>
          ))}
        </div>
        <p className="muted small">
          Historical result only. It does not prove future profit, live price availability, or user execution quality.
        </p>
      </section>

      <section className="card paper-proof-card">
        <div className="section-title">
          <div>
            <p className="eyebrow">Live Paper Tracking</p>
            <h2>Forward proof starts here</h2>
          </div>
          <span className="chip mono setfox-confidence-watchlist">PAPER</span>
        </div>
        <div className="stats-bar compact proof-stat-grid">
          <div>
            <span>Tracked</span>
            <strong className="mono">{paperSummary.tracked}</strong>
            <small>paper signals</small>
          </div>
          <div>
            <span>Pending</span>
            <strong className="mono">{paperSummary.pending}</strong>
            <small>awaiting result</small>
          </div>
          <div>
            <span>Settled hit rate</span>
            <strong className="mono">{paperSummary.hitRate === null ? 'N/A' : `${(paperSummary.hitRate * 100).toFixed(1)}%`}</strong>
            <small>not enough live data yet</small>
          </div>
          <div>
            <span>Paper P/L</span>
            <strong className="mono">{paperSummary.profitUnits >= 0 ? '+' : ''}{paperSummary.profitUnits.toFixed(2)}u</strong>
            <small>flat 1u tracking</small>
          </div>
        </div>
        <p className="muted small">
          Paper tracking means SlipIQ logs the signal and result. It does not place bets, connect sportsbooks, or automate gambling.
        </p>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>Signal log</h2>
          <span className="muted">Manual seed until backend logging connects</span>
        </div>
        <div className="paper-log-list">
          {rows.map((row) => (
            <article key={row.id} className={`paper-log-row is-${row.status}`}>
              <div className="paper-log-row__head">
                <div>
                  <span className="mono">{formatDate(row.foundAt)}</span>
                  <strong>{row.match}</strong>
                  <p>{row.tournament}</p>
                </div>
                <span className="chip mono">{statusLabel(row.status)}</span>
              </div>
              <div className="paper-log-metrics">
                <div>
                  <span>Score</span>
                  <strong className="mono">{row.score}</strong>
                </div>
                <div>
                  <span>Odds</span>
                  <strong className="mono">x{row.odds.toFixed(2)}</strong>
                </div>
                <div>
                  <span>Signal</span>
                  <strong className="mono">{(row.signalStrength * 100).toFixed(1)}%</strong>
                </div>
                <div>
                  <span>P/L</span>
                  <strong className="mono">{row.profitUnits >= 0 ? '+' : ''}{row.profitUnits.toFixed(2)}u</strong>
                </div>
              </div>
              <p className="muted small">{row.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>What this means</h2>
          <span className="muted">Honest edge profile</span>
        </div>
        <div className="proof-copy-stack">
          <p>
            Score Hunter is a first-set correct-score research strategy built around lower-tier tennis, the x5-x8 odds zone, and strict one-pick-per-match tracking.
          </p>
          <p>
            It is not a high-hit-rate pick stream. It is a high-odds value approach where patience and small unit sizing matter more than daily winners.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>Risk warnings</h2>
          <span className="muted">Required reading</span>
        </div>
        <ul className="setfox-manifest muted">
          {proofWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>Next validation checks</h2>
          <span className="muted">How we reduce losses</span>
        </div>
        <ul className="setfox-manifest muted">
          {nextChecks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      </section>

      <ResponsibleNotice />
    </main>
  );
}
