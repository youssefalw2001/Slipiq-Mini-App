export const initTelegramApp=()=>{const tg=(globalThis as any).Telegram?.WebApp;tg?.ready?.();};
export const triggerHaptic=()=>{(globalThis as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred?.('light');};
export const showBackButton=(cb:()=>void)=>{const b=(globalThis as any).Telegram?.WebApp?.BackButton; if(!b) return; b.onClick(cb); b.show();};
export const hideBackButton=()=>{(globalThis as any).Telegram?.WebApp?.BackButton?.hide?.();};
export const getTelegramUser=()=>((globalThis as any).Telegram?.WebApp?.initDataUnsafe?.user??null);
