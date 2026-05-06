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
        <h2>Most bettors ignore one of tennis&apos; sharpest markets: first-set correct scores.</h2>
        <p className="brief-copy">
          SlipIQ turns serve data, hold probability, and surface context into first-set score probabilities. We compare those model prices to market odds and show how the right tennis angle can improve your slip.
        </p>

        <div className="scan-console" aria-label="First Set Lab scan status">
          <span />
          <p className="mono">Scanning serve strength...</p>
          <p className="mono">Modeling first-set scores...</p>
          <p className="mono">Comparing model price vs market...</p>
        </div>

        <div className="brief-metrics" aria-label="SlipIQ model pillars">
          <div>
            <span>01</span>
            <strong>Serve Strength</strong>
            <p>We estimate how often each player should hold serve based on serve quality and pressure resistance.</p>
          </div>
          <div>
            <span>02</span>
            <strong>First-Set Scores</strong>
            <p>We model likely first-set outcomes like 6-3, 6-4, 7-5, and 7-6.</p>
          </div>
          <div>
            <span>03</span>
            <strong>Slip Fit</strong>
            <p>We compare model odds to market odds, then show which angles can strengthen a slip.</p>
          </div>
        </div>

        <div className="setfox-card">
          <div className="setfox-avatar" aria-hidden="true">◆</div>
          <div>
            <span className="mono">SETFOX SCAN</span>
            <p>Most bettors ask, “Who wins?” SlipIQ asks, “What is the most mispriced first-set outcome — and does it improve the slip?”</p>
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
