export type CheckoutTier = 'core' | 'quant';

type TierConfig = {
  label: string;
  price: string;
  description: string;
  checkoutUrl?: string;
  telegramInviteUrl?: string;
};

const env = import.meta.env;

export const checkoutTiers: Record<CheckoutTier, TierConfig> = {
  core: {
    label: 'Core Terminal',
    price: '$49/mo',
    description: 'Bet365-first Core exact-score alerts, Proof Vault receipts, and mature recaps.',
    checkoutUrl: env.VITE_STRIPE_CORE_CHECKOUT_URL,
    telegramInviteUrl: env.VITE_TELEGRAM_CORE_INVITE_URL,
  },
  quant: {
    label: 'Quant Terminal',
    price: '$99/mo',
    description: 'Everything in Core plus Quant-only lanes, deeper receipts, and early confidence notes.',
    checkoutUrl: env.VITE_STRIPE_QUANT_CHECKOUT_URL,
    telegramInviteUrl: env.VITE_TELEGRAM_QUANT_INVITE_URL,
  },
};

export function openStripeCheckout(tier: CheckoutTier) {
  const url = checkoutTiers[tier].checkoutUrl;
  if (!url) {
    throw new Error(`Missing checkout URL for ${tier}. Set VITE_STRIPE_${tier.toUpperCase()}_CHECKOUT_URL.`);
  }
  window.location.href = url;
}

export function tierFromSearch(search: string): CheckoutTier {
  const params = new URLSearchParams(search);
  const tier = params.get('tier');
  return tier === 'quant' ? 'quant' : 'core';
}
