#!/usr/bin/env node
/*
  Show the vig with ONE real match, every outcome, every book, step by step.
  Then show the same match's Home/Away market for contrast.
  No inference. Just arithmetic on real prices.
*/
import fs from 'node:fs';
const BASE = 'https://api.api-tennis.com/tennis/';
function loadKey(){ if(fs.existsSync('.env')){for(const l of fs.readFileSync('.env','utf8').split('\n')){const m=l.match(/^(API_TENNIS_KEY|API_TENNIS_API_KEY|APITENNIS_API_KEY)\s*=\s*(.+)$/);if(m&&m[2].trim())return m[2].trim();}} return process.env.API_TENNIS_KEY||null; }
const KEY=loadKey(); if(!KEY){console.error('no key');process.exit(2);}
async function call(method,params={}){const u=new URL(BASE);u.searchParams.set('method',method);u.searchParams.set('APIkey',KEY);for(const[k,v]of Object.entries(params))u.searchParams.set(k,String(v));const r=await fetch(u);return r.json();}

const fx = await call('get_fixtures',{date_start:'2026-07-20',date_stop:'2026-07-20'});
const cands = (fx.result||[]).filter(f=>String(f.event_type_type||'').toLowerCase().includes('singles')&&String(f.event_status||'').toLowerCase().includes('finished'));

let picked=null, block=null;
for(const f of cands.slice(0,25)){
  const od=await call('get_odds',{match_key:f.event_key});
  const res=od?.result; if(!res)continue;
  const b=res[String(f.event_key)]??Object.values(res)[0];
  if(!b||typeof b!=='object')continue;
  const cs=Object.keys(b).find(n=>/correct score 1st half/i.test(n));
  const ha=Object.keys(b).find(n=>/^home\/away$/i.test(n));
  if(cs&&ha&&Object.keys(b[cs]||{}).length>=12){picked=f;block=b;break;}
  await new Promise(r=>setTimeout(r,120));
}
if(!picked){console.error('no suitable match');process.exit(1);}

const fs1 = (picked.scores||[]).find(s=>String(s.score_set)==='1');
console.log('='.repeat(78));
console.log(`MATCH: ${picked.event_first_player} vs ${picked.event_second_player}`);
console.log(`${picked.tournament_name}   final: ${picked.event_final_result}   first set: ${fs1?`${Math.trunc(+fs1.score_first)}:${Math.trunc(+fs1.score_second)}`:'?'}`);
console.log('='.repeat(78));

function analyse(marketName, label){
  const market = block[marketName];
  if(!market) return null;
  console.log(`\n${'#'.repeat(78)}\n# ${label}  ("${marketName}")\n${'#'.repeat(78)}`);
  const best={};
  const rows=[];
  for(const [outcome,books] of Object.entries(market)){
    const entries = (books&&typeof books==='object')?Object.entries(books):[['(single)',books]];
    const prices = entries.map(([b,v])=>[b,Number(v)]).filter(([,v])=>Number.isFinite(v)&&v>1);
    if(!prices.length)continue;
    const bestPrice = Math.max(...prices.map(([,v])=>v));
    const bestBook = prices.find(([,v])=>v===bestPrice)[0];
    best[outcome]=bestPrice;
    rows.push({outcome,bestPrice,bestBook,nBooks:prices.length,implied:1/bestPrice});
  }
  rows.sort((a,b)=>a.bestPrice-b.bestPrice);
  console.log('\n  outcome        best price   best book        implied chance');
  console.log('  ' + '-'.repeat(62));
  let sum=0;
  for(const r of rows){
    sum+=r.implied;
    console.log(`  ${r.outcome.padEnd(14)} ${String(r.bestPrice).padStart(9)}   ${r.bestBook.padEnd(14)}   ${(r.implied*100).toFixed(2).padStart(6)}%`);
  }
  console.log('  ' + '-'.repeat(62));
  console.log(`  ${'TOTAL'.padEnd(14)} ${''.padStart(9)}   ${''.padEnd(14)}   ${(sum*100).toFixed(2).padStart(6)}%`);
  console.log(`\n  Outcomes priced: ${rows.length}`);
  console.log(`  These are ALL the ways this market can end. Real chances MUST add to 100%.`);
  console.log(`  The book's prices add to ${(sum*100).toFixed(2)}%.`);
  console.log(`  >>> THE VIG = ${((sum-1)*100).toFixed(2)}%`);
  console.log(`  >>> You are paying $${sum.toFixed(4)} for $1.00 worth of probability.`);
  console.log(`  >>> Bet every outcome and you are guaranteed to lose ${((1-1/sum)*100).toFixed(2)}% of your stake.`);
  return sum;
}

const csSum = analyse(Object.keys(block).find(n=>/correct score 1st half/i.test(n)), 'THE MARKET YOU WERE BETTING');
const haSum = analyse(Object.keys(block).find(n=>/^home\/away \(1st set\)$/i.test(n)) || Object.keys(block).find(n=>/^home\/away$/i.test(n)), 'A LOW-VIG MARKET FOR CONTRAST');

console.log('\n' + '='.repeat(78));
console.log('SIDE BY SIDE');
console.log('='.repeat(78));
if(csSum&&haSum){
  console.log(`  Correct Score 1st Half : vig ${((csSum-1)*100).toFixed(2)}%   -> must beat market by ${((csSum-1)*100).toFixed(2)}%`);
  console.log(`  Home/Away style market : vig ${((haSum-1)*100).toFixed(2)}%   -> must beat market by ${((haSum-1)*100).toFixed(2)}%`);
  console.log(`\n  Same match. Same knowledge. The tax differs by ${(((csSum-1)/(haSum-1))).toFixed(1)}x.`);
  console.log(`\n  Over 1,000 bets of $100, the vig alone costs you:`);
  console.log(`    correct score : $${((csSum-1)/csSum*100*1000).toFixed(0)}`);
  console.log(`    low-vig market: $${((haSum-1)/haSum*100*1000).toFixed(0)}`);
}
