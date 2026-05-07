import { useEffect, useMemo, useState } from 'react';
import { fetchLiveOpportunities } from '../lib/liveData';
import { calcSlip } from '../lib/probability';
import { useSlipStore, useSlipSummary } from '../store/slipStore';
import type { FirstSetOpportunity, ScoreOutcome, SlipLeg, SlipSummary } from '../types';

interface IQRebuildCardProps {
  compact?: boolean;
}

interface CandidateReplacement {
  opportunity: FirstSetOpportunity;
  outcome: ScoreOutcome;
  leg: SlipLeg;
}

interface WeakLeg {
  leg: SlipLeg;
  ev: number;
  reasons: string[];
}

const LOW_PROBABILITY_THRESHOLD = 0.08;
const WATCHLIST_PROBABILITY_THRESHOLD = 0.12;

function formatAmericanOdds(decimalOdds: number) {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return '+0';
  if (decimalOdds >= 2) return `+${Math.round((decimalOdds - 1) * 100)}`;
  return `${Math.round(-100 / (decimalOdds - 1))}`;
}

function formatDecimalOdds(decimalOdds: number) {
  if (!Number.isFinite(decimalOdds)) return '×0.00';
  return `×${decimalOdds.toFixed(2)}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value: number) {
  if (!Number.isFinite(value)) return '0.0%';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function legExpectedValue(leg: SlipLeg) {
  return leg.modelProbability * leg.odds - 1;
}

function scoreSlip(summary: SlipSummary, legs: SlipLeg[]) {
  if (legs.length === 0) return { grade: 'N/A', score: 0 };
  const setfoxCount = legs.filter((leg) => leg.setfoxPassed).length;
  const legPenalty = Math.max(0, legs.length - 3) * 8;
  const lowProbPenalty = legs.filter((leg) => leg.modelProbability < LOW_PROBABILITY_THRESHOLD).length * 7;
  const raw = 50 + summary.expectedValue * 18 + summary.hitRate * 100 + setfoxCount * 5 - legPenalty - lowProbPenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  return { grade, score };
}

function riskLevel(summary: SlipSummary, legs: SlipLeg[]) {
  if (legs.length === 0) return 'None';
  if (summary.hitRate < 0.01 || legs.length >= 5) return 'Extreme';
  if (summary.hitRate < 0.05 || legs.length >= 4) return 'High';
  if (summary.hitRate < 0.15 || legs.length >= 3) return 'Medium';
  return 'Lower';
}

function buildWeakLegs(legs: SlipLeg[]) {
  const analyzed: WeakLeg[] = legs.map((leg) => {
    const ev = legExpectedValue(leg);
    const reasons: string[] = [];

    if (ev < 0) reasons.push('Negative EV profile');
    if (leg.modelProbability < LOW_PROBABILITY_THRESHOLD) reasons.push('Low model probability');
    else if (leg.modelProbability < WATCHLIST_PROBABILITY_THRESHOLD) reasons.push('Thin hit-rate leg');
    if (leg.sport === 'tennis' && !leg.setfoxPassed) reasons.push('Not a SetFox Strict pass');

    return { leg, ev, reasons };
  });

  const flagged = analyzed.filter((item) => item.reasons.length > 0);
  if (flagged.length > 0) return flagged.sort((a, b) => a.ev - b.ev || a.leg.modelProbability - b.leg.modelProbability);
  return analyzed.sort((a, b) => a.ev - b.ev || a.leg.modelProbability - b.leg.modelProbability).slice(0, 1);
}

function buildWarnings(legs: SlipLeg[], summary: SlipSummary) {
  const warnings: string[] = [];
  const tennisLegs = legs.filter((leg) => leg.sport === 'tennis').length;
  const setfoxPasses = legs.filter((leg) => leg.setfoxPassed).length;

  if (tennisLegs >= 3) warnings.push('Correlation watch: several tennis legs are active. Same-sport slips can move together.');
  if (legs.length >= 5) warnings.push('Leg count is high. More legs usually means lower hit rate.');
  if (summary.hitRate > 0 && summary.hitRate < 0.03) warnings.push('Hit rate is thin. The payout may be higher, but the risk is also higher.');
  if (tennisLegs > 0 && setfoxPasses === 0) warnings.push('No active tennis leg is currently a SetFox Strict pass.');

  return warnings;
}

function findBestSetFoxReplacement(feed: FirstSetOpportunity[], existingLegs: SlipLeg[]): CandidateReplacement | null {
  const existingIds = new Set(existingLegs.map((leg) => leg.id));
  const candidates: CandidateReplacement[] = [];

  for (const opportunity of feed) {
    for (const outcome of opportunity.outcomes) {
      if (!outcome.setfox.passed || !outcome.bookmakerOdds) continue;
      const id = `${opportunity.id}-${outcome.score}`;
      if (existingIds.has(id)) continue;
      candidates.push({
        opportunity,
        outcome,
        leg: {
          id,
          label: `${opportunity.player1} vs ${opportunity.player2} ${outcome.score}`,
          sport: 'tennis',
          odds: outcome.bookmakerOdds,
          modelProbability: outcome.modelProbability,
          eventId: opportunity.id,
          setfoxPassed: true,
          setfoxRuleVersion: outcome.setfox.ruleVersion,
        },
      });
    }
  }

  return candidates.sort((a, b) => {
    const evDiff = (b.outcome.expectedValue ?? -Infinity) - (a.outcome.expectedValue ?? -Infinity);
    if (evDiff !== 0) return evDiff;
    const edgeDiff = (b.outcome.edge ?? -Infinity) - (a.outcome.edge ?? -Infinity);
    if (edgeDiff !== 0) return edgeDiff;
    return b.outcome.modelProbability - a.outcome.modelProbability;
  })[0] ?? null;
}

function buildRebuiltLegs(legs: SlipLeg[], weakLeg: WeakLeg | null, replacement: CandidateReplacement | null) {
  if (!weakLeg || !replacement) return legs;
  return [...legs.filter((leg) => leg.id !== weakLeg.leg.id), replacement.leg];
}

function StaticRebuildCard({ compact }: { compact: boolean }) {
  return (
    <section className={`iq-rebuild-card${compact ? ' is-compact' : ''}`} aria-label="IQ Rebuild odds transformation">
      <div className="rebuild-header">
        <div>
          <p className="eyebrow">SETFOX REBUILD</p>
          <h2>Turn a regular slip into a smarter build.</h2>
        </div>
        <span className="rebuild-risk mono">RISK SHOWN</span>
      </div>

      <div className="odds-transform" aria-label="Base odds rebuilt by SlipIQ">
        <div className="odds-side odds-base">
          <span className="mono">BASE SLIP</span>
          <strong className="mono">+276</strong>
        </div>
        <div className="rebuild-arrow" aria-hidden="true">
          <span />
        </div>
        <div className="odds-side odds-iq">
          <span className="mono">IQ REBUILD</span>
          <strong className="mono">+356</strong>
        </div>
      </div>

      <div className="rebuild-stats">
        <div>
          <span>Model hit rate</span>
          <strong className="mono">18.4%</strong>
        </div>
        <div>
          <span>Build type</span>
          <strong className="mono">BALANCED</strong>
        </div>
        <div>
          <span>Added edge</span>
          <strong className="mono positive-text">+2.1%</strong>
        </div>
      </div>

      {!compact ? (
        <p className="rebuild-note">
          SlipIQ doesn&apos;t promise magic. It shows the tradeoff between payout, hit rate, and pricing edge — so you can rebuild a slip with more logic.
        </p>
      ) : null}
    </section>
  );
}

function DynamicRebuildCard() {
  const { legs, stake, addLeg, removeLeg } = useSlipStore();
  const originalSummary = useSlipSummary();
  const [feed, setFeed] = useState<FirstSetOpportunity[]>([]);
  const [feedState, setFeedState] = useState<'loading' | 'live' | 'empty'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchLiveOpportunities()
      .then((live) => {
        if (!cancelled) {
          setFeed(live?.opportunities ?? []);
          setFeedState(live?.opportunities?.length ? 'live' : 'empty');
        }
      })
      .catch(() => {
        if (!cancelled) setFeedState('empty');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const rebuild = useMemo(() => {
    const weakLegs = buildWeakLegs(legs);
    const primaryWeakLeg = weakLegs[0] ?? null;
    const replacement = findBestSetFoxReplacement(feed, legs);
    const rebuiltLegs = buildRebuiltLegs(legs, primaryWeakLeg, replacement);
    const rebuiltSummary = calcSlip(rebuiltLegs, stake);
    const originalGrade = scoreSlip(originalSummary, legs);
    const rebuiltGrade = scoreSlip(rebuiltSummary, rebuiltLegs);
    const warnings = buildWarnings(legs, originalSummary);

    return {
      weakLegs,
      primaryWeakLeg,
      replacement,
      rebuiltLegs,
      rebuiltSummary,
      originalGrade,
      rebuiltGrade,
      warnings,
      originalRisk: riskLevel(originalSummary, legs),
      rebuiltRisk: riskLevel(rebuiltSummary, rebuiltLegs),
      changedLegs: primaryWeakLeg && replacement ? 1 : 0,
    };
  }, [feed, legs, originalSummary, stake]);

  const applyRebuild = () => {
    if (!rebuild.primaryWeakLeg || !rebuild.replacement) return;
    removeLeg(rebuild.primaryWeakLeg.leg.id);
    addLeg(rebuild.replacement.leg);
  };

  if (legs.length === 0) {
    return (
      <section className="iq-rebuild-card" aria-label="IQ Rebuild V1 empty state">
        <div className="rebuild-header">
          <div>
            <p className="eyebrow">IQ REBUILD V1</p>
            <h2>Build a slip first. Then SlipIQ will grade and rebuild it.</h2>
          </div>
          <span className="rebuild-risk mono">RESEARCH MODE</span>
        </div>
        <p className="rebuild-note">
          Add legs from Home or First Set Lab. IQ Rebuild will identify weak legs, compare before/after risk, and only suggest SetFox Strict replacements when the scanner finds one.
        </p>
      </section>
    );
  }

  const hasReplacement = Boolean(rebuild.replacement && rebuild.primaryWeakLeg);

  return (
    <section className="iq-rebuild-card iq-rebuild-v1" aria-label="IQ Rebuild V1 slip analysis">
      <div className="rebuild-header">
        <div>
          <p className="eyebrow">IQ REBUILD V1 · RESEARCH MODE</p>
          <h2>Before vs after for your current slip.</h2>
        </div>
        <span className="rebuild-risk mono">NO GUARANTEES</span>
      </div>

      <div className="odds-transform" aria-label="Original slip compared with SlipIQ rebuild">
        <div className="odds-side odds-base">
          <span className="mono">ORIGINAL SLIP</span>
          <strong className="mono">{formatAmericanOdds(originalSummary.combinedOdds)}</strong>
          <p className="rebuild-mini-copy">Grade {rebuild.originalGrade.grade} · {rebuild.originalRisk} risk</p>
        </div>
        <div className="rebuild-arrow" aria-hidden="true">
          <span />
        </div>
        <div className="odds-side odds-iq">
          <span className="mono">SLIPIQ REBUILD</span>
          <strong className="mono">{formatAmericanOdds(rebuild.rebuiltSummary.combinedOdds)}</strong>
          <p className="rebuild-mini-copy">Grade {rebuild.rebuiltGrade.grade} · {rebuild.rebuiltRisk} risk</p>
        </div>
      </div>

      <div className="rebuild-stats">
        <div>
          <span>Original hit rate</span>
          <strong className="mono">{formatPercent(originalSummary.hitRate)}</strong>
        </div>
        <div>
          <span>Rebuilt hit rate</span>
          <strong className="mono">{formatPercent(rebuild.rebuiltSummary.hitRate)}</strong>
        </div>
        <div>
          <span>EV change</span>
          <strong className={`mono ${rebuild.rebuiltSummary.expectedValue >= originalSummary.expectedValue ? 'positive-text' : ''}`}>
            {formatSignedPercent(rebuild.rebuiltSummary.expectedValue - originalSummary.expectedValue)}
          </strong>
        </div>
      </div>

      <div className="iq-rebuild-grid">
        <article className="rebuild-panel">
          <p className="eyebrow">Original slip</p>
          <h3>{legs.length} legs · {formatDecimalOdds(originalSummary.combinedOdds)}</h3>
          <p>EV {formatSignedPercent(originalSummary.expectedValue)} · Hit rate {formatPercent(originalSummary.hitRate)}</p>
        </article>
        <article className="rebuild-panel">
          <p className="eyebrow">SlipIQ rebuild</p>
          <h3>{rebuild.rebuiltLegs.length} legs · {formatDecimalOdds(rebuild.rebuiltSummary.combinedOdds)}</h3>
          <p>{rebuild.changedLegs} leg changed · {rebuild.rebuiltRisk} risk</p>
        </article>
      </div>

      <div className="rebuild-section">
        <p className="eyebrow">Weak-leg scan</p>
        <div className="rebuild-list">
          {rebuild.weakLegs.slice(0, 3).map((item) => (
            <div key={item.leg.id} className="rebuild-list-row">
              <span>{item.leg.label}</span>
              <strong className="mono">{item.reasons.join(' · ') || `EV ${formatSignedPercent(item.ev)}`}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="rebuild-section">
        <p className="eyebrow">Replacement logic</p>
        {hasReplacement && rebuild.replacement ? (
          <div className="rebuild-replacement-card">
            <span className="mono">SETFOX STRICT REPLACEMENT</span>
            <strong>{rebuild.replacement.leg.label}</strong>
            <p>
              Odds {formatDecimalOdds(rebuild.replacement.leg.odds)} · Model {formatPercent(rebuild.replacement.leg.modelProbability)} · EV {formatSignedPercent(rebuild.replacement.outcome.expectedValue ?? 0)}
            </p>
            <button className="button button-gold" type="button" onClick={applyRebuild}>
              Apply rebuild
            </button>
          </div>
        ) : (
          <p className="rebuild-note">
            {feedState === 'loading'
              ? 'Checking live SetFox Strict replacements...'
              : 'No SetFox Strict replacement right now. Scanner is protecting you from weak markets.'}
          </p>
        )}
      </div>

      {rebuild.warnings.length > 0 ? (
        <div className="rebuild-section">
          <p className="eyebrow">Risk warnings</p>
          <ul className="rebuild-warning-list">
            {rebuild.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rebuild-share-preview">
        <p className="eyebrow">Share-card preview</p>
        <strong className="mono">Before: {formatAmericanOdds(originalSummary.combinedOdds)} → After: {formatAmericanOdds(rebuild.rebuiltSummary.combinedOdds)}</strong>
        <span>Risk changed: {rebuild.originalRisk} → {rebuild.rebuiltRisk}</span>
        <span>Research Mode · No guarantees</span>
      </div>
    </section>
  );
}

export default function IQRebuildCard({ compact = false }: IQRebuildCardProps) {
  if (compact) return <StaticRebuildCard compact />;
  return <DynamicRebuildCard />;
}
