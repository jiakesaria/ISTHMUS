/*
 * City Model — the base digital twin of the Madison isthmus.
 *
 * This page answers "what has actually been loaded, and from where". It draws the
 * extracted network and facilities, and pairs every count with its provenance, so a
 * viewer can tell observed data from estimated data before trusting any travel time
 * computed on the Dispatch page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Building2, Database, Flame, Hospital as HospitalIcon, Route as RouteIcon } from 'lucide-react';

import IsthmusMap3D, { type MapBounds } from '@/components/Map/IsthmusMap3D';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import type {
  EmsStation,
  Hospital,
  MapBuildingsDto,
  MapNetworkDto,
  NetworkLine,
  SceneBuilding,
  Venue,
} from '@/Interfaces';
import {
  BRIDGE_COLOR,
  BUILDING_CONFIDENCE_LEGEND,
  BUILDING_HEIGHT_RAMP,
  BUILDING_LANDMARK_COLOR,
  type BuildingShading,
  ROAD_LEGEND,
  fetchHospitals,
  fetchMapBuildings,
  fetchMapNetwork,
  fetchStations,
  fetchVenues,
  parseNetworkLines,
  parseSceneBuildings,
} from '@/lib/isthmus';

interface PanelSectionProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function PanelSection({ title, icon, children }: PanelSectionProps) {
  return (
    <section className="border-b border-[var(--c3-style-basic-border-border)] px-4 py-3">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  note?: string;
}

function Stat({ label, value, note }: StatProps) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold leading-tight text-[var(--c3-style-basic-fg-primary)]">{value}</span>
      <span className="text-[11px] text-[var(--c3-style-basic-fg-neutral)]">{label}</span>
      {note && <span className="text-[10px] text-[var(--c3-style-basic-fg-neutral)]">{note}</span>}
    </div>
  );
}

export default function CityModel() {
  const { reportError } = useErrorBoundary();

  const [network, setNetwork] = useState<MapNetworkDto | null>(null);
  const [lines, setLines] = useState<NetworkLine[] | null>(null);
  const [buildingMeta, setBuildingMeta] = useState<MapBuildingsDto | null>(null);
  const [buildings, setBuildings] = useState<SceneBuilding[] | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [stations, setStations] = useState<EmsStation[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showNetwork, setShowNetwork] = useState(true);
  const [showBridges, setShowBridges] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [estimatedOnly, setEstimatedOnly] = useState(false);
  const [hideClinics, setHideClinics] = useState(false);
  const [shading, setShading] = useState<BuildingShading>('height');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [net, blds, hosp, stns, vens] = await Promise.all([
        fetchMapNetwork(),
        fetchMapBuildings(),
        fetchHospitals(),
        fetchStations(),
        fetchVenues(),
      ]);
      return { net, blds, hosp, stns, vens };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (cancelled || !data) return;
        setNetwork(data.net);
        setLines(parseNetworkLines(data.net.linesJson));
        setBuildingMeta(data.blds);
        setBuildings(parseSceneBuildings(data.blds.buildingsJson));
        setHospitals(data.hosp);
        setStations(data.stns);
        setVenues(data.vens);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(String(err));
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [load, reportError]);

  const bounds: MapBounds | null = useMemo(
    () =>
      network
        ? { south: network.bboxSouth, north: network.bboxNorth, west: network.bboxWest, east: network.bboxEast }
        : null,
    [network],
  );

  const edHospitals = useMemo(() => hospitals.filter((h) => h.isEmergencyDestination === true), [hospitals]);
  const clinics = useMemo(() => hospitals.filter((h) => h.isEmergencyDestination !== true), [hospitals]);
  const eventVenues = useMemo(() => venues.filter((v) => v.venueKind !== 'landmark'), [venues]);

  const estimatedShare = network
    ? Math.round((network.estimatedSpeedCount / Math.max(1, network.segmentCount)) * 100)
    : 0;

  /**
   * The tallest footprint, read from the data rather than named in the source. It is
   * the Capitol in the current extract, but hardcoding that would turn into a quiet
   * falsehood the first time the extract changes.
   */
  const tallestBuilding = useMemo(() => {
    if (!buildings || buildings.length === 0) return null;
    return buildings.reduce((best, b) => (b.heightMeters > best.heightMeters ? b : best));
  }, [buildings]);

  /** Share of footprints whose height is a per-class default — i.e. no evidence at all. */
  const assumedHeightShare = buildingMeta
    ? Math.round(
        ((buildingMeta.buildingCount - buildingMeta.realHeightCount - buildingMeta.levelsHeightCount) /
          Math.max(1, buildingMeta.buildingCount)) *
          100,
      )
    : 0;

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--c3-style-basic-border-border)] px-5 py-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--c3-style-basic-fg-primary)]">ISTHMUS — City Model</h1>
          <p className="text-xs text-[var(--c3-style-basic-fg-neutral)]">
            Drivable road network, hospitals, fire and ambulance stations, and game-day venues for the Madison
            isthmus and UW&ndash;Madison campus, extracted from OpenStreetMap.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Spinner size="sm" label="Loading network" />}
          <Badge variant="soft" appearance="info">
            {network ? `${network.nodeCount.toLocaleString()} intersections` : '—'}
          </Badge>
          <Badge variant="soft" appearance="info">
            {network ? `${network.segmentCount.toLocaleString()} directed roads` : '—'}
          </Badge>
          <Button asChild variant="solid" appearance="accent" size="sm">
            <Link to="/dispatch">
              <RouteIcon className="size-4" />
              Run a dispatch
            </Link>
          </Button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-b border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] px-5 py-3 text-xs text-[var(--c3-style-basic-fg-danger)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">Could not load the city model from the C3 backend.</p>
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
            showNetwork={showNetwork}
            showBridges={showBridges}
            showBuildings={showBuildings}
            buildingShading={shading}
            estimatedSpeedOnly={estimatedOnly}
            hideClinics={hideClinics}
            bounds={bounds}
          />
        </div>

        <aside className="w-[352px] shrink-0 overflow-auto border-l border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)]">
          <PanelSection title="What loaded" icon={<Database className="size-3.5" />}>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Intersections" value={network ? network.nodeCount.toLocaleString() : '—'} />
              <Stat
                label="Directed road edges"
                value={network ? network.segmentCount.toLocaleString() : '—'}
                note={network ? `${network.lineCount.toLocaleString()} physical roads` : undefined}
              />
              <Stat
                label="Emergency departments"
                value={String(edHospitals.length)}
                note={`${clinics.length} clinics also loaded`}
              />
              <Stat label="Fire / ambulance stations" value={String(stations.length)} />
              <Stat
                label="Building footprints"
                value={buildingMeta ? buildingMeta.buildingCount.toLocaleString() : '—'}
                note={buildingMeta ? `${buildingMeta.namedCount.toLocaleString()} carry a name` : undefined}
              />
              <Stat
                label="Tallest modelled building"
                value={buildingMeta ? `${Math.round(buildingMeta.tallestMeters)} m` : '—'}
                note={tallestBuilding?.name || undefined}
              />
            </div>
          </PanelSection>

          <PanelSection title="How much is estimated" icon={<AlertTriangle className="size-3.5" />}>
            <p className="mb-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              Speed limits come from OpenStreetMap&apos;s <code>maxspeed</code> tag where it exists. Where it does
              not, speed is estimated from road class — and most of this network has no tag, so travel times are
              comparative rather than predictive.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Estimated speeds"
                value={network ? `${network.estimatedSpeedCount.toLocaleString()}` : '—'}
                note={`${estimatedShare}% of all edges`}
              />
              <Stat
                label="Observed speeds"
                value={network ? `${network.observedSpeedCount.toLocaleString()}` : '—'}
                note="from an OSM maxspeed tag"
              />
            </div>
            <p className="mt-2 text-[11px] text-[var(--c3-style-basic-fg-neutral)]">
              Hospital trauma level and venue capacity are deliberately empty — OpenStreetMap does not publish them,
              and they are not guessed. See <Link className="underline" to="/provenance">Data &amp; Provenance</Link>.
            </p>
          </PanelSection>

          <PanelSection title="How tall the buildings really are" icon={<Building2 className="size-3.5" />}>
            <p className="mb-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              Every footprint is a real OpenStreetMap outline, but almost no building in Madison is tagged with its
              height. <strong>{assumedHeightShare}% of the skyline you are looking at is an assumed height</strong>,
              inferred from the building&apos;s class. Switch the shading below to <em>Height confidence</em> to see
              exactly which buildings are evidence and which are inference.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="Measured"
                value={buildingMeta ? buildingMeta.realHeightCount.toLocaleString() : '—'}
                note="OSM height tag"
              />
              <Stat
                label="From storeys"
                value={buildingMeta ? buildingMeta.levelsHeightCount.toLocaleString() : '—'}
                note="levels × 3.3 m"
              />
              <Stat
                label="Assumed"
                value={
                  buildingMeta
                    ? (
                        buildingMeta.buildingCount -
                        buildingMeta.realHeightCount -
                        buildingMeta.levelsHeightCount
                      ).toLocaleString()
                    : '—'
                }
                note="class default"
              />
            </div>
            <p className="mt-2 text-[10px] text-[var(--c3-style-basic-fg-neutral)]">
              Buildings are scenery only. Response times are solved entirely on the road graph, so no building height
              affects any travel time on the Dispatch page.
            </p>
          </PanelSection>

          <PanelSection title="Layers">
            <div className="flex flex-col gap-2.5">
              <label className="flex items-center justify-between gap-2 text-xs" htmlFor="layer-buildings">
                <span>
                  3D buildings{' '}
                  <span className="text-[var(--c3-style-basic-fg-neutral)]">
                    ({buildingMeta ? buildingMeta.buildingCount.toLocaleString() : 0})
                  </span>
                </span>
                <Switch id="layer-buildings" checked={showBuildings} onCheckedChange={setShowBuildings} size="sm" />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs">Building shading</span>
                <div className="flex gap-1.5">
                  <Button
                    variant={shading === 'height' ? 'solid' : 'outline'}
                    appearance={shading === 'height' ? 'accent' : 'secondary'}
                    size="sm"
                    className="flex-1"
                    aria-pressed={shading === 'height'}
                    onClick={() => setShading('height')}
                  >
                    Height
                  </Button>
                  <Button
                    variant={shading === 'confidence' ? 'solid' : 'outline'}
                    appearance={shading === 'confidence' ? 'accent' : 'secondary'}
                    size="sm"
                    className="flex-1"
                    aria-pressed={shading === 'confidence'}
                    onClick={() => setShading('confidence')}
                  >
                    Height confidence
                  </Button>
                </div>
              </div>
              <label className="flex items-center justify-between gap-2 text-xs" htmlFor="layer-network">
                <span>Road network</span>
                <Switch id="layer-network" checked={showNetwork} onCheckedChange={setShowNetwork} size="sm" />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs" htmlFor="layer-bridges">
                <span>
                  Bridges{' '}
                  <span className="text-[var(--c3-style-basic-fg-neutral)]">({network?.bridgeCount ?? 0})</span>
                </span>
                <Switch id="layer-bridges" checked={showBridges} onCheckedChange={setShowBridges} size="sm" />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs" htmlFor="layer-estimated">
                <span>Only roads with estimated speed</span>
                <Switch id="layer-estimated" checked={estimatedOnly} onCheckedChange={setEstimatedOnly} size="sm" />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs" htmlFor="layer-clinics">
                <span>Hide clinics (no ED)</span>
                <Switch id="layer-clinics" checked={hideClinics} onCheckedChange={setHideClinics} size="sm" />
              </label>
            </div>
          </PanelSection>

          <PanelSection title="Legend">
            {shading === 'height' ? (
              <div className="mb-2.5 border-b border-[var(--c3-style-basic-border-border)] pb-2.5">
                <div className="flex h-2.5 overflow-hidden rounded">
                  {BUILDING_HEIGHT_RAMP.map(([meters, color]) => (
                    <span key={meters} className="flex-1" style={{ backgroundColor: color }} />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-[var(--c3-style-basic-fg-neutral)]">
                  <span>{BUILDING_HEIGHT_RAMP[0][0]} m</span>
                  <span>Building height</span>
                  <span>{BUILDING_HEIGHT_RAMP[BUILDING_HEIGHT_RAMP.length - 1][0]} m+</span>
                </div>
              </div>
            ) : (
              <ul className="mb-2.5 flex flex-col gap-1.5 border-b border-[var(--c3-style-basic-border-border)] pb-2.5">
                {BUILDING_CONFIDENCE_LEGEND.map((row) => (
                  <li key={row.label} className="flex items-center gap-2 text-[11px]">
                    <span className="inline-block size-3 rounded-sm" style={{ backgroundColor: row.color }} />
                    {row.label}
                  </li>
                ))}
              </ul>
            )}
            <ul className="mb-2.5 flex flex-col gap-1.5 border-b border-[var(--c3-style-basic-border-border)] pb-2.5">
              <li className="flex items-center gap-2 text-[11px]">
                <span className="inline-block size-3 rounded-sm" style={{ backgroundColor: BUILDING_LANDMARK_COLOR }} />
                Hospital or venue building
              </li>
            </ul>
            <ul className="flex flex-col gap-1.5">
              {ROAD_LEGEND.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-[11px]">
                  <span
                    className="inline-block w-7 rounded"
                    style={{ backgroundColor: s.color, height: Math.max(2, s.weight) }}
                  />
                  {s.label}
                </li>
              ))}
              <li className="flex items-center gap-2 text-[11px]">
                <span className="inline-block h-[4px] w-7 rounded" style={{ backgroundColor: BRIDGE_COLOR }} />
                Bridge or grade separation
              </li>
            </ul>
            <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-[var(--c3-style-basic-border-border)] pt-2.5">
              <li className="flex items-center gap-2 text-[11px]">
                <span className="isthmus-marker isthmus-marker--ed" style={{ width: 16, height: 16, fontSize: 10 }}>
                  +
                </span>
                Emergency department
              </li>
              <li className="flex items-center gap-2 text-[11px]">
                <span className="isthmus-marker isthmus-marker--clinic" />
                Clinic — not an ambulance destination
              </li>
              <li className="flex items-center gap-2 text-[11px]">
                <span className="isthmus-marker isthmus-marker--station" style={{ width: 14, height: 14 }} />
                Fire / ambulance station
              </li>
              <li className="flex items-center gap-2 text-[11px]">
                <span className="isthmus-marker isthmus-marker--venue" style={{ width: 13, height: 13 }} />
                Event venue
              </li>
            </ul>
          </PanelSection>

          <PanelSection title={`Emergency departments (${edHospitals.length})`} icon={<HospitalIcon className="size-3.5" />}>
            <ul className="flex flex-col gap-1.5">
              {edHospitals.map((h) => (
                <li key={h.id} className="text-[11px] leading-snug">
                  <span className="font-medium text-[var(--c3-style-basic-fg-primary)]">{h.name}</span>
                  <br />
                  <span className="text-[var(--c3-style-basic-fg-neutral)]">
                    {h.latitude.toFixed(5)}, {h.longitude.toFixed(5)}
                    {h.operator ? ` · ${h.operator}` : ''}
                  </span>
                  {h.dataQualityNote && (
                    <span className="mt-0.5 block text-[10px] text-[var(--c3-style-basic-fg-warning)]">
                      Data-quality note recorded — see the map popup.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </PanelSection>

          <PanelSection title={`Response origins (${stations.length})`} icon={<Flame className="size-3.5" />}>
            <ul className="flex flex-col gap-1.5">
              {stations.map((s) => (
                <li key={s.id} className="text-[11px] leading-snug">
                  <span className="font-medium text-[var(--c3-style-basic-fg-primary)]">{s.name}</span>
                  <br />
                  <span className="text-[var(--c3-style-basic-fg-neutral)]">
                    {s.stationKind === 'ems_station' ? 'Ambulance station' : 'Fire station'} ·{' '}
                    {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] text-[var(--c3-style-basic-fg-neutral)]">
              Madison Fire Department runs more stations than this across the wider city; only those inside the study
              area were extracted.
            </p>
          </PanelSection>

          <PanelSection title={`Game-day venues (${eventVenues.length})`} icon={<Building2 className="size-3.5" />}>
            <ul className="flex flex-col gap-1.5">
              {venues.map((v) => (
                <li key={v.id} className="text-[11px] leading-snug">
                  <span className="font-medium text-[var(--c3-style-basic-fg-primary)]">{v.name}</span>
                  <br />
                  <span className="text-[var(--c3-style-basic-fg-neutral)]">
                    {v.venueKind === 'landmark' ? 'Civic landmark' : 'Event venue'} ·{' '}
                    {v.capacity ? `capacity ${v.capacity.toLocaleString()}` : 'capacity not loaded'}
                  </span>
                </li>
              ))}
            </ul>
          </PanelSection>

          <PanelSection title="Attribution">
            <p className="text-[10px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              {network?.attribution ?? 'Road network and facilities: © OpenStreetMap contributors, ODbL 1.0'}
            </p>
          </PanelSection>
        </aside>
      </div>
    </div>
  );
}
