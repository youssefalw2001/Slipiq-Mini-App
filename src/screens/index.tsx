import { useParams } from 'react-router-dom';
import { opportunities, legFromOutcome } from '../lib/opportunities';
import { useSlipStore, useSlipSummary } from '../store/slipStore';
import nba from '../data/nbaGames.json';
import OpportunityCard from '../components/OpportunityCard';
import LiveAlertBanner from '../components/LiveAlertBanner';
import ResponsibleNotice from '../components/ResponsibleNotice';
import SlipLegChip from '../components/SlipLegChip';

export const Home = () => {
  const add = useSlipStore((s) => s.addLeg);
  const highEdge = opportunities.filter((m) => m.top.some((t) => t.edge > 0.03)).length;
  return <main><h1>First Set Lab</h1><LiveAlertBanner count={highEdge} />{opportunities.map((m) => <OpportunityCard key={m.id} item={m} onAdd={() => { const leg = legFromOutcome(m.id, m.top[0].score); if (leg) add(leg); }} />)}<ResponsibleNotice /></main>;
};

export const FirstSetLab = () => {
  const { id } = useParams(); const m = opportunities.find((x) => x.id === id); const add = useSlipStore((s) => s.addLeg);
  if (!m) return <div>Not found</div>;
  return <main><h1>{m.player1} vs {m.player2}</h1><p>{m.tournament} • {m.surface}</p>{m.outcomes.map((o) => <div key={o.score} className='card'><b>{o.score}</b> <span className='mono'>{(o.modelProbability*100).toFixed(1)}%</span><div>Fair {o.fairOdds.toFixed(2)} | Book {o.bookmakerOdds ? o.bookmakerOdds.toFixed(2) : 'N/A'}</div><div>Edge {(o.edge*100).toFixed(1)}% | EV {(o.expectedValue*100).toFixed(1)}%</div><button onClick={() => { const leg = legFromOutcome(m.id, o.score); if (leg) add(leg); }}>Add</button></div>)}<ResponsibleNotice /></main>;
};

export const SlipBuilder = () => {
  const { legs, stake, setStake, removeLeg, addLeg } = useSlipStore(); const s = useSlipSummary();
  return <main><h1>Slip Builder</h1><input value={Number.isFinite(stake) ? stake : 10} type='number' onChange={(e) => { const val = Number(e.target.value); if (e.target.value === '') return; if (Number.isFinite(val) && val > 0) setStake(val); }} />{legs.map((l) => <SlipLegChip key={l.id} leg={l} onRemove={() => removeLeg(l.id)} />)}<h3>Combined odds <span className='mono'>{s.combinedOdds.toFixed(2)}</span> tier {s.tier} hit <span className='mono'>{(s.hitRate*100).toFixed(2)}%</span> payout <span className='mono'>{s.payout.toFixed(2)}</span></h3><h4>NBA support legs</h4>{(nba as any[]).map((g) => <button key={g.id} onClick={() => addLeg({ id: g.id, label: g.label, sport: 'nba', odds: g.odds, modelProbability: g.modelProbability, eventId: g.id })}>{g.label} @{g.odds}</button>)}<ResponsibleNotice /></main>;
};

export const Placeholder = ({ title }: { title: string }) => <main><h1>{title}</h1><p>Placeholder screen for MVP shell.</p><ResponsibleNotice /></main>;
