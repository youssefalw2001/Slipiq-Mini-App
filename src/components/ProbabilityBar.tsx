export default function ProbabilityBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return <div className='prob'><div className='prob-row'><span>{label}</span><span className='mono'>{pct.toFixed(1)}%</span></div><div className='prob-track'><div className='prob-fill' style={{ width: `${pct}%` }} /></div></div>;
}
