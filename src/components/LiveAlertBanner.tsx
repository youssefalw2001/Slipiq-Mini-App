import { Link } from 'react-router-dom';

export default function LiveAlertBanner() {
  return (
    <section className="intelligence-brief" aria-label="First Set Lab intelligence briefing">
      <div className="brief-orb" />
      <div className="brief-content">
        <p className="eyebrow">PRIVATE PROBABILITY DESK · FIRST SET LAB</p>
        <h2>The smartest edge in your slip starts before the match does.</h2>
        <p className="brief-copy">
          Most users chase picks. SlipIQ prices risk. We model serve strength, hold probability, surface context, and market odds to show which tennis first-set outcomes are actually live.
        </p>

        <div className="brief-metrics" aria-label="SlipIQ model pillars">
          <div>
            <span>01</span>
            <strong>Hold Rate</strong>
            <p>Serve patterns become first-set probabilities.</p>
          </div>
          <div>
            <span>02</span>
            <strong>Fair Price</strong>
            <p>Model odds are compared against market odds.</p>
          </div>
          <div>
            <span>03</span>
            <strong>Slip Fit</strong>
            <p>Each leg is scored for payout, hit rate, and risk.</p>
          </div>
        </div>

        <div className="brief-quote">
          <span className="mono">QUANT MODE</span>
          <p>A small minority of bettors think in probabilities, prices, and edge. SlipIQ puts that workflow in your pocket.</p>
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
