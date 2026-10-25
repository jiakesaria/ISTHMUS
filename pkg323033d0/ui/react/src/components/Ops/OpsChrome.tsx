/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import './ops.css';

/**
 * The instruments that float over the control-room map.
 *
 * These are intentionally tiny and presentational. They own the *look* of the
 * night-ops surface — glass, hairline borders, monospace readouts — and nothing
 * else; every number they display is handed to them by a page that fetched it from
 * the C3 backend.
 */

export interface GlassPanelProps {
  /**
   * The question this panel answers, shown as its top line. The control room follows
   * "one question per screen", so a panel that cannot state its question in a few
   * words is usually two panels.
   */
  title?: string;
  /** Optional right-aligned content on the title row — a count, a toggle, a chip. */
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/** A floating glass instrument. Not a card: it sits *over* the map, never beside it. */
export function GlassPanel({ title, action, children, className }: GlassPanelProps) {
  return (
    <div className={cn('ops-panel px-3.5 py-3', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex items-center justify-between gap-3">
          {title && <span className="ops-label">{title}</span>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/** Semantic colours a readout can take. Maps onto the four variables in `ops.css`. */
export type ReadoutTone = 'plain' | 'accent' | 'clear' | 'slow' | 'blocked';

const TONE_VAR: Record<ReadoutTone, string> = {
  plain: 'var(--ops-fg)',
  accent: 'var(--ops-accent)',
  clear: 'var(--ops-clear)',
  slow: 'var(--ops-slow)',
  blocked: 'var(--ops-blocked)',
};

export interface ReadoutProps {
  /** What is being measured, in plain English — "Avg ambulance response", not "ART". */
  label: string;
  /** The measurement. `null` renders a dash rather than a zero, which would be a lie. */
  value: number | null;
  /** Decimal places. Counts use 0; minutes use 1. */
  decimals?: number;
  /** Unit suffix rendered smaller and dimmer beside the number ("min", "%", "km"). */
  unit?: string;
  tone?: ReadoutTone;
  /** Tailwind font-size class for the number. Defaults to a mid-size instrument. */
  sizeClass?: string;
  /** A short clarifier under the number — scope, caveat, or where it came from. */
  footnote?: string;
  className?: string;
}

/**
 * A big monospace number that **counts** to its value instead of snapping to it.
 *
 * The animation is not decoration: when a road closes and the response time moves
 * from 6.2 to 14.8, watching the digits climb is what makes the cost legible. A
 * swapped value reads as a different screen; a counting value reads as a consequence.
 *
 * The tween writes `textContent` straight to the DOM node on each frame rather than
 * calling `setState`, so a 700 ms count does not push ~40 React renders through a
 * page that also holds a live MapLibre canvas.
 */
export function Readout({
  label,
  value,
  decimals = 0,
  unit,
  tone = 'plain',
  sizeClass = 'text-[26px]',
  footnote,
  className,
}: ReadoutProps) {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  /** The value currently displayed, so a change tweens from where the eye last was. */
  const shownRef = useRef<number | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const format = (n: number) => n.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    if (value === null || !Number.isFinite(value)) {
      node.textContent = '—';
      shownRef.current = null;
      return;
    }

    const from = shownRef.current;
    /* First paint, or arriving from "no value": show it immediately. There is no
     * prior reading to count away from, and animating up from zero on load would
     * imply a change that never happened. */
    if (from === null) {
      node.textContent = format(value);
      shownRef.current = value;
      return;
    }
    if (from === value) {
      node.textContent = format(value);
      return;
    }

    const target = value;
    const duration = 700;
    const start = performance.now();
    let frame = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      /* easeOutCubic: fast commitment, soft landing — reads as an instrument settling. */
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      node.textContent = format(current);
      if (t < 1) {
        frame = requestAnimationFrame(step);
      } else {
        shownRef.current = target;
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, decimals]);

  return (
    <div className={className}>
      <div className="ops-label mb-1.5">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          ref={nodeRef}
          className={cn('ops-num font-semibold', sizeClass)}
          style={{ color: TONE_VAR[tone] }}
        />
        {unit && (
          <span className="ops-num text-[11px] font-medium" style={{ color: 'var(--ops-fg-faint)' }}>
            {unit}
          </span>
        )}
      </div>
      {footnote && <div className="mt-1.5 text-[10.5px] leading-snug text-[var(--ops-fg-faint)]">{footnote}</div>}
    </div>
  );
}

/**
 * The traffic key. Every entry carries its own words, because a legend you have to
 * explain out loud is a legend that failed.
 */
export const TRAFFIC_LEGEND: { tone: ReadoutTone; label: string }[] = [
  { tone: 'clear', label: 'Moving normally' },
  { tone: 'slow', label: 'Slower than usual' },
  { tone: 'blocked', label: 'Jammed or closed' },
  { tone: 'plain', label: 'No traffic data' },
];

export function TrafficLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {TRAFFIC_LEGEND.map((entry) => (
        <div key={entry.label} className="flex items-center gap-2.5">
          <span
            className="ops-swatch"
            style={{ color: entry.tone === 'plain' ? 'var(--ops-neutral)' : TONE_VAR[entry.tone] }}
          />
          <span className="text-[11px] text-[var(--ops-fg-dim)]">{entry.label}</span>
        </div>
      ))}
    </div>
  );
}

export interface ScenarioSwitchOption {
  id: string;
  /** What the operator is choosing, in their words — not the scenario's row id. */
  label: string;
  /** Tone of the indicator when this option is live. */
  tone?: ReadoutTone;
}

/**
 * The one control that changes what the whole screen is about: which set of
 * conditions the city is running under.
 *
 * Deliberately a two-state switch and not a dropdown. A dropdown implies a catalogue
 * to browse and hides the comparison; a switch states that there are exactly two
 * things worth looking at — the city as it normally runs, and the city tonight — and
 * invites flipping between them, which is where the whole finding lives.
 */
export function ScenarioSwitch({
  options,
  value,
  onChange,
  busy = false,
}: {
  options: ScenarioSwitchOption[];
  value: string;
  onChange: (id: string) => void;
  /** Dims the control while the backend is re-solving, without moving anything. */
  busy?: boolean;
}) {
  return (
    <div className={cn('ops-switch', busy && 'ops-switch--busy')} role="group" aria-label="Conditions">
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            className={cn('ops-switch__opt', active && 'ops-switch__opt--on')}
            aria-pressed={active}
            onClick={() => onChange(opt.id)}
            style={active ? { color: TONE_VAR[opt.tone ?? 'accent'] } : undefined}
          >
            <span
              className="ops-switch__dot"
              style={active ? { background: TONE_VAR[opt.tone ?? 'accent'], boxShadow: `0 0 8px ${TONE_VAR[opt.tone ?? 'accent']}` } : undefined}
            />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled before → after pair. The arrow is doing the work: two numbers side by
 * side invite the reader to find the comparison themselves, which most will not do.
 */
export function Delta({
  label,
  before,
  after,
  unit,
  decimals = 0,
  afterTone = 'blocked',
  footnote,
}: {
  label: string;
  before: number | null;
  after: number | null;
  unit?: string;
  decimals?: number;
  afterTone?: ReadoutTone;
  footnote?: string;
}) {
  const fmt = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(decimals));
  return (
    <div>
      <div className="ops-label mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="ops-num text-[15px]" style={{ color: 'var(--ops-fg-dim)' }}>
          {fmt(before)}
        </span>
        <span className="text-[11px] text-[var(--ops-fg-faint)]">→</span>
        <span className="ops-num text-[22px] font-semibold" style={{ color: TONE_VAR[afterTone] }}>
          {fmt(after)}
        </span>
        {unit && (
          <span className="ops-num text-[10.5px]" style={{ color: 'var(--ops-fg-faint)' }}>
            {unit}
          </span>
        )}
      </div>
      {footnote && <div className="mt-1.5 text-[10.5px] leading-snug text-[var(--ops-fg-faint)]">{footnote}</div>}
    </div>
  );
}

export interface DataChipProps {
  /** What the chip says, e.g. "Real OSM network + modelled traffic". */
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}

/**
 * The honesty chip. It states, in the corner of every screen, how much of what you
 * are looking at is measured and how much is modelled — and opens the full provenance
 * page when clicked. Volunteering the limits of the data is what makes the rest of
 * the numbers credible.
 */
export function DataChip({ children, onClick, title }: DataChipProps) {
  return (
    <button type="button" className="ops-chip" onClick={onClick} title={title}>
      <span className="ops-chip__dot" />
      {children}
    </button>
  );
}

/**
 * The single sentence at the top of the screen that says what you are looking at:
 * conditions, time, and what is currently broken. If a judge reads only one line on
 * the page, this is the one that has to make sense.
 */
export function StatusLine({
  headline,
  detail,
  tone = 'accent',
}: {
  headline: string;
  detail?: string;
  tone?: ReadoutTone;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className="mt-[5px] size-[7px] flex-none rounded-full"
        style={{ background: TONE_VAR[tone], boxShadow: `0 0 10px ${TONE_VAR[tone]}` }}
      />
      <div>
        <div className="text-[13px] font-medium leading-snug text-[var(--ops-fg)]">{headline}</div>
        {detail && <div className="mt-1 text-[11px] leading-snug text-[var(--ops-fg-dim)]">{detail}</div>}
      </div>
    </div>
  );
}
