type HapticImpact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  initDataUnsafe?: { user?: unknown };
  HapticFeedback?: { impactOccurred?: (style: HapticImpact) => void; notificationOccurred?: (type: 'success' | 'warning' | 'error') => void };
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (callback: () => void) => void };
};

function getWebApp(): TelegramWebApp | undefined {
  return (globalThis as typeof globalThis & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

export function initTelegramApp() {
  const tg = getWebApp();
  tg?.ready?.();
  tg?.expand?.();
  tg?.setHeaderColor?.('#04040b');
  tg?.setBackgroundColor?.('#04040b');
}

export function triggerHaptic(style: HapticImpact = 'light') {
  getWebApp()?.HapticFeedback?.impactOccurred?.(style);
}

export function showBackButton(callback: () => void) {
  const backButton = getWebApp()?.BackButton;
  if (!backButton) return;
  backButton.onClick?.(callback);
  backButton.show?.();
}

export function hideBackButton() {
  getWebApp()?.BackButton?.hide?.();
}

export function getTelegramUser() {
  return getWebApp()?.initDataUnsafe?.user ?? null;
}
