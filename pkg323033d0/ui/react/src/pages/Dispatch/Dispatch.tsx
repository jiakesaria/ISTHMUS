/*
 * Dispatch — "an emergency happened at point X; what happens next?"
 *
 * Click anywhere on the map and the backend solves two shortest paths against the
 * selected scenario: one backwards from the incident to find the station that can
 * reach it soonest, one forwards to find the fastest reachable emergency department.
 * Both legs are drawn, both are timed separately, and every caveat the engine returns
 * is shown rather than hidden — the point of the model is to be auditable, not to look
 * confident.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Ambulance, Crosshair, Info, MapPin, Play } from 'lucide-react';

import IsthmusMap3D, { type MapBounds } from '@/components/Map/IsthmusMap3D';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type {
  EmsStation,
  Hospital,
  MapNetworkDto,
  NetworkLine,
  ResponsePlan,
  Scenario,
  SceneBuilding,
  Venue,
} from '@/Interfaces';
import {
  RESPONSE_LEG_COLOR,
  TRANSPORT_LEG_COLOR,
  fetchHospitals,
  fetchMapBuildings,
  fetchMapNetwork,
  fetchScenarios,
  fetchStations,
  fetchVenues,
  formatDistance,
  formatDuration,
  parseNetworkLines,
  parseSceneBuildings,
  requestResponsePlan,
} from '@/lib/isthmus';

interface IncidentPoint {
  latitude: number;
  longitude: number;
}

function decodeGeometry(geometry: string | undefined | null): [number, number][] | null {
  if (!geometry) return null;
  try {
    return JSON.parse(geometry) as [number, number][];
  } catch {
    return null;
  }
}

interface LegCardProps {
  title: string;
  color: string;
  endpoint: string;
  seconds?: number;
  meters?: number;
  streets?: string[];
  estimated?: number;
  total?: number;
  bridges?: number;
}

function LegCard({ title, color, endpoint, seconds, meters, streets, estimated, total, bridges }: LegCardProps) {
  return (
    <div className="rounded-md border border-[var(--c3-style-basic-border-border)] p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-[4px] w-6 rounded" style={{ backgroundColor: color }} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
          {title}
        </span>
      </div>
      <p className="text-sm font-medium leading-snug text-[var(--c3-style-basic-fg-primary)]">{endpoint}</p>
      <p className="mt-1 text-2xl font-semibold leading-none text-[var(--c3-style-basic-fg-primary)]">
        {formatDuration(seconds)}
        <span className="ml-2 text-xs font-normal text-[var(--c3-style-basic-fg-neutral)]">
          {formatDistance(meters)}
        </span>
      </p>
      {streets && streets.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--c3-style-basic-fg-neutral)]">
          via {streets.join(' → ')}
        </p>
      )}
      <p className="mt-1.5 text-[10px] text-[var(--c3-style-basic-fg-neutral)]">
        {total ?? 0} segments
        {estimated !== undefined && total ? ` · ${estimated} with estimated speed` : ''}
        {bridges ? ` · ${bridges} bridge${bridges === 1 ? '' : 's'}` : ''}
      </p>
    </div>
  );
}

export default function Dispatch() {
  const { reportError } = useErrorBoundary();

  const [network, setNetwork] = useState<MapNetworkDto | null>(null);
  const [lines, setLines] = useState<NetworkLine[] | null>(null);
  const [buildings, setBuildings] = useState<SceneBuilding[] | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [stations, setStations] = useState<EmsStation[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState<string>('');

  const [incident, setIncident] = useState<IncidentPoint | null>(null);
  const [plan, setPlan] = useState<ResponsePlan | null>(null);
  const [solving, setSolving] = useState(false);
  const [baseLoading, setBaseLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);

  /**
   * Bumping this token restarts the route animation. It is a counter rather than a
   * boolean so that re-running the *same* plan still retriggers playback — a boolean
   * would already be `true` and the map would see no change.
   */
  const [playToken, setPlayToken] = useState(0);
  const [playing, setPlaying] = useState(false);

  /* --- base data --- */
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchMapNetwork(),
      fetchMapBuildings(),
      fetchHospitals(),
      fetchStations(),
      fetchVenues(),
      fetchScenarios(),
    ])
      .then(([net, blds, hosp, stns, vens, scns]) => {
        if (cancelled) return;
        setNetwork(net);
        setLines(parseNetworkLines(net.linesJson));
        setBuildings(parseSceneBuildings(blds.buildingsJson));
        setHospitals(hosp);
        setStations(stns);
        setVenues(vens);
        setScenarios(scns);
        const baseline = scns.find((s) => s.isBaseline) ?? scns[0];
        if (baseline) setScenarioId(baseline.id);
        setBaseLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBaseLoading(false);
        setLoadError(String(err));
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  /* --- solve on incident or scenario change --- */
  useEffect(() => {
    if (!incident || !scenarioId) return;
    let cancelled = false;
    setSolving(true);
    setSolveError(null);
    requestResponsePlan(incident.latitude, incident.longitude, scenarioId)
      .then((result) => {
        if (cancelled) return;
        setPlan(result);
        setSolving(false);
        /* A fresh answer plays itself once; replaying afterwards is the user's choice. */
        setPlaying(true);
        setPlayToken((t) => t + 1);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSolving(false);
        setPlan(null);
        setPlaying(false);
        setSolveError(String(err));
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [incident, scenarioId, reportError]);

  const handleMapClick = useCallback((latitude: number, longitude: number) => {
    setIncident({ latitude, longitude });
  }, []);

  const handleReplay = useCallback(() => {
    setPlaying(true);
    setPlayToken((t) => t + 1);
  }, []);

  const handlePlaybackEnd = useCallback(() => {
    setPlaying(false);
  }, []);

  const bounds: MapBounds | null = useMemo(
    () =>
      network
        ? { south: network.bboxSouth, north: network.bboxNorth, west: network.bboxWest, east: network.bboxEast }
        : null,
    [network],
  );

  const responsePath = useMemo(() => decodeGeometry(plan?.responseLeg?.geometry), [plan]);
  const transportPath = useMemo(() => decodeGeometry(plan?.transportLeg?.geometry), [plan]);
  const activeScenario = useMemo(() => scenarios.find((s) => s.id === scenarioId) ?? null, [scenarios, scenarioId]);

  /* Presets come from the loaded Venue rows, so there are no hardcoded coordinates. */
  const presets = useMemo(() => venues.filter((v) => v.venueKind !== 'landmark').slice(0, 4), [venues]);

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--c3-style-basic-border-border)] px-5 py-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--c3-style-basic-fg-primary)]">ISTHMUS — Dispatch</h1>
          <p className="text-xs text-[var(--c3-style-basic-fg-neutral)]">
            Click the map to place an incident. The engine finds the nearest responding unit and the fastest
            reachable emergency department under the selected scenario.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              className="text-[10px] font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]"
              htmlFor="scenario-select"
            >
              Scenario
            </label>
            <select
              id="scenario-select"
              className="h-8 min-w-[220px] rounded border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] px-2 text-xs text-[var(--c3-style-basic-fg-primary)]"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            >
              {scenarios.length === 0 && <option value="">Loading…</option>}
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button variant="outline" appearance="secondary" size="sm" asChild>
            <Link to="/">City model</Link>
          </Button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-b border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] px-5 py-3 text-xs text-[var(--c3-style-basic-fg-danger)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">Could not load the network from the C3 backend.</p>
            <p className="font-mono">{loadError}</p>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <IsthmusMap3D
            className="absolute inset-0"
            lines={lines}
            buildings={buildings}
            hospitals={hospitals}
            stations={stations}
            venues={venues}
            showNetwork
            showBridges
            showBuildings
            incident={incident}
            responsePath={responsePath}
            transportPath={transportPath}
            responseSeconds={plan?.responseLeg?.seconds ?? null}
            transportSeconds={plan?.transportLeg?.seconds ?? null}
            chosenHospitalId={plan?.hospitalId ?? null}
            chosenStationId={plan?.stationId ?? null}
            onMapClick={handleMapClick}
            bounds={bounds}
            playToken={playToken}
            onPlaybackEnd={handlePlaybackEnd}
          />
          {!incident && !baseLoading && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-[500] -translate-x-1/2 rounded-full bg-[var(--c3-style-basic-bg-neutral-inverse)] px-4 py-2 text-xs font-medium text-[var(--c3-style-basic-fg-inverse)] shadow-lg">
              <Crosshair className="mr-1.5 inline size-3.5" />
              Click anywhere on the map to place an incident
            </div>
          )}
          {plan?.responseLeg && plan?.transportLeg && (
            <div className="absolute bottom-10 left-1/2 z-[500] -translate-x-1/2">
              <Button size="sm" variant="solid" appearance="accent" onClick={handleReplay} disabled={playing}>
                <Play className="size-3.5" />
                {playing ? 'Playing…' : 'Replay the run'}
              </Button>
            </div>
          )}
          {baseLoading && (
            <div className="absolute inset-0 z-[500] flex items-center justify-center bg-[#070d16]/80">
              <Spinner size="xl" label="Loading network" />
            </div>
          )}
        </div>

        <aside className="w-[380px] shrink-0 overflow-auto border-l border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)]">
          {presets.length > 0 && (
            <section className="border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
                Or start from a venue
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((v) => (
                  <Button
                    key={v.id}
                    size="sm"
                    variant="soft"
                    appearance="secondary"
                    onClick={() => setIncident({ latitude: v.latitude, longitude: v.longitude })}
                  >
                    <MapPin className="size-3.5" />
                    {v.name}
                  </Button>
                ))}
              </div>
            </section>
          )}

          {!incident && (
            <section className="px-4 py-4 text-xs leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              <p className="mb-2 flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0" />
                No incident placed yet. A response is two separate drives — a unit must first reach the patient, then
                carry them to a hospital — and because Madison&apos;s one-way couplets make the inbound and outbound
                routes genuinely different, each is solved on its own.
              </p>
              {activeScenario?.description && <p className="mt-3">{activeScenario.description}</p>}
            </section>
          )}

          {solveError && (
            <section className="border-b border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] px-4 py-3 text-xs text-[var(--c3-style-basic-fg-danger)]">
              <p className="font-semibold">Routing failed.</p>
              <p className="font-mono">{solveError}</p>
            </section>
          )}

          {solving && (
            <section className="flex items-center gap-2 border-b border-[var(--c3-style-basic-border-border)] px-4 py-3 text-xs">
              <Spinner size="sm" />
              Solving both legs against the scenario…
            </section>
          )}

          {plan && !solving && (
            <>
              <section className="border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
                    Total drive time
                  </h3>
                  <Badge variant="soft" appearance="secondary">
                    {plan.scenarioName}
                  </Badge>
                </div>
                <p className="flex items-center gap-2 text-4xl font-semibold leading-none text-[var(--c3-style-basic-fg-primary)]">
                  <Ambulance className="size-7 text-[var(--c3-style-basic-fg-neutral)]" />
                  {formatDuration(plan.totalSeconds)}
                </p>
                <p className="mt-1.5 text-[11px] text-[var(--c3-style-basic-fg-neutral)]">
                  Drive time only — dispatch delay, turnout and on-scene treatment are not modelled, because no data
                  for them is loaded. Incident snapped {Math.round(plan.incidentSnapMeters)} m to intersection{' '}
                  <code>{plan.incidentNodeId}</code>.
                </p>
              </section>

              <section className="flex flex-col gap-2 border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
                <LegCard
                  title="Leg 1 · unit to incident"
                  color={RESPONSE_LEG_COLOR}
                  endpoint={plan.stationName ?? 'No station could reach this point'}
                  seconds={plan.responseLeg?.seconds}
                  meters={plan.responseLeg?.meters}
                  streets={plan.responseLeg?.streets}
                  estimated={plan.responseLeg?.estimatedSpeedSegmentCount}
                  total={plan.responseLeg?.segmentCount}
                  bridges={plan.responseLeg?.bridgeCount}
                />
                <LegCard
                  title="Leg 2 · incident to hospital"
                  color={TRANSPORT_LEG_COLOR}
                  endpoint={plan.hospitalName ?? 'No emergency department reachable'}
                  seconds={plan.transportLeg?.seconds}
                  meters={plan.transportLeg?.meters}
                  streets={plan.transportLeg?.streets}
                  estimated={plan.transportLeg?.estimatedSpeedSegmentCount}
                  total={plan.transportLeg?.segmentCount}
                  bridges={plan.transportLeg?.bridgeCount}
                />
              </section>

              <section className="border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
                  Emergency departments by drive time
                </h3>
                <ul className="flex flex-col gap-1">
                  {plan.candidateHospitals.map((h, i) => {
                    const chosen = h.hospitalId === plan.hospitalId;
                    return (
                      <li
                        key={h.hospitalId}
                        className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 text-[11px] ${
                          chosen ? 'bg-[var(--c3-style-basic-bg-accent)]' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          <span className="mr-1.5 text-[var(--c3-style-basic-fg-neutral)]">{i + 1}.</span>
                          {h.hospitalName}
                          {h.excludedReason && (
                            <span className="ml-1 text-[var(--c3-style-basic-fg-warning)]">
                              — excluded: {h.excludedReason}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono">
                          {h.isReachable ? formatDuration(h.seconds) : 'unreachable'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
                  Response origins by drive time
                </h3>
                <ul className="flex flex-col gap-1">
                  {plan.candidateStations.map((s, i) => {
                    const chosen = s.stationId === plan.stationId;
                    return (
                      <li
                        key={s.stationId}
                        className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 text-[11px] ${
                          chosen ? 'bg-[var(--c3-style-basic-bg-accent)]' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          <span className="mr-1.5 text-[var(--c3-style-basic-fg-neutral)]">{i + 1}.</span>
                          {s.stationName}
                        </span>
                        <span className="shrink-0 font-mono">
                          {s.isReachable ? formatDuration(s.seconds) : 'unreachable'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {plan.warnings.length > 0 && (
                <section className="px-4 py-3">
                  <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-warning)]">
                    <AlertTriangle className="size-3.5" />
                    How much to trust this
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {plan.warnings.map((w) => (
                      <li key={w} className="text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
                        {w}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-[var(--c3-style-basic-fg-neutral)]">
                    Full extraction provenance is on the{' '}
                    <Link className="underline" to="/provenance">
                      Data &amp; Provenance
                    </Link>{' '}
                    page.
                  </p>
                </section>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
