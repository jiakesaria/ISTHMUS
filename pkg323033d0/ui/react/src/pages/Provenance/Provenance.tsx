/*
 * Data & Provenance — the audit trail behind every number the other two pages show.
 *
 * The rule this page enforces: an estimate is never presented as a measurement. So it
 * states the source and licence of the extract, the exact bytes and checksum of the raw
 * download, the live row counts next to the counts the load recorded, which speeds were
 * read from a tag versus derived from road class, and — most importantly — which fields
 * are deliberately EMPTY because no authoritative source for them has been loaded.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Database, FileText, Scale } from 'lucide-react';

import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Hospital, OsmDataLoad, Scenario, Venue } from '@/Interfaces';
import {
  type LiveCounts,
  fetchDataLoad,
  fetchHospitals,
  fetchLiveCounts,
  fetchScenarios,
  fetchVenues,
} from '@/lib/isthmus';

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function parseRecordCounts(json: string | undefined): Record<string, number> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, number>;
  } catch {
    return {};
  }
}

interface CardProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

function Card({ title, icon, children, className }: CardProps) {
  return (
    <section
      className={`rounded-lg border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] ${className ?? ''}`}
    >
      <h2 className="flex items-center gap-2 border-b border-[var(--c3-style-basic-border-border)] px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
        {icon}
        {title}
      </h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

function Field({ label, value, mono }: FieldProps) {
  return (
    <div className="flex flex-col gap-0.5 py-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--c3-style-basic-fg-neutral)]">
        {label}
      </span>
      <span
        className={`text-xs text-[var(--c3-style-basic-fg-primary)] ${mono ? 'break-all font-mono text-[11px]' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The fields that are intentionally unpopulated. Each row names what would fill it,
 * so a reviewer can see the gap is a known one rather than an oversight.
 */
const EMPTY_BY_DESIGN: { field: string; why: string; fill: string }[] = [
  {
    field: 'Hospital.traumaLevel',
    why: 'OpenStreetMap does not carry trauma designations for these facilities.',
    fill: 'Wisconsin DHS trauma-centre designation list.',
  },
  {
    field: 'Hospital.hasStrokeCenter / hasCathLab / hasPediatrics / hasBurnUnit / hasObstetrics',
    why: 'Clinical capability is not an OSM concept; guessing it would make the hospital-choice logic fiction.',
    fill: 'Hospital service-line directories, or CMS / Joint Commission certification data.',
  },
  {
    field: 'Venue.capacity',
    why: 'Not reliably tagged in OSM, and attendance is the main input to a game-day model, so it must not be invented.',
    fill: 'UW Athletics published venue capacities.',
  },
  {
    field: 'Building.heightMeters (as a measurement)',
    why: 'Footprints are real OSM outlines, but almost none carries a height tag. Nearly every height in the 3D scene is therefore inferred — from a storey count where one exists, otherwise from the building class — and is flagged as such rather than presented as survey data.',
    fill: 'A lidar-derived building-height raster (USGS 3DEP / Dane County lidar), or city assessor building records.',
  },
  {
    field: 'Observed traffic volumes and incident history',
    why: 'No feed is connected. Game-day congestion is therefore a declared scenario assumption, not an observation.',
    fill: 'Wisconsin DOT traffic counts; Madison Fire Department run data.',
  },
];

