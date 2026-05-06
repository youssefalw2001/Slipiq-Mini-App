interface IQRebuildCardProps {
  compact?: boolean;
}

export default function IQRebuildCard({ compact = false }: IQRebuildCardProps) {
  return (
    <section className={`iq-rebuild-card${compact ? ' is-compact' : ''}`} aria-label="IQ Rebuild odds transformation">
      <div className="rebuild-header">
        <div>
          <p className="eyebrow">SETFOX REBUILD</p>
          <h2>Turn a regular slip into calculated upside.</h2>
        </div>
        <span className="rebuild-risk mono">RISK SHOWN</span>
      </div>

      <div className="odds-transform" aria-label="Base odds rebuilt by SlipIQ">
        <div className="odds-side odds-base">
          <span className="mono">BASE SLIP</span>
          <strong className="mono">+276</strong>
        </div>
        <div className="rebuild-arrow" aria-hidden="true">
          <span />
        </div>
        <div className="odds-side odds-iq">
          <span className="mono">IQ REBUILD</span>
          <strong className="mono">+1268</strong>
        </div>
      </div>

      <div className="rebuild-stats">
        <div>
          <span>Model hit rate</span>
          <strong className="mono">8.7%</strong>
        </div>
        <div>
          <span>Build type</span>
          <strong className="mono">UPSIDE</strong>
        </div>
        <div>
          <span>Added edge</span>
          <strong className="mono positive-text">+3.8%</strong>
        </div>
      </div>

      {!compact ? (
        <p className="rebuild-note">
          Higher payout is not magic. SetFox shows the tradeoff: odds, hit rate, risk, and whether the rebuild still makes sense.
        </p>
      ) : null}
    </section>
  );
}
