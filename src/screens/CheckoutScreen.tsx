import { useState } from 'react';
import { checkoutTiers, openStripeCheckout, proofVaultUrl, type CheckoutTier } from '../lib/checkout';
import ResponsibleNotice from '../components/ResponsibleNotice';

const tiers = Object.entries(checkoutTiers) as Array<[CheckoutTier, (typeof checkoutTiers)[CheckoutTier]]>;

export default function CheckoutScreen() {
  const [error, setError] = useState('');

  const handleCheckout = (tier: CheckoutTier) => {
    setError('');
    try {
      openStripeCheckout(tier);
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : 'Checkout is not configured yet.');
    }
  };

  return (
    <main className="screen checkout-screen">
      <section className="detail-header">
        <p className="eyebrow">First Set Lab Access</p>
        <h1>Pay once. Enter the terminal.</h1>
        <p className="muted">
          Choose a lane, complete Stripe checkout, then land directly on the Telegram invite configured for that terminal.
        </p>
      </section>

      <section className="card checkout-hero-card">
        <div>
          <p className="eyebrow">Proof-first access</p>
          <h2>Not picks. Price intelligence.</h2>
        </div>
        <p className="muted">
          Stripe handles payment. Telegram handles delivery. First Set Lab keeps the ledger honest with receipts, settlement, and no-deletion proof discipline.
        </p>
        {proofVaultUrl ? (
          <a className="button button-ghost" href={proofVaultUrl} target="_blank" rel="noreferrer">
            View Free Proof Vault
          </a>
        ) : (
          <p className="muted small">Set VITE_TELEGRAM_PROOF_VAULT_URL to enable the free Proof Vault button.</p>
        )}
      </section>

      <section className="checkout-tier-grid">
        {tiers.map(([tier, config]) => (
          <article key={tier} className={`card checkout-tier-card checkout-tier-card--${tier}`}>
            <div className="section-title">
              <div>
                <p className="eyebrow">{config.badge}</p>
                <h2>{config.label}</h2>
              </div>
              <strong className="mono checkout-price">{config.price}</strong>
            </div>
            <p className="muted">{config.description}</p>
            <ul className="checkout-feature-list">
              {config.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <button className="button button-gold" type="button" onClick={() => handleCheckout(tier)}>
              Pay with Stripe → Telegram
            </button>
            {!config.checkoutUrl ? (
              <p className="muted small">Missing {tier === 'core' ? 'VITE_STRIPE_CORE_CHECKOUT_URL' : 'VITE_STRIPE_QUANT_CHECKOUT_URL'}.</p>
            ) : null}
          </article>
        ))}
      </section>

      {error ? <p className="error-text">{error}</p> : null}

      <section className="card checkout-note-card">
        <p className="eyebrow">Setup rule</p>
        <p className="muted">
          In Stripe, set each payment link success redirect to the matching Telegram invite URL. Keep the invite links private and rotate them if leaked.
        </p>
      </section>

      <ResponsibleNotice />
    </main>
  );
}
