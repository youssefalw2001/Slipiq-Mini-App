export default function LiveAlertBanner({ count }: { count: number }) { if (!count) return null; return <div className='alert'>⚡ {count} high-edge opportunities detected</div>; }
