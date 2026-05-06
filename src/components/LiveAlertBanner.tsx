import { Link } from 'react-router-dom';

export default function LiveAlertBanner() {
  return (
    <section className="intelligence-brief" aria-label="First Set Lab intro">
      <div className="brief-orb" />
      <div className="brand-strip" aria-label="SlipIQ brand">
        <div className="slipiq-mark" aria-hidden="true">
          <span className="mark-eye" />
          <span className="mark-scan" />
        </div>
        <div>
          <p className="brand-wordmark">Slip<span>IQ</span><i>_</i></p>
          <p className="brand-slogan">Don&apos;t guess. Calculate.</p>
        </div>
        <div className="lab-status mono">FIRST SET LAB ONLINE</div>
      </div>

      <div className="brief-content">
        <p className="eyebrow">FIRST SET LAB · TENNIS EDGE ENGINE</p>
        <h2>Most bettors overlook the first set. SlipIQ shows the math.</h2>
        <p className="brief-copy">
          Instead of guessing a tennis leg, SlipIQ calculates how the first set is likely to unfold. We turn serve stats into score probabilities, fair odds, and smarter slip options.
        </p>

        <div className="scan-console" aria-label="First Set Lab scan status">
          <span />
          <p className="mono">Loading serve data...</p>
          <p className="mono">Modeling hold rates...</p>
          <p className="mono">Pricing first-set scores...</p>
        </div>

        <div className="brief-metrics" aria-label="SlipIQ model pillars">
          <div>
            <span>01</span>
            <strong>Serve Strength</strong>
            <p>We estimate how often each player should hold serve.</p>
          </div>
          <div>
            <span>02</span>
            <strong>First-Set Scores</strong>
            <p>We calculate likely 6-3, 6-4, 7-5, and 7-6 outcomes.</p>
          </div>
          <div>
            <span>03</span>
            <strong>Slip Fit</strong>
            <p>We show if a leg improves your slip or adds too much risk.</p>
          </div>
        </div>

        <div className="setfox-card">
          <div className="setfox-avatar" aria-hidden="true">◆</div>
          <div>
            <span className="mono">SETFOX SCAN</span>
            <p>Most bettors ask, “Who wins?” SlipIQ asks, “What is the real probability — and is the price worth it?”</p>
          </div>
        </div>

        <div className="brief-actions">
          <Link className="button button-gold" to="/slip">
            Build smarter slip
          </Link>
          <a className="button button-ghost" href="#opportunities">
            View today&apos;s lab
          </a>
        </div>
      </div>
    </section>
  );
}
