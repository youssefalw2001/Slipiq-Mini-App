import { NavLink } from 'react-router-dom';
export default function BottomNav(){return <nav className='nav'>{[['/','Home'],['/slip','Slip'],['/myslips','My Slips'],['/alerts','Alerts'],['/profile','Profile']].map(([to,l])=><NavLink key={to} to={to} className='tab'>{l}</NavLink>)}</nav>}
