import { Link } from 'react-router-dom';

interface LiveAlertBannerProps {
  title?: string;
  subtitle?: string;
  to?: string;
}

export default function LiveAlertBanner({
  title = 'A-TIER WINDOW OPEN · First Set Lab is live',
  subtitle = 'Review model probability, market odds, and edge before adding legs.',
  to = '/slip',
}: LiveAlertBannerProps) {
  return (
    <section className="live-alert" aria-label="Live alert">
      <div>
        <p className="eyebrow">🔥 LIVE ALERT</p>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <Link className="button button-gold" to={to}>
        Build Slip
      </Link>
    </section>
  );
}
