import { create } from 'zustand';
import { calcSlip } from '../lib/probability';
import type { SlipLeg } from '../types';

interface State {
  legs: SlipLeg[];
  stake: number;
  addLeg: (leg: SlipLeg) => void;
  removeLeg: (id: string) => void;
  clear: () => void;
  setStake: (stake: number) => void;
}

export const useSlipStore = create<State>((set) => ({
  legs: [],
  stake: 10,
  addLeg: (leg) => set((state) => (state.legs.some((existing) => existing.id === leg.id) ? state : { legs: [...state.legs, leg] })),
  removeLeg: (id) => set((state) => ({ legs: state.legs.filter((leg) => leg.id !== id) })),
  clear: () => set({ legs: [] }),
  setStake: (stake) => set({ stake: Number.isFinite(stake) && stake >= 0 ? stake : 0 }),
}));

export const useSlipSummary = () => useSlipStore((state) => calcSlip(state.legs, state.stake));
