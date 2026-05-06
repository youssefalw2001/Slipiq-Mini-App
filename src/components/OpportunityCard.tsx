import { Link } from 'react-router-dom';import ProbabilityBar from './ProbabilityBar';import TierBadge from './TierBadge';
export default function OpportunityCard({ item, onAdd }: { item: any; onAdd: () => void }) {
  const tier = item.top[0].modelProbability > 0.15 ? 'A' : item.top[0].modelProbability > 0.08 ? 'B' : 'C';
  return <article className='card'><div className='row'><Link to={`/lab/${item.id}`}><b>{item.player1} vs {item.player2}</b></Link><TierBadge tier={tier} /></div><p>{item.tournament} • {item.surface}</p><p className='mono'>Hold {Math.round(item.hold1*100)}% vs {Math.round(item.hold2*100)}%</p>{item.top.map((t: any)=><ProbabilityBar key={t.score} label={t.score} value={t.modelProbability}/>)}<button onClick={onAdd}>Add top leg</button></article>
}
