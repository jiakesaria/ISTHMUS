/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useErrorReporter } from '@/components/ErrorBoundary/ErrorBoundary';
import IsthmusMap3D, { type MapBounds, type MapCrowdZone, type MapFocus } from '@/components/Map/IsthmusMap3D';
import { GlassPanel, Readout, ScenarioSwitch, TrafficLegend } from '@/components/Ops/OpsChrome';
import type {
  EmsStation,
  Hospital,
  MapNetworkDto,
  NetworkLine,
  ResponsePlan,
  ScenarioDetail,
  ScenarioImpactDto,
  SceneBuilding,
  Venue,
} from '@/Interfaces';
import {
  BASELINE_SCENARIO_ID,
  GAMEDAY_FLOOD_SCENARIO_ID,
  RESPONSE_LEG_COLOR,
  TRANSPORT_LEG_COLOR,
  fetchHospitals,
  fetchMapBuildings,
  fetchMapNetwork,
  fetchScenarioDetail,
  fetchScenarioImpact,
  fetchStations,
  fetchVenues,
  formatDuration,
  parseNetworkLines,
  parseSceneBuildings,
  requestResponsePlan,
} from '@/lib/isthmus';

/** One scenario's network payload, kept so that flipping back is instant. */
interface NetworkBundle {
  dto: MapNetworkDto;
  lines: NetworkLine[];
}

/** Where the incident is, and what the viewer called it when they placed it. */
interface Incident {
  latitude: number;
  longitude: number;
  label: string;
}

/**
 * How long the camera dives onto a freshly-placed incident before pulling back to
 * frame the journey. The solve usually returns faster than this, so the plan is held
 * until the dive lands: starting the route animation mid-dive would mean the viewer
 * never sees the ambulance leave.
 */
const DIVE_MS = 1300;

function decodeGeometry(geometry: string | undefined | null): [number, number][] | null {
  if (!geometry) return null;
  try {
    return JSON.parse(geometry) as [number, number][];
  } catch {
    return null;
  }
}

/**
 * ISTHMUS Operations — the control room.
 *
 * The page does one thing: **pick a point, see who comes and where they take you.**
 * Click any street or any stadium and the camera dives onto it, the backend solves the
 * nearest responding station and the fastest reachable emergency room, and both legs
 * are drawn and driven while the camera pulls back far enough to show the whole trip.
 *
 * The conditions switch top left is the other half of the idea. The same click under
 * *Normal conditions* and under *Post-game + flood* produces two different answers —
 * at Camp Randall the destination hospital itself changes, because the flood puts the
 * nearer ER on the far side of a closed causeway. That comparison is the demonstration;
 * everything else on screen is deliberately kept small so it cannot distract from it.
 *
 * Every number here comes from the C3 backend — geometry and street names from
 * OpenStreetMap, travel times from `EmsRouter.respond`, the city-wide averages from
 * `EmsRouter.scenarioImpact`, the conditions from the scenario's own overlay rows.
 * Nothing is computed in the browser except the animation, and anything modelled rather
 * than measured says so in words.
 */