export default function Provenance() {
  const { reportError } = useErrorBoundary();

  const [load, setLoad] = useState<OsmDataLoad | null>(null);
  const [counts, setCounts] = useState<LiveCounts | null>(null);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchDataLoad(), fetchLiveCounts(), fetchHospitals(), fetchVenues(), fetchScenarios()])
      .then(([manifest, live, hosp, vens, scns]) => {
        if (cancelled) return;
        setLoad(manifest);
        setCounts(live);
        setHospitals(hosp);
        setVenues(vens);
        setScenarios(scns);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(String(err));
        reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const manifestCounts = useMemo(() => parseRecordCounts(load?.recordCounts), [load]);

  const countRows = useMemo(() => {
    if (!counts) return [];
    return [
      { type: 'RoadNode', live: counts.nodes, note: `${counts.coreNodes.toLocaleString()} inside the core box` },
      { type: 'RoadSegment', live: counts.segments, note: 'directed edges — two per two-way street' },
      { type: 'Hospital', live: counts.hospitals, note: `${counts.emergencyDepartments} are ambulance destinations` },
      { type: 'EmsStation', live: counts.stations, note: 'fire and ambulance stations in the study area' },
      { type: 'Venue', live: counts.venues, note: 'stadiums, arenas and civic landmarks' },
      { type: 'Building', live: counts.buildings, note: 'footprints for the 3D scene — not part of the routable graph' },
    ];
  }, [counts]);

  const estimatedShare = counts ? Math.round((counts.estimatedSpeed / Math.max(1, counts.segments)) * 100) : 0;

  /**
   * Building heights, split by what actually produced them. The assumed bucket is
   * derived by subtraction so it can never silently disagree with the row count.
   */
  const heightProvenance = useMemo(() => {
    if (!counts) return null;
    const assumed = counts.buildings - counts.buildingsMeasuredHeight - counts.buildingsLevelsHeight;
    const share = (n: number) => Math.round((n / Math.max(1, counts.buildings)) * 100);
    return {
      measured: counts.buildingsMeasuredHeight,
      levels: counts.buildingsLevelsHeight,
      assumed,
      inferredShare: share(counts.buildingsLevelsHeight + assumed),
    };
  }, [counts]);
  const hospitalsWithNotes = useMemo(() => hospitals.filter((h) => !!h.dataQualityNote), [hospitals]);
  const hospitalsMissingTrauma = useMemo(
    () => hospitals.filter((h) => h.isEmergencyDestination === true && !h.traumaLevel).length,
    [hospitals],
  );
  const venuesMissingCapacity = useMemo(() => venues.filter((v) => !v.capacity).length, [venues]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--c3-style-basic-border-border)] px-5 py-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--c3-style-basic-fg-primary)]">
            ISTHMUS — Data &amp; Provenance
          </h1>
          <p className="text-xs text-[var(--c3-style-basic-fg-neutral)]">
            Where every record came from, what was measured, what was estimated, and what is deliberately blank.
          </p>
        </div>
        {loading && <Spinner size="sm" label="Loading manifest" />}
        {!loading && load && (
          <Badge variant="soft" appearance="info">
            Load {load.id}
          </Badge>
        )}
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-b border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] px-5 py-3 text-xs text-[var(--c3-style-basic-fg-danger)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">Could not load provenance from the C3 backend.</p>
            <p className="font-mono">{loadError}</p>
          </div>
        </div>
      )}

      {!loading && !load && !loadError && (
        <div className="flex items-start gap-2 border-b border-[var(--c3-style-basic-border-warning)] bg-[var(--c3-style-basic-bg-warning)] px-5 py-3 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          No <code>OsmDataLoad</code> manifest exists. The network may have been loaded without recording its
          provenance, which means nothing on this page can be verified.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Source and licence" icon={<Scale className="size-3.5" />}>
            <Field label="Extraction API" value={load?.sourceApi ?? '—'} mono />
            <Field label="Licence" value={load?.sourceLicense ?? '—'} />
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              Road geometry, hospitals, stations and venues are all derived from OpenStreetMap and remain subject to
              the ODbL: the attribution shown on the map and in the network payload is a licence obligation, not
              decoration. Nothing on this page was authored by hand.
            </p>
          </Card>

          <Card title="Raw extract" icon={<FileText className="size-3.5" />}>
            <div className="grid grid-cols-2 gap-x-4">
              <Field label="Tiles downloaded" value={load?.rawTileCount?.toLocaleString() ?? '—'} />
              <Field label="Raw payload" value={formatBytes(load?.rawBytes)} />
            </div>
            <Field label="Stored at" value={load?.rawPath ?? '—'} mono />
            <Field label="SHA-256 of the raw bytes" value={load?.rawChecksumSha256 ?? '—'} mono />
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              The raw tiles are kept, so the whole model can be rebuilt from disk without going back to the network —
              and the checksum makes it possible to prove the inputs have not changed underneath a result.
            </p>
          </Card>

          <Card title="Study area" icon={<Database className="size-3.5" />}>
            <div className="grid grid-cols-2 gap-x-4">
              <Field
                label="Extraction box (download)"
                value={
                  load
                    ? `${load.bboxSouth}, ${load.bboxWest} → ${load.bboxNorth}, ${load.bboxEast}`
                    : '—'
                }
                mono
              />
              <Field
                label="Core box (campus + isthmus)"
                value={
                  load
                    ? `${load.coreBboxSouth}, ${load.coreBboxWest} → ${load.coreBboxNorth}, ${load.coreBboxEast}`
                    : '—'
                }
                mono
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              Two boxes are recorded on purpose. The larger one was downloaded so that roads leaving the area of
              interest are not clipped mid-street — a route must be able to use a road that leaves and re-enters the
              core. The core box marks the area the model is actually about, and{' '}
              <code>RoadNode.inCoreArea</code> flags which intersections fall inside it.
            </p>
          </Card>

          <Card title="Measured versus estimated speeds" icon={<AlertTriangle className="size-3.5" />}>
            {counts && (
              <>
                <div className="mb-2 flex h-3 w-full overflow-hidden rounded">
                  <div
                    className="bg-[var(--c3-style-basic-bg-warning-strong,#e0a000)]"
                    style={{ width: `${estimatedShare}%` }}
                  />
                  <div className="flex-1 bg-[var(--c3-style-basic-bg-success-strong,#2e7d32)]" />
                </div>
                <div className="grid grid-cols-2 gap-x-4 text-xs">
                  <Field
                    label="Estimated from road class"
                    value={`${counts.estimatedSpeed.toLocaleString()} edges (${estimatedShare}%)`}
                  />
                  <Field
                    label="Read from an OSM maxspeed tag"
                    value={`${counts.observedSpeed.toLocaleString()} edges (${100 - estimatedShare}%)`}
                  />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
                  Every segment records which case it is, in <code>speedIsEstimated</code> and{' '}
                  <code>speedSource</code>. Because most of this network is untagged, the travel times on the Dispatch
                  page are best read as comparisons between scenarios — the difference a closure makes is far more
                  trustworthy than the absolute number of seconds.
                </p>
              </>
            )}
          </Card>

          <Card title="Where the building heights came from" icon={<AlertTriangle className="size-3.5" />}>
            {heightProvenance && counts && (
              <>
                <div className="mb-2 flex h-3 w-full overflow-hidden rounded">
                  <div
                    title="Measured"
                    className="bg-[#2ee6a8]"
                    style={{ width: `${(heightProvenance.measured / Math.max(1, counts.buildings)) * 100}%` }}
                  />
                  <div
                    title="From a storey count"
                    className="bg-[#e8b23a]"
                    style={{ width: `${(heightProvenance.levels / Math.max(1, counts.buildings)) * 100}%` }}
                  />
                  <div title="Assumed from building class" className="flex-1 bg-[#4a5a6b]" />
                </div>
                <div className="grid grid-cols-3 gap-x-4 text-xs">
                  <Field label="Measured (OSM height)" value={heightProvenance.measured.toLocaleString()} />
                  <Field label="From building:levels" value={heightProvenance.levels.toLocaleString()} />
                  <Field label="Assumed from class" value={heightProvenance.assumed.toLocaleString()} />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
                  {heightProvenance.inferredShare}% of building heights are inferred rather than measured, which is
                  recorded per row in <code>heightIsEstimated</code> and <code>heightSource</code>. The 3D scene has a{' '}
                  <em>Height confidence</em> shading mode that paints exactly this split onto the city, so the demo can
                  show which parts of its own skyline are evidence. Footprint outlines themselves are real OSM geometry;
                  only the vertical extrusion is inferred, and no building height feeds into any travel time.
                </p>
              </>
            )}
          </Card>

          <Card title="Rows in the database now" icon={<Database className="size-3.5" />}>
            <Table size="sm">
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Live</TableHead>
                  <TableHead className="text-right">At load</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {countRows.map((r) => {
                  const atLoad = manifestCounts[r.type];
                  const drifted = atLoad !== undefined && atLoad !== r.live;
                  return (
                    <TableRow key={r.type}>
                      <TableCell className="font-mono text-[11px]">{r.type}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.live.toLocaleString()}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${drifted ? 'text-[var(--c3-style-basic-fg-warning)]' : ''}`}
                      >
                        {atLoad !== undefined ? atLoad.toLocaleString() : '—'}
                      </TableCell>
                      <TableCell className="text-[11px] text-[var(--c3-style-basic-fg-neutral)]">
                        {drifted ? 'Drifted from the manifest' : r.note}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--c3-style-basic-fg-neutral)]">
              <CheckCircle2 className="size-3.5" />
              {counts
                ? `${counts.bridges} bridges and ${counts.oneways.toLocaleString()} one-way edges are modelled; one-way direction is respected, which is why the two legs of a response are solved separately.`
                : '—'}
            </div>
          </Card>

          <Card title="Scenario assumptions" icon={<AlertTriangle className="size-3.5" />}>
            {scenarios.map((s) => (
              <div key={s.id} className="border-b border-[var(--c3-style-basic-border-border)] py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--c3-style-basic-fg-primary)]">{s.name}</span>
                  {s.isBaseline && (
                    <Badge variant="soft" appearance="info">
                      baseline
                    </Badge>
                  )}
                  <Badge variant="soft" appearance="warning">
                    speed factor {s.ambulanceSpeedFactor ?? '—'}× (estimated)
                  </Badge>
                </div>
                {s.description && (
                  <p className="mt-1 text-[11px] text-[var(--c3-style-basic-fg-neutral)]">{s.description}</p>
                )}
                {s.notes && (
                  <p className="mt-1 text-[10px] leading-relaxed text-[var(--c3-style-basic-fg-warning)]">{s.notes}</p>
                )}
              </div>
            ))}
            {scenarios.length === 0 && !loading && (
              <p className="text-[11px] text-[var(--c3-style-basic-fg-neutral)]">No scenarios loaded.</p>
            )}
          </Card>

          <Card title="Empty on purpose — not missing by accident" icon={<CircleSlash className="size-3.5" />} className="xl:col-span-2">
            <p className="mb-2 text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-neutral)]">
              {hospitalsMissingTrauma} of the loaded emergency departments have no trauma level, and{' '}
              {venuesMissingCapacity} of {venues.length} venues have no capacity. Those blanks are the honest answer:
              no source for them has been loaded, so no value is shown.
            </p>
            <Table size="sm">
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Why it is blank</TableHead>
                  <TableHead>What would fill it</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {EMPTY_BY_DESIGN.map((r) => (
                  <TableRow key={r.field}>
                    <TableCell className="font-mono text-[11px] align-top">{r.field}</TableCell>
                    <TableCell className="text-[11px] align-top">{r.why}</TableCell>
                    <TableCell className="text-[11px] align-top text-[var(--c3-style-basic-fg-neutral)]">
                      {r.fill}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {hospitalsWithNotes.length > 0 && (
            <Card
              title={`Facility data-quality notes (${hospitalsWithNotes.length})`}
              icon={<AlertTriangle className="size-3.5" />}
              className="xl:col-span-2"
            >
              <ul className="flex flex-col gap-2">
                {hospitalsWithNotes.map((h) => (
                  <li key={h.id} className="text-[11px] leading-relaxed">
                    <span className="font-semibold text-[var(--c3-style-basic-fg-primary)]">{h.name}</span>
                    <span className="text-[var(--c3-style-basic-fg-neutral)]"> — {h.dataQualityNote}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {load?.notes && (
            <Card title="Extraction notes" icon={<FileText className="size-3.5" />} className="xl:col-span-2">
              <p className="text-[11px] leading-relaxed text-[var(--c3-style-basic-fg-primary)]">{load.notes}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
