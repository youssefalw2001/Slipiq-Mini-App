import { create } from 'zustand';
import { calcSlip } from '../lib/probability';
import { SlipLeg } from '../types';
interface State{legs:SlipLeg[];stake:number;addLeg:(l:SlipLeg)=>void;removeLeg:(id:string)=>void;clear:()=>void;setStake:(n:number)=>void}
export const useSlipStore=create<State>((set)=>({legs:[],stake:10,addLeg:(l)=>set((s)=>s.legs.some(x=>x.id===l.id)?s:{legs:[...s.legs,l]}),removeLeg:(id)=>set((s)=>({legs:s.legs.filter(l=>l.id!==id)})),clear:()=>set({legs:[]}),setStake:(n)=>set({stake:n})}));
export const useSlipSummary=()=>useSlipStore((s)=>calcSlip(s.legs,s.stake));
