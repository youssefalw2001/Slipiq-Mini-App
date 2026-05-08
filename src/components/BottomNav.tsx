import { NavLink } from 'react-router-dom';

const items = [
  { to: '/', label: 'Home' },
  { to: '/slip', label: 'Builder' },
  { to: '/myslips', label: 'My Slips' },
  { to: '/proof', label: 'Proof' },
  { to: '/profile', label: 'Profile' },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="SlipIQ navigation">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => `bottom-nav__item${isActive ? ' is-active' : ''}`}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