export default function Ops() {
  const { reportError } = useErrorReporter();

  /* --- scene data, independent of scenario --- */
  const [buildings, setBuildings] = useState<SceneBuilding[] | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [stations, setStations] = useState<EmsStation[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* --- scenario state --- */
  const [scenarioId, setScenarioId] = useState<string>(BASELINE_SCENARIO_ID);
  const [bundle, setBundle] = useState<NetworkBundle | null>(null);
  const [impact, setImpact] = useState<ScenarioImpactDto | null>(null);
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [busy, setBusy] = useState(false);

  /* --- the dispatch --- */
  const [incident, setIncident] = useState<Incident | null>(null);
  const [plan, setPlan] = useState<ResponsePlan | null>(null);
  const [solving, setSolving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  /** Both scenarios' payloads, so the switch does not re-pay a 700 KB fetch. */
  const cacheRef = useRef<Record<string, NetworkBundle>>({});
  /** Guards against a slow solve landing after a newer click has replaced it. */
  const reqIdRef = useRef(0);
  const dwellTimerRef = useRef<number | null>(null);

  /* --- camera --- */
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [frameToken, setFrameToken] = useState(0);

  const underScenario = scenarioId === GAMEDAY_FLOOD_SCENARIO_ID;

  /*
   * The control room is a dark surface, so the surrounding app chrome has to be dark
   * too — a light top bar above a near-black map looks like two applications stacked.
   * Restored on exit so the workbench pages come back in the user's chosen theme.
   */
  useEffect(() => {
    const html = document.documentElement;
    const wasDark = html.classList.contains('dark');
    html.classList.add('dark');
    return () => {
      if (!wasDark) html.classList.remove('dark');
    };
  }, []);

  /* --- first load: the baseline city --- */
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchMapNetwork(BASELINE_SCENARIO_ID),
      fetchMapBuildings(),
      fetchHospitals(),
      fetchStations(),
      fetchVenues(),
      fetchScenarioDetail(GAMEDAY_FLOOD_SCENARIO_ID),
    ])
      .then(([net, blds, hosp, stns, vens, scn]) => {
        if (cancelled) return;
        const base: NetworkBundle = { dto: net, lines: parseNetworkLines(net.linesJson) };
        cacheRef.current[BASELINE_SCENARIO_ID] = base;
        setBundle(base);
        setBuildings(parseSceneBuildings(blds.buildingsJson));
        setHospitals(hosp);
        setStations(stns);
        setVenues(vens);
        setDetail(scn);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(String(err));
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  /*
   * Warm the scenario in the background once the baseline is on screen: a 700 KB
   * network payload plus twenty-two Dijkstra searches, done while nobody is waiting,
   * is what lets the switch feel like flipping a light rather than submitting a form.
   * Failures are swallowed on purpose — nothing has been asked for yet, and the real
   * switch below reports properly if it still fails then.
   */
  useEffect(() => {
    if (!bundle || cacheRef.current[GAMEDAY_FLOOD_SCENARIO_ID]) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetchMapNetwork(GAMEDAY_FLOOD_SCENARIO_ID)
        .then((net) => {
          if (cancelled) return;
          cacheRef.current[GAMEDAY_FLOOD_SCENARIO_ID] = { dto: net, lines: parseNetworkLines(net.linesJson) };
        })
        .catch(() => undefined);
      fetchScenarioImpact(GAMEDAY_FLOOD_SCENARIO_ID)
        .then((imp) => {
          if (!cancelled) setImpact(imp);
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bundle]);

  useEffect(
    () => () => {
      if (dwellTimerRef.current !== null) window.clearTimeout(dwellTimerRef.current);
    },
    [],
  );

  /** Camp Randall, taken from the loaded Venue rows rather than typed in here. */
  const stadium = useMemo(
    () => venues.find((v) => (v.name ?? '').toLowerCase().includes('camp randall')) ?? null,
    [venues],
  );

  /**
   * Place an incident and solve it.
   *
   * The scenario is passed in rather than read from state because the one caller that
   * matters — flipping the conditions switch with an incident already on the map —
   * needs to solve against the scenario it is moving *to*, not the one React has not
   * re-rendered out of yet.
   */
  const dispatchTo = useCallback(
    (latitude: number, longitude: number, label: string, scnId: string) => {
      const myReq = ++reqIdRef.current;
      if (dwellTimerRef.current !== null) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = null;
      }

      setIncident({ latitude, longitude, label });
      setPlan(null);
      setPlanError(null);
      setSolving(true);

      // Step one of the camera move: dive onto the point that was just clicked.
      setFocus({ latitude, longitude, zoom: 16.1, pitch: 64 });
      setFocusToken((t) => t + 1);

      const startedAt = performance.now();
      requestResponsePlan(latitude, longitude, scnId)
        .then((p) => {
          if (myReq !== reqIdRef.current) return;
          // Hold the result until the dive has landed, so the route starts drawing from
          // a camera that is actually looking at the incident.
          const wait = Math.max(0, DIVE_MS - (performance.now() - startedAt));
          dwellTimerRef.current = window.setTimeout(() => {
            if (myReq !== reqIdRef.current) return;
            setPlan(p);
            setSolving(false);
            // Step two is the ride-along, which the map starts as soon as it has the
            // legs. The pull-back is step three and waits for `onPlaybackEnd` — fired
            // here it would run underneath the chase camera and cancel it.
          }, wait);
        })
        .catch((err: unknown) => {
          if (myReq !== reqIdRef.current) return;
          setSolving(false);
          setPlanError(String(err));
          reportError(err);
        });
    },
    [reportError],
  );

  const onMapClick = useCallback(
    (latitude: number, longitude: number) => dispatchTo(latitude, longitude, 'Dropped pin', scenarioId),
    [dispatchTo, scenarioId],
  );

  const onVenueSelect = useCallback(
    (venue: Venue) => dispatchTo(venue.latitude, venue.longitude, venue.name, scenarioId),
    [dispatchTo, scenarioId],
  );

  /**
   * The last beat of the dispatch: the unit has arrived, so lift out of the chase and
   * show the whole journey that was just driven.
   *
   * No staleness guard is needed here, unlike in {@link dispatchTo}. A new click
   * clears the plan, which empties the map's legs and tears down the animation before
   * it can report finishing — and the extent this pulls back to is derived from
   * whatever plan is current, so even a late call frames the right journey.
   */
  const handlePlaybackEnd = useCallback(() => setFrameToken((t) => t + 1), []);

  const clearIncident = useCallback(() => {
    reqIdRef.current++;
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    setIncident(null);
    setPlan(null);
    setPlanError(null);
    setSolving(false);
    setResetToken((t) => t + 1);
  }, []);

  const switchTo = useCallback(
    (nextId: string) => {
      if (nextId === scenarioId || busy) return;

      const apply = (b: NetworkBundle) => {
        setBundle(b);
        setScenarioId(nextId);
      };

      const cached = cacheRef.current[nextId];
      if (cached) {
        apply(cached);
      } else {
        setBusy(true);
        fetchMapNetwork(nextId)
          .then((net) => {
            const b: NetworkBundle = { dto: net, lines: parseNetworkLines(net.linesJson) };
            cacheRef.current[nextId] = b;
            apply(b);
          })
          .catch((err: unknown) => {
            setLoadError(String(err));
            reportError(err);
          })
          .finally(() => setBusy(false));
      }

      if (nextId === GAMEDAY_FLOOD_SCENARIO_ID && !impact) {
        fetchScenarioImpact(nextId)
          .then(setImpact)
          .catch((err: unknown) => reportError(err));
      }

      /*
       * The whole point of the switch: if an incident is already on the map, re-solve
       * that same incident under the new conditions. The destination hospital can
       * change — and watching it change, for a point the viewer chose themselves, is a
       * far stronger demonstration than any number on a panel.
       */
      if (incident) {
        dispatchTo(incident.latitude, incident.longitude, incident.label, nextId);
      } else if (nextId === GAMEDAY_FLOOD_SCENARIO_ID && stadium) {
        // No incident yet: start at the cause. The flood closure is in frame to the
        // south-east from the stadium.
        setFocus({ latitude: stadium.latitude, longitude: stadium.longitude, zoom: 13.6, pitch: 58 });
        setFocusToken((t) => t + 1);
      } else {
        setResetToken((t) => t + 1);
      }
    },
    [scenarioId, busy, impact, incident, stadium, dispatchTo, reportError],
  );

  /*
   * Keyboard shortcuts, because a demo driven from the keyboard looks practised and a
   * demo driven by hunting for buttons does not. Ignored while focus is in a field so
   * they can never eat someone's typing.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        switchTo(underScenario ? BASELINE_SCENARIO_ID : GAMEDAY_FLOOD_SCENARIO_ID);
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'Escape') {
        clearIncident();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [switchTo, clearIncident, underScenario]);

  const network = bundle?.dto ?? null;
  const lines = bundle?.lines ?? null;

  const bounds: MapBounds | null = useMemo(
    () =>
      network
        ? { south: network.bboxSouth, north: network.bboxNorth, west: network.bboxWest, east: network.bboxEast }
        : null,
    [network],
  );

  const responsePath = useMemo(() => decodeGeometry(plan?.responseLeg?.geometry), [plan]);
  const transportPath = useMemo(() => decodeGeometry(plan?.transportLeg?.geometry), [plan]);

  /** The extent the camera pulls back to: both legs plus the incident itself. */
  const frame: MapBounds | null = useMemo(() => {
    const pts: [number, number][] = [];
    if (responsePath) pts.push(...responsePath);
    if (transportPath) pts.push(...transportPath);
    if (incident) pts.push([incident.latitude, incident.longitude]);
    if (pts.length < 2) return null;
    let south = pts[0][0];
    let north = pts[0][0];
    let west = pts[0][1];
    let east = pts[0][1];
    for (const [lat, lon] of pts) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
    return { south, north, west, east };
  }, [responsePath, transportPath, incident]);

  /** The scenario's own zone rows, handed to the map as drawable circles. */
  const crowdZones: MapCrowdZone[] | null = useMemo(() => {
    if (!underScenario || !detail?.zoneOverlays) return null;
    return detail.zoneOverlays.map((z) => ({
      centerLatitude: z.centerLatitude,
      centerLongitude: z.centerLongitude,
      radiusMeters: z.radiusMeters,
      speedMultiplier: z.speedMultiplier,
      reason: z.reason,
    }));
  }, [underScenario, detail]);

  /** The distinct conditions, read off the overlay rows rather than written here. */
  const closureReasons = useMemo(() => {
    const seen = new Set<string>();
    for (const r of detail?.roadOverlays ?? []) {
      if (r.isClosed && r.reason) seen.add(r.reason);
    }
    return Array.from(seen);
  }, [detail]);

  const slowReasons = useMemo(() => {
    const seen = new Set<string>();
    for (const r of detail?.roadOverlays ?? []) {
      if (!r.isClosed && r.reason) seen.add(r.reason);
    }
    return Array.from(seen);
  }, [detail]);

  /** The worst crowd zone, for a one-line summary of the surge. */
  const worstZoneShare = useMemo(() => {
    const zones = detail?.zoneOverlays ?? [];
    if (zones.length === 0) return null;
    return Math.round(Math.min(...zones.map((z) => z.speedMultiplier)) * 100);
  }, [detail]);

  const ready = lines !== null && buildings !== null;

  /* The two numbers the brief asks for, and nothing else. */
  const avgResponseSeconds = underScenario
    ? (impact?.scenarioResponseSeconds ?? null)
    : (impact?.baselineResponseSeconds ?? null);
  const timesSlower = underScenario ? (impact?.responseRatio ?? null) : impact ? 1 : null;

  return (
    <div className="ops-root">
      {/* The map is not a widget on this page — it is the page. */}
      <IsthmusMap3D
        className="absolute inset-0"
        lines={lines}
        buildings={buildings}
        hospitals={hospitals}
        stations={stations}
        venues={venues}
        showNetwork
        /* Bridges are drawn in their own colour to flag routes with no alternative.
         * Under traffic they would overpaint the one thing the map is about, so they
         * stand down and the traffic colour runs across them instead. */
        showBridges={!underScenario}
        showBuildings
        buildingShading="height"
        hideClinics
        trafficMode={underScenario}
        crowdZones={crowdZones}
        pulseOrigin={underScenario && stadium ? { latitude: stadium.latitude, longitude: stadium.longitude } : null}
        incident={incident}
        responsePath={responsePath}
        transportPath={transportPath}
        responseSeconds={plan?.responseLeg?.seconds ?? null}
        transportSeconds={plan?.transportLeg?.seconds ?? null}
        chosenHospitalId={plan?.hospitalId ?? null}
        chosenStationId={plan?.stationId ?? null}
        onMapClick={onMapClick}
        onVenueSelect={onVenueSelect}
        /* A click here means "dispatch to this spot". A road-inspection popup opening
         * on top of the route that same click just produced would fight it. */
        roadInspect={false}
        /* The map's own drive-time clock lives in the canvas's top-left corner, which
         * here belongs to the wordmark. The same seconds are on the answer card. */
        showDriveClock={false}
        /* Ride along with the unit, then pull back when it arrives. */
        followRoute
        onPlaybackEnd={handlePlaybackEnd}
        bounds={bounds}
        focus={focus}
        focusToken={focusToken}
        resetToken={resetToken}
        frame={frame}
        frameToken={frameToken}
      />

      {/* The one unprompted alarm in the room, and only while something is closed. */}
      {underScenario && network?.closedLineCount ? <div className="ops-alert-rail" /> : null}

      {/*
        Top left: the mark, the conditions, the key. Height-capped on purpose — under
        the flood the conditions panel grows by several lines, and without a ceiling the
        column used to run past the bottom of the map and collide with the scale bar and
        the OpenStreetMap credit.
      */}
      <div className="absolute left-5 top-5 z-[600] flex max-h-[calc(100%-6.5rem)] w-[272px] flex-col gap-2.5 overflow-y-auto">
        <div className="flex flex-none items-center gap-2.5">
          {/*
           * The mark: an isthmus. Two bodies of water, one strip of land between them —
           * which is both the logo and the entire reason this problem is hard.
           */}
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden className="flex-none">
            <rect x="0.5" y="0.5" width="25" height="25" rx="3" fill="rgba(9,16,27,0.75)" stroke="rgba(255,255,255,0.12)" />
            <path d="M3 9.5 Q 9 9.5 11.5 13 Q 14 16.5 23 16.5" stroke="var(--ops-accent)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            <circle cx="7" cy="17.5" r="2.1" fill="none" stroke="#2a4a6b" strokeWidth="1.3" />
            <circle cx="19" cy="8.5" r="2.1" fill="none" stroke="#2a4a6b" strokeWidth="1.3" />
          </svg>
          <div className="ops-wordmark">ISTHMUS</div>
        </div>

        <GlassPanel title="Conditions" className="flex-none">
          <ScenarioSwitch
            options={[
              { id: BASELINE_SCENARIO_ID, label: 'Normal', tone: 'clear' },
              { id: GAMEDAY_FLOOD_SCENARIO_ID, label: 'Post-game + flood', tone: 'blocked' },
            ]}
            value={scenarioId}
            onChange={switchTo}
            busy={busy || !ready}
          />

          <hr className="ops-rule my-3" />

          {/* The whole-city summary, kept to the two figures that matter. */}
          <div className="grid grid-cols-2 gap-x-3">
            <Readout
              label="Response avg"
              value={avgResponseSeconds}
              unit="sec"
              tone={underScenario ? 'blocked' : 'clear'}
              sizeClass="text-[21px]"
            />
            <Readout
              label="Times slower"
              value={timesSlower}
              decimals={2}
              unit="×"
              tone={underScenario ? 'blocked' : 'clear'}
              sizeClass="text-[21px]"
            />
          </div>

          {underScenario && (
            <>
              <hr className="ops-rule my-3" />
              <div className="flex flex-col gap-2">
                {closureReasons.map((r) => (
                  <div key={r} className="flex items-start gap-2.5">
                    <span className="ops-swatch mt-1.5" style={{ color: 'var(--ops-blocked)' }} />
                    <span className="text-[10.5px] leading-snug text-[var(--ops-fg-dim)]">{r}</span>
                  </div>
                ))}
                {slowReasons.map((r) => (
                  <div key={r} className="flex items-start gap-2.5">
                    <span className="ops-swatch mt-1.5" style={{ color: 'var(--ops-slow)' }} />
                    <span className="text-[10.5px] leading-snug text-[var(--ops-fg-dim)]">{r}</span>
                  </div>
                ))}
                {worstZoneShare !== null && (
                  <div className="flex items-start gap-2.5">
                    <span
                      className="mt-1 size-[9px] flex-none rounded-full border"
                      style={{ borderColor: 'var(--ops-accent)', background: 'rgba(255,176,32,0.18)' }}
                    />
                    <span className="text-[10.5px] leading-snug text-[var(--ops-fg-dim)]">
                      Crowd leaving Camp Randall — traffic down to{' '}
                      <span className="ops-num text-[var(--ops-accent)]">{worstZoneShare}%</span> of normal speed in the
                      worst zone.
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </GlassPanel>

        <GlassPanel title="Map key" className="flex-none">
          <div className="flex flex-col gap-2">
            {/* The route colours come first: on this page they are what the map is for. */}
            <div className="flex items-center gap-2.5">
              <span className="ops-swatch" style={{ color: RESPONSE_LEG_COLOR }} />
              <span className="text-[11px] text-[var(--ops-fg-dim)]">Ambulance to the scene</span>
            </div>
            <div className="flex items-center gap-2.5">
              <span className="ops-swatch" style={{ color: TRANSPORT_LEG_COLOR }} />
              <span className="text-[11px] text-[var(--ops-fg-dim)]">Scene to the hospital</span>
            </div>
            <hr className="ops-rule my-1" />
            {underScenario ? (
              <>
                {/* The key only ever describes what the map is currently doing. */}
                <TrafficLegend />
                <div className="flex items-center gap-2.5">
                  <span
                    className="h-[5px] w-[18px] flex-none rounded-sm"
                    style={{ background: '#1b4a7a', boxShadow: '0 0 8px -1px #1b4a7a' }}
                  />
                  <span className="text-[11px] text-[var(--ops-fg-dim)]">Flood water across the road</span>
                </div>
              </>
            ) : (
              <>
                {[
                  { cls: 'isthmus-marker isthmus-marker--ed', label: 'Hospital with an ER' },
                  { cls: 'isthmus-marker isthmus-marker--station', label: 'Ambulance station' },
                  { cls: 'isthmus-marker isthmus-marker--venue', label: 'Stadium — click to dispatch' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2.5">
                    <span className={row.cls} style={{ width: 11, height: 11 }} />
                    <span className="text-[11px] text-[var(--ops-fg-dim)]">{row.label}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2.5">
                  <span className="ops-swatch" style={{ color: '#b06ae0' }} />
                  <span className="text-[11px] text-[var(--ops-fg-dim)]">Bridge — no alternative route</span>
                </div>
              </>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* --- bottom centre: the answer, where the eye already is --- */}
      <div className="absolute bottom-6 left-1/2 z-[640] w-[460px] -translate-x-1/2">
        {plan ? (
          <GlassPanel
            key={`${plan.scenarioId}-${plan.incidentLatitude}-${plan.incidentLongitude}`}
            title="Fastest hospital from this point"
            action={
              <button
                type="button"
                onClick={clearIncident}
                className="text-[10.5px] text-[var(--ops-fg-faint)] hover:text-[var(--ops-fg)]"
                title="Clear the incident (R)"
              >
                clear
              </button>
            }
            className="ops-reveal"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium leading-snug text-[var(--ops-fg)]">
                  {plan.hospitalName ?? 'No reachable emergency room'}
                </div>
                <div className="mt-1 truncate text-[11px] text-[var(--ops-fg-dim)]">
                  {plan.stationName ? `${plan.stationName} responding` : 'No station can reach this point'} ·{' '}
                  {incident?.label}
                </div>
              </div>
              <div className="flex flex-none items-baseline gap-1.5">
                <span
                  className="ops-num text-[26px] font-semibold"
                  style={{ color: underScenario ? 'var(--ops-blocked)' : 'var(--ops-clear)' }}
                >
                  {formatDuration(plan.totalSeconds)}
                </span>
                <span className="ops-num text-[10px] text-[var(--ops-fg-faint)]">total</span>
              </div>
            </div>

            <hr className="ops-rule my-3" />

            <div className="flex items-center gap-5">
              <div className="flex items-center gap-2">
                <span className="ops-swatch" style={{ color: RESPONSE_LEG_COLOR }} />
                <span className="ops-label">To scene</span>
                <span className="ops-num text-[13px] text-[var(--ops-fg)]">
                  {formatDuration(plan.responseLeg?.seconds)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="ops-swatch" style={{ color: TRANSPORT_LEG_COLOR }} />
                <span className="ops-label">To hospital</span>
                <span className="ops-num text-[13px] text-[var(--ops-fg)]">
                  {formatDuration(plan.transportLeg?.seconds)}
                </span>
              </div>
            </div>

            {plan.warnings.length > 0 && (
              <p className="mt-3 text-[10px] leading-snug text-[var(--ops-fg-faint)]">{plan.warnings.join(' ')}</p>
            )}
          </GlassPanel>
        ) : planError ? (
          <GlassPanel title="That point could not be solved" className="ops-reveal">
            <p className="text-[11px] leading-snug text-[var(--ops-fg-dim)]">{planError}</p>
          </GlassPanel>
        ) : (
          <div className="flex justify-center">
            <div className="ops-panel flex items-center gap-2.5 px-4 py-2.5">
              <span
                className="size-[7px] flex-none rounded-full"
                style={{
                  background: solving ? 'var(--ops-accent)' : 'var(--ops-clear)',
                  boxShadow: `0 0 10px ${solving ? 'var(--ops-accent)' : 'var(--ops-clear)'}`,
                }}
              />
              <span className="text-[12px] text-[var(--ops-fg-dim)]">
                {solving ? (
                  'Finding the nearest unit and the fastest emergency room…'
                ) : (
                  <>
                    Click anywhere on the map — or a{' '}
                    <span className="text-[var(--ops-accent)]">stadium marker</span> — to dispatch
                  </>
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* --- states --- */}
      {!ready && !loadError && (
        <div className="absolute inset-0 z-[700] flex items-center justify-center bg-[var(--ops-bg)]/85">
          <div className="flex flex-col items-center gap-3">
            <div className="ops-num animate-pulse text-[13px] tracking-[0.3em] text-[var(--ops-accent)]">
              BUILDING THE CITY
            </div>
            <div className="text-[11px] text-[var(--ops-fg-faint)]">
              Loading the road network and ten thousand building footprints
            </div>
          </div>
        </div>
      )}

      {busy && ready && (
        <div className="absolute left-1/2 top-5 z-[700] -translate-x-1/2">
          <div className="ops-chip">
            <span className="ops-chip__dot" />
            Re-solving the city under the new conditions
          </div>
        </div>
      )}

      {loadError && (
        <div className="absolute left-1/2 top-1/2 z-[700] w-[420px] -translate-x-1/2 -translate-y-1/2">
          <GlassPanel title="The city model did not load">
            <p className="text-[12px] leading-relaxed text-[var(--ops-fg-dim)]">{loadError}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--ops-fg-faint)]">
              There is no offline copy of this data on purpose — if the backend call fails you see the failure, not a
              plausible-looking fake city.
            </p>
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
