export type CheckoutTier = 'core' | 'quant';

type TierConfig = {
  label: string;
  price: string;
  badge: string;
  description: string;
  checkoutUrl?: string;
  telegramInviteUrl?: string;
  features: string[];
};

const env = import.meta.env;

export const proofVaultUrl = env.VITE_TELEGRAM_PROOF_VAULT_URL as string | undefined;

export const checkoutTiers: Record<CheckoutTier, TierConfig> = {
  core: {
    label: 'Core Terminal',
    price: '$99/mo',
    badge: 'LIVE CORE',
    description: 'Live Bet365-first Core exact-score lanes, Comfort signals, Proof Vault receipts, and mature recaps.',
    checkoutUrl: env.VITE_STRIPE_CORE_CHECKOUT_URL,
    telegramInviteUrl: env.VITE_TELEGRAM_CORE_INVITE_URL,
    features: ['Live Core signals', 'Comfort Confidence', 'Proof recaps', 'Telegram access after payment'],
  },
  quant: {
    label: 'Quant Terminal',
    price: '$199/mo',
    badge: 'VIP DESK',
    description: 'Core access plus Quant-only lanes, Stacked Confidence, deeper receipts, and early confidence notes.',
    checkoutUrl: env.VITE_STRIPE_QUANT_CHECKOUT_URL,
    telegramInviteUrl: env.VITE_TELEGRAM_QUANT_INVITE_URL,
    features: ['Everything in Core', 'Stacked Confidence', 'VIP-only lanes', 'Research notes later'],
  },
};

export function openStripeCheckout(tier: CheckoutTier) {
  const url = checkoutTiers[tier].checkoutUrl;
  if (!url) {
    throw new Error(`Missing checkout URL for ${tier}. Set VITE_STRIPE_${tier.toUpperCase()}_CHECKOUT_URL.`);
  }
  window.location.href = url;
}

export function openTelegramInvite(tier: CheckoutTier) {
  const url = checkoutTiers[tier].telegramInviteUrl;
  if (!url) {
    throw new Error(`Missing Telegram invite URL for ${tier}. Set VITE_TELEGRAM_${tier.toUpperCase()}_INVITE_URL.`);
  }
  window.location.href = url;
}

export function tierFromSearch(search: string): CheckoutTier {
  const params = new URLSearchParams(search);
  const tier = params.get('tier');
  return tier === 'quant' ? 'quant' : 'core';
}
