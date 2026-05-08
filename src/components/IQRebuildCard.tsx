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

type RebuildMode = 'safer' | 'balanced' | 'moonshot';

type RebuildAction = 'hold' | 'apply';

interface RebuildPlan {
  mode: RebuildMode;
  title: string;
  summaryLabel: string;
  explanation: string;
  rebuiltLegs: SlipLeg[];
  summary: SlipSummary;
  changedLegs: number;
  action: RebuildAction;
  actionLabel: string;
  reason: string;
  removedLeg?: SlipLeg;
  addedLeg?: SlipLeg;
  notes: string[];
}

const LOW_PROBABILITY_THRESHOLD = 0.08;
const WATCHLIST_PROBABILITY_THRESHOLD = 0.12;

const MODE_COPY: Record<RebuildMode, { label: string; short: string; tone: string }> = {
  safer: {
    label: 'Safer',
    short: 'Higher hit-rate profile. Usually trims risk and lowers payout.',
    tone: 'HIT RATE',
  },
  balanced: {
    label: 'Balanced',
    short: 'Best all-around rebuild. Replaces weak legs only when SetFox finds a strict fit.',
    tone: 'SMARTER SLIP',
  },
  moonshot: {
    label: 'Moonshot',
    short: 'Higher payout profile. Only adds upside when a strict replacement exists.',
    tone: 'HIGH RISK',
  },
};

