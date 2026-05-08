import { Route, Routes } from 'react-router-dom';
import BottomNav from './components/BottomNav';
import { Alerts, FirstSetLab, Home, MySlips, Onboarding, Profile, SlipBuilder } from './screens';
import OpsControlCenter from './screens/OpsControlCenter';
import ProofLog from './screens/ProofLog';

export default function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/lab/:id" element={<FirstSetLab />} />
        <Route path="/slip" element={<SlipBuilder />} />
        <Route path="/myslips" element={<MySlips />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/proof" element={<ProofLog />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/ops" element={<OpsControlCenter />} />
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
      <BottomNav />
    </div>
  );
}
