export type Surface='clay'|'hard'|'grass'; export type Tier='S'|'A'|'B'|'C';
export interface PlayerServeStats{fs1:number;w1s:number;w2s:number;bpSave:number}
export interface TennisMatch{id:string;tournament:string;surface:Surface;player1:string;player2:string;player1Stats:PlayerServeStats;player2Stats:PlayerServeStats;bookmakerOdds:Record<string,number>}
export interface ScoreOutcome{score:string;modelProbability:number;fairOdds:number;bookmakerOdds:number;impliedProbability:number;edge:number;expectedValue:number;classLabel:string}
export interface SlipLeg{id:string;label:string;sport:'tennis'|'nba';odds:number;modelProbability:number;eventId:string}
export interface SlipSummary{combinedOdds:number;hitRate:number;expectedValue:number;payout:number;tier:Tier}