function formatAmericanOdds(decimalOdds: number) {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return '+0';
  const american = decimalOdds >= 2 ? Math.round((decimalOdds - 1) * 100) : Math.round(-100 / (decimalOdds - 1));
  const formatted = Math.abs(american).toLocaleString();
  return american >= 0 ? `+${formatted}` : `-${formatted}`;
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

function makePlan({
  mode,
  legs,
  stake,
  weakLeg,
  replacement,
}: {
  mode: RebuildMode;
  legs: SlipLeg[];
  stake: number;
  weakLeg: WeakLeg | null;
  replacement: CandidateReplacement | null;
}): RebuildPlan {
  const holdPlan = (reason: string, notes: string[] = []): RebuildPlan => ({
    mode,
    title: `${MODE_COPY[mode].label} Rebuild`,
    summaryLabel: 'Held',
    explanation: MODE_COPY[mode].short,
    rebuiltLegs: legs,
    summary: calcSlip(legs, stake),
    changedLegs: 0,
    action: 'hold',
    actionLabel: 'No change available',
    reason,
    notes,
  });

  if (mode === 'safer') {
    if (!weakLeg || legs.length <= 1) {
      return holdPlan('No safer trim available. Add at least two legs before Safer mode can reduce risk.', [
        'Safer mode improves hit-rate profile by trimming the weakest leg, not by forcing a new pick.',
      ]);
    }

    const rebuiltLegs = legs.filter((leg) => leg.id !== weakLeg.leg.id);
    return {
      mode,
      title: 'Safer Rebuild',
      summaryLabel: 'Trim risk',
      explanation: MODE_COPY.safer.short,
      rebuiltLegs,
      summary: calcSlip(rebuiltLegs, stake),
      changedLegs: 1,
      action: 'apply',
      actionLabel: 'Apply safer trim',
      reason: 'Removes the weakest leg to raise the model hit-rate profile. Payout usually drops.',
      removedLeg: weakLeg.leg,
      notes: ['Higher hit-rate profile', 'Lower payout tradeoff', 'No replacement forced'],
    };
  }

  if (mode === 'balanced') {
    if (!weakLeg || !replacement) {
      return holdPlan('No SetFox Strict replacement right now. Scanner is protecting you from weak markets.', [
        'Balanced mode only rebuilds when SetFox Strict finds a replacement.',
      ]);
    }

    const rebuiltLegs = [...legs.filter((leg) => leg.id !== weakLeg.leg.id), replacement.leg];
    return {
      mode,
      title: 'Balanced Rebuild',
      summaryLabel: 'Replace weak leg',
      explanation: MODE_COPY.balanced.short,
      rebuiltLegs,
      summary: calcSlip(rebuiltLegs, stake),
      changedLegs: 1,
      action: 'apply',
      actionLabel: 'Apply balanced rebuild',
      reason: 'Replaces the weakest leg with the best available SetFox Strict candidate.',
      removedLeg: weakLeg.leg,
      addedLeg: replacement.leg,
      notes: ['Best all-around profile', 'Strict replacement only', 'Research Mode'],
    };
  }

  if (!replacement) {
    return holdPlan('No Moonshot rebuild available. SlipIQ will not add random longshot legs without a SetFox Strict candidate.', [
      'Moonshot mode needs a strict candidate before it can raise payout.',
    ]);
  }

  if (legs.length <= 3) {
    const rebuiltLegs = [...legs, replacement.leg];
    return {
      mode,
      title: 'Moonshot Rebuild',
      summaryLabel: 'Add upside',
      explanation: MODE_COPY.moonshot.short,
      rebuiltLegs,
      summary: calcSlip(rebuiltLegs, stake),
      changedLegs: 1,
      action: 'apply',
      actionLabel: 'Apply moonshot add-on',
      reason: 'Adds one SetFox Strict leg for higher payout, with lower expected hit rate.',
      addedLeg: replacement.leg,
      notes: ['Higher payout profile', 'Lower hit-rate tradeoff', 'High risk'],
    };
  }

  if (!weakLeg) {
    return holdPlan('No weak leg was available to replace for Moonshot mode.', ['High-risk mode was held.']);
  }

  const rebuiltLegs = [...legs.filter((leg) => leg.id !== weakLeg.leg.id), replacement.leg];
  return {
    mode,
    title: 'Moonshot Rebuild',
    summaryLabel: 'Swap for upside',
    explanation: MODE_COPY.moonshot.short,
    rebuiltLegs,
    summary: calcSlip(rebuiltLegs, stake),
    changedLegs: 1,
    action: 'apply',
    actionLabel: 'Apply moonshot swap',
    reason: 'Swaps the weakest leg for a SetFox Strict candidate with upside. Risk remains high.',
    removedLeg: weakLeg.leg,
    addedLeg: replacement.leg,
    notes: ['Higher payout profile', 'High risk', 'Strict candidate only'],
  };
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
  const [selectedMode, setSelectedMode] = useState<RebuildMode>('balanced');

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
    const plan = makePlan({ mode: selectedMode, legs, stake, weakLeg: primaryWeakLeg, replacement });
    const originalGrade = scoreSlip(originalSummary, legs);
    const rebuiltGrade = scoreSlip(plan.summary, plan.rebuiltLegs);
    const warnings = buildWarnings(legs, originalSummary);

    return {
      weakLegs,
      primaryWeakLeg,
      replacement,
      plan,
      originalGrade,
      rebuiltGrade,
      warnings,
      originalRisk: riskLevel(originalSummary, legs),
      rebuiltRisk: riskLevel(plan.summary, plan.rebuiltLegs),
    };
  }, [feed, legs, originalSummary, selectedMode, stake]);

  const applyRebuild = () => {
    if (rebuild.plan.action !== 'apply') return;
    if (rebuild.plan.removedLeg) removeLeg(rebuild.plan.removedLeg.id);
    if (rebuild.plan.addedLeg) addLeg(rebuild.plan.addedLeg);
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
          Add legs from Home or First Set Lab. IQ Rebuild will identify weak legs, compare safer/balanced/moonshot paths, and only suggest SetFox Strict replacements when the scanner finds one.
        </p>
      </section>
    );
  }

  const plan = rebuild.plan;
  const planHeld = plan.action === 'hold';
  const evChange = plan.summary.expectedValue - originalSummary.expectedValue;
  const hitRateChange = plan.summary.hitRate - originalSummary.hitRate;

  return (
    <section className="iq-rebuild-card iq-rebuild-v1" aria-label="IQ Rebuild V1 slip analysis">
      <div className="rebuild-header">
        <div>
          <p className="eyebrow">IQ REBUILD V1 · RESEARCH MODE</p>
          <h2>Choose your rebuild path.</h2>
        </div>
        <span className="rebuild-risk mono">NO GUARANTEES</span>
      </div>

      <div className="rebuild-mode-selector" role="group" aria-label="Choose rebuild mode">
        {(Object.keys(MODE_COPY) as RebuildMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`rebuild-mode-button ${selectedMode === mode ? 'is-active' : ''}`}
            onClick={() => setSelectedMode(mode)}
          >
            <span className="mono">{MODE_COPY[mode].label}</span>
            <small>{MODE_COPY[mode].tone}</small>
          </button>
        ))}
      </div>

      <p className="rebuild-mode-copy">{plan.explanation}</p>

      <div className={`odds-transform ${planHeld ? 'is-held' : ''}`} aria-label="Original slip compared with selected SlipIQ rebuild">
        <div className="odds-side odds-base">
          <span className="mono">ORIGINAL SLIP</span>
          <strong className="mono">{formatAmericanOdds(originalSummary.combinedOdds)}</strong>
          <p className="rebuild-mini-copy">Grade {rebuild.originalGrade.grade} · {rebuild.originalRisk} risk</p>
        </div>
        <div className="rebuild-arrow" aria-hidden="true">
          <span />
        </div>
        <div className="odds-side odds-iq">
          <span className="mono">{planHeld ? 'REBUILD HELD' : plan.title.toUpperCase()}</span>
          <strong className="mono">{planHeld ? 'HELD' : formatAmericanOdds(plan.summary.combinedOdds)}</strong>
          <p className="rebuild-mini-copy">{plan.summaryLabel} · {rebuild.rebuiltRisk} risk</p>
        </div>
      </div>

      <div className="rebuild-stats">
        <div>
          <span>Original hit rate</span>
          <strong className="mono">{formatPercent(originalSummary.hitRate)}</strong>
        </div>
        <div>
          <span>{planHeld ? 'Held hit rate' : 'Rebuilt hit rate'}</span>
          <strong className="mono">{formatPercent(plan.summary.hitRate)}</strong>
        </div>
        <div>
          <span>{selectedMode === 'safer' ? 'Hit-rate change' : 'EV change'}</span>
          <strong className={`mono ${selectedMode === 'safer' ? hitRateChange >= 0 ? 'positive-text' : '' : evChange >= 0 ? 'positive-text' : ''}`}>
            {selectedMode === 'safer' ? formatSignedPercent(hitRateChange) : formatSignedPercent(evChange)}
          </strong>
        </div>
      </div>

      <div className="iq-rebuild-grid">
        <article className="rebuild-panel">
          <p className="eyebrow">Original slip</p>
          <h3>{legs.length} legs · {formatDecimalOdds(originalSummary.combinedOdds)}</h3>
          <p>EV {formatSignedPercent(originalSummary.expectedValue)} · Hit rate {formatPercent(originalSummary.hitRate)}</p>
        </article>
        <article className={`rebuild-panel ${planHeld ? 'is-held' : ''}`}>
          <p className="eyebrow">{plan.title}</p>
          <h3>{planHeld ? 'Held · no forced change' : `${plan.rebuiltLegs.length} legs · ${formatDecimalOdds(plan.summary.combinedOdds)}`}</h3>
          <p>{plan.changedLegs} leg changed · {rebuild.rebuiltRisk} risk</p>
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
        <p className="eyebrow">{MODE_COPY[selectedMode].label} logic</p>
        {planHeld ? (
          <div className="rebuild-replacement-card is-held">
            <span className="mono">NO SAFE REBUILD AVAILABLE RIGHT NOW</span>
            <strong>{plan.reason}</strong>
            <p>
              {feedState === 'loading'
                ? 'Still checking live SetFox Strict replacements...'
                : 'SlipIQ held the slip instead of forcing a low-quality change.'}
            </p>
          </div>
        ) : (
          <div className="rebuild-replacement-card">
            <span className="mono">{MODE_COPY[selectedMode].label.toUpperCase()} PLAN</span>
            <strong>{plan.reason}</strong>
            {plan.removedLeg ? <p>Remove: {plan.removedLeg.label}</p> : null}
            {plan.addedLeg ? <p>Add: {plan.addedLeg.label} · {formatDecimalOdds(plan.addedLeg.odds)} · {formatPercent(plan.addedLeg.modelProbability)}</p> : null}
            <button className="button button-gold" type="button" onClick={applyRebuild}>
              {plan.actionLabel}
            </button>
          </div>
        )}
        {plan.notes.length > 0 ? (
          <div className="rebuild-note-pills">
            {plan.notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </div>
        ) : null}
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
        <strong className="mono">
          {planHeld
            ? `Original: ${formatAmericanOdds(originalSummary.combinedOdds)} · Rebuild: Held`
            : `Before: ${formatAmericanOdds(originalSummary.combinedOdds)} → After: ${formatAmericanOdds(plan.summary.combinedOdds)}`}
        </strong>
        <span>Risk changed: {rebuild.originalRisk} → {rebuild.rebuiltRisk}</span>
        <span>{planHeld ? 'Reason: No SetFox Strict replacement' : `${MODE_COPY[selectedMode].label} mode · ${plan.changedLegs} leg changed`}</span>
        <span>Research Mode · No guarantees</span>
      </div>
    </section>
  );
}

export default function IQRebuildCard({ compact = false }: IQRebuildCardProps) {
  if (compact) return <StaticRebuildCard compact />;
  return <DynamicRebuildCard />;
}
