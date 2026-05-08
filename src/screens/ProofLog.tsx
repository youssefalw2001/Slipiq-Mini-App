import ResponsibleNotice from '../components/ResponsibleNotice';

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

export default function ProofLog() {
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
