import { Route, Routes } from 'react-router-dom';
import BottomNav from './components/BottomNav';
import { FirstSetLab, Home, Placeholder, SlipBuilder } from './screens';

export default function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/lab/:id" element={<FirstSetLab />} />
        <Route path="/slip" element={<SlipBuilder />} />
        <Route path="/myslips" element={<Placeholder title="My Slips" />} />
        <Route path="/alerts" element={<Placeholder title="Alerts" />} />
        <Route path="/profile" element={<Placeholder title="Profile + Premium" />} />
        <Route path="/onboarding" element={<Placeholder title="Onboarding" />} />
      </Routes>
      <BottomNav />
    </div>
  );
}
