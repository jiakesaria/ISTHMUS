/*
 * The ISTHMUS 3D scene.
 *
 * MapLibre GL is driven imperatively, for the same reason the earlier Leaflet map was:
 * the payload is ~4,700 road polylines and ~10,000 building footprints, and pushing
 * those through React reconciliation on every state change would be ruinous. Here each
 * dataset becomes a single GeoJSON source whose `setData` is called from its own
 * effect, so toggling a layer or re-solving a route touches only that source.
 *
 * Three deliberate constraints shape this file:
 *
 *  1. **No glyph server.** MapLibre needs a `glyphs` URL to render any `symbol` text
 *     layer, and standing one up would mean a new external dependency. So every label
 *     is an HTML `Marker` or `Popup` instead — which also lets the facility markers
 *     keep the CSS they already had.
 *  2. **No terrain.** A DEM source would need an API key, and the isthmus is flat
 *     enough that it would buy nothing. The depth in this scene comes from building
 *     extrusion, sky and pitch.
 *  3. **The basemap is the same OpenStreetMap raster the 2D map used**, recoloured
 *     through MapLibre's raster paint properties rather than swapped for a styled
 *     vector basemap — no new tile provider, no key, and the ODbL attribution we were
 *     already obliged to show stays correct.
 *
 * Route playback animates by rewriting one GeoJSON source per frame from a
 * distance-interpolated position along the leg, rather than by animating opacity on
 * pre-split segments: the vehicle has to move continuously and the revealed tail has to
 * end exactly where it is.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Imported explicitly rather than used as the ambient `GeoJSON.*` namespace: TypeScript
// resolves that global, but ESLint's `no-undef` does not and fails the build on it.
import type { Feature, FeatureCollection } from 'geojson';
// maplibre-gl v6 ships named exports only and has no default export, so this must be
// a namespace import — the same shape the Leaflet map used.
import * as maplibregl from 'maplibre-gl';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLatBoundsLike,
  LngLatLike,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre does all its tile and geometry work on a web worker, and by default it
// guesses the worker's URL as `./maplibre-gl-worker.mjs` relative to its own module.
// Under a bundler that file sits in `node_modules`, not next to the emitted chunk, so
// the guess 404s and the map silently renders nothing but "Worker failed to load".
// Importing it with Vite's `?url` suffix makes Vite emit the worker as a real asset
// and hand back its true URL — correct in both the dev server and the production build.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './isthmusMap3d.css';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

import type { EmsStation, Hospital, NetworkLine, SceneBuilding, Venue } from '@/Interfaces';
import {
  BRIDGE_COLOR,
  BUILDING_CONFIDENCE_COLORS,
  BUILDING_HEIGHT_RAMP,
  BUILDING_LANDMARK_COLOR,
  type BuildingShading,
  FLOOD_WATER_COLOR,
  RESPONSE_LEG_COLOR,
  TRANSPORT_LEG_COLOR,
  congestionColor,
  congestionGlow,
  formatDuration,
  roadStyle,
} from '@/lib/isthmus';

export interface MapBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

/** A circular area a scenario slows down, as the map needs it. */
export interface MapCrowdZone {
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
  speedMultiplier: number;
  reason?: string;
}

/** Where the camera should go, and what to say when it arrives. */
export interface MapFocus {
  latitude: number;
  longitude: number;
  zoom?: number;
  pitch?: number;
  bearing?: number;
}

export interface IsthmusMap3DProps {
  lines: NetworkLine[] | null;
  buildings: SceneBuilding[] | null;
  hospitals: Hospital[];
  stations: EmsStation[];
  venues: Venue[];
  showNetwork?: boolean;
  showBridges?: boolean;
  showBuildings?: boolean;
  /** Restrict the network to roads whose speed was estimated rather than observed. */
  estimatedSpeedOnly?: boolean;
  /** Hide clinics, which are in the data but are not ambulance destinations. */
  hideClinics?: boolean;
  /** Colour extrusions by height, or by how the height was arrived at. */
  buildingShading?: BuildingShading;
  incident?: { latitude: number; longitude: number } | null;
  responsePath?: [number, number][] | null;
  transportPath?: [number, number][] | null;
  /** Real modelled drive seconds per leg, used to pace playback proportionally. */
  responseSeconds?: number | null;
  transportSeconds?: number | null;
  chosenHospitalId?: string | null;
  chosenStationId?: string | null;
  onMapClick?: (latitude: number, longitude: number) => void;
  /**
   * Colour the network by how fast traffic is moving rather than by road class.
   * Off by default: under the baseline every stretch is at free flow, and a map where
   * every road is the same green says less than one where the colour still carries the
   * road hierarchy.
   */
  trafficMode?: boolean;
  /** Crowd and flood areas to wash over the map, drawn as polygons. */
  crowdZones?: MapCrowdZone[] | null;
  /**
   * Centre of the slow-expanding ring that marks where the crowd is coming from.
   * Null stops the animation rather than merely hiding it, so an idle control room
   * costs no frames.
   */
  pulseOrigin?: { latitude: number; longitude: number } | null;
  /** Initial extent; applied once, so later renders never fight the user's camera. */
  bounds?: MapBounds | null;
  /**
   * A place to fly to. Applied when {@link IsthmusMap3DProps.focusToken} changes
   * rather than when the coordinates change, so re-requesting the same spot still
   * flies and the user's own panning is never yanked back mid-gesture.
   */
  focus?: MapFocus | null;
  focusToken?: number;
  /** Increment to fly back to the opening view of the whole isthmus. */
  resetToken?: number;
  /**
   * An extent to pull back and frame, applied on {@link IsthmusMap3DProps.frameToken}.
   * This is the second half of the dispatch camera move: {@link IsthmusMap3DProps.focus}
   * dives onto the incident, then this eases out until the whole journey is in shot.
   * Separating them is what makes the move read as one continuous gesture — the dive
   * establishes *where*, the pull-back answers *how far*.
   */
  frame?: MapBounds | null;
  frameToken?: number;
  /**
   * Whether clicking a road opens its speed/congestion card. On the control room this
   * is off: there, a click means "dispatch to here", and a popup opening on top of the
   * route that the same click just produced fights the thing the user asked for.
   */
  roadInspect?: boolean;
  /**
   * Whether the map draws its own "Drive time" clock while a route plays. It is pinned
   * to the top-left corner of the canvas, which on the control room is occupied by the
   * wordmark and the instrument stack — so that page turns it off and reports the same
   * seconds in its own answer card instead.
   */
  showDriveClock?: boolean;
  /**
   * Whether the camera rides along with the unit during playback — down onto the
   * responding vehicle, banking through the turns behind it, lifting for a beat as it
   * reaches the scene, then following the patient to the hospital.
   *
   * Three consequences worth knowing before switching this on:
   * - It **cancels any camera animation in flight** when playback starts, because a
   *   running `flyTo` writes the transform every frame and would simply overrule it.
   * - It **hands control back the moment the viewer drags or scrolls**. A camera that
   *   fights the mouse feels broken, so the first gesture ends the shot for good.
   * - The pull-back to {@link IsthmusMap3DProps.frame} should be triggered from
   *   {@link IsthmusMap3DProps.onPlaybackEnd} rather than when the route arrives, or
   *   the two camera moves run at once and neither one reads.
   */
  followRoute?: boolean;
  /**
   * Called when a venue marker is clicked. When supplied, venue markers dispatch
   * instead of opening their own popup, so "click any point or venue" is one gesture
   * with one outcome rather than two different behaviours on the same map.
   */
  onVenueSelect?: (venue: Venue) => void;
  /**
   * Increment to restart route playback from the beginning. A token rather than a
   * boolean so that re-solving the same incident can replay without a reset dance.
   */
  playToken?: number;
  onPlaybackEnd?: () => void;
  className?: string;
}

const MADISON_FALLBACK_CENTER: [number, number] = [-89.4085, 43.0715];
const SKY_COLOR = '#0a1522';

/** Whole-journey playback length. Both legs share it in proportion to real drive time. */
const PLAYBACK_SECONDS = 9;

/* --- chase camera ---
 *
 * The shot that rides along with the unit. Every value here is tuned to one idea: the
 * camera is a helicopter with a patient pilot, not a rail and not a chase car. It keeps
 * the vehicle in the middle of the frame, but it is allowed to be slow about *how* it
 * looks at it: a corner is answered by rising slightly and panning round over a second
 * or two, never by snapping to the new heading.
 *
 * Because the camera is centred on the vehicle, the *only* term that has to keep up is
 * position. Bearing, zoom and pitch can lag as far behind as looks good without any
 * risk of losing the unit off the edge of the frame — which is what makes the very lazy
 * rotation values below safe.
 */
/** Height to settle at while following. Close enough to read street names. */
const FOLLOW_ZOOM = 15.5;
const FOLLOW_PITCH = 62;
/**
 * Per-frame approach fraction at 60 fps, normalised for real frame time below so a
 * 120 Hz display does not chase twice as fast. This is the keep-up term, so it is the
 * one value here that is not lazy.
 */
const FOLLOW_EASE = 0.085;
/**
 * If smoothing ever leaves the camera further behind than this (metres on the ground —
 * a long straight at speed, or a frame-rate stall), the position ease firms up in
 * proportion until the gap closes. A guard rail, not a normal part of the shot.
 */
const FOLLOW_LAG_CATCHUP_M = 220;
/**
 * The camera aims at the average heading of this much of the road just driven — a long
 * window, deliberately. Nine seconds of playback covers a couple of kilometres, so a
 * corner is over in about half a second of wall clock; a camera aimed at the *local*
 * heading would therefore have to whip round for every turn, and (at any rate slow
 * enough to look calm) would simply never catch up. Aiming at the long-run direction
 * instead means a single corner barely moves the target, so the camera drifts rather
 * than chases, and the shot stays level through a twisty stretch.
 */
const FOLLOW_HEADING_LOOKBACK_M = 600;
/**
 * The curvature probe: a short window compared against the long one above. When the
 * road bends, the near heading swings ahead of the far heading and the difference grows
 * — a measure of how hard the *road* is turning, independent of how far behind the
 * camera happens to be. That is what drives the lift, so the widening lands on the
 * corner itself instead of trailing the camera's own lag.
 */
const FOLLOW_CURVE_WINDOW_M = 150;
/** Rotation ease. Very lazy on purpose — see the note about centring above. */
const FOLLOW_TURN_EASE = 0.016;
/**
 * Hard ceiling on rotation, in degrees per second, applied after the ease. The ease
 * alone still opens a sharp corner fast (its first frames are its biggest); this is
 * what guarantees a hard left reads as a slow pan however abrupt the road is.
 */
const FOLLOW_TURN_MAX_DPS = 24;
/** Zoom and pitch ease, slower again than position: height should drift, not step. */
const FOLLOW_HEIGHT_EASE = 0.03;
/* --- widening into the turn ---
 *
 * Instead of swinging the camera round a corner, the camera lifts a little and turns
 * slowly underneath that lift. Rising first is what makes the slow turn legible: from
 * higher up, the same rotation covers less apparent distance on screen.
 */
/** Bearing error that counts as a full turn, in degrees. */
const FOLLOW_TURN_FULL_DEG = 55;
/** How fast the widening comes in and goes out. Slower than the turn it answers. */
const FOLLOW_TURN_LOAD_EASE = 0.018;
/** Zoom levels given up at a full turn, and degrees of pitch laid back. */
const FOLLOW_TURN_ZOOM_OUT = 0.85;
const FOLLOW_TURN_PITCH_DROP = 9;
/**
 * The hand-over from the dive. The chase zoom and pitch are blended in over this window
 * so the ride-along *continues* the dive rather than arriving as a second, competing
 * move.
 */
const FOLLOW_SETTLE_MS = 1400;
/* --- the establishing sweep, run once per leg, and not optional ---
 *
 * At the start the dive leaves the camera facing wherever it last pointed — possibly a
 * half turn from the route — and at the hospital hand-off the second leg can set off
 * back the way the unit came. Either way the settled ceiling above would still be
 * coming round when the unit arrived. So each leg opens with one deliberate eased turn
 * onto its heading: at the start it lands under the dive, which is still visibly
 * settling, and at the hand-off it lands under the lift, so the camera rises, turns and
 * descends as one move. After that the lazy ceiling governs and the camera barely
 * rotates again.
 *
 * The sweep is budgeted by *rate*, not by a fixed window: a fixed window turns a small
 * correction into a crawl and a half-turn into a whip pan. Pick the speed that looks
 * like an operator panning, then let the length follow from how far there is to go.
 */
/** Average sweep rate, °/s. The eased peak is about π/2 × this. */
const FOLLOW_ORIENT_DPS = 55;
/** Floor and ceiling on the sweep's length, so it is neither a blink nor the whole drive. */
const FOLLOW_ORIENT_MIN_MS = 600;
const FOLLOW_ORIENT_MAX_MS = 2200;
/**
 * Ceiling on any single sweep frame, °/s. The share-of-remaining maths below hands the
 * last of the error to the final frames, which would snap if the heading drifted late
 * in a sweep; this turns that into a tail the settled ease finishes off.
 */
const FOLLOW_ORIENT_MAX_DPS = 2.5 * FOLLOW_ORIENT_DPS;
/**
 * The breath at the hand-off. When the unit reaches the scene and the second leg
 * begins, the camera lifts and settles back over this window, so the viewer feels the
 * patient being loaded instead of reading a label that says so.
 */
const FOLLOW_LIFT_MS = 1900;
const FOLLOW_LIFT_ZOOM = 0.9;

/* --- arrival flash and vehicle beacon --- */
/** How long an arrival ring takes to expand and fade out. */
const FLASH_MS = 1150;
/** How far it reaches, in metres on the ground. Local, not city-wide: this is a door. */
const FLASH_RADIUS_M = 300;
/** The halo around the moving unit at rest, restored whenever playback stops. */
const HEAD_GLOW_OPACITY = 0.3;
const HEAD_GLOW_NEAR = 10;
const HEAD_GLOW_FAR = 22;
/** Beacon period. Close to a real light bar without being a nightclub. */
const BEACON_MS = 760;

/* ----------------------------------------------------------------- helpers -- */

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Slow in, slow out — the shape of a camera operator's pan. Sine rather than cubic on
 * purpose: cubic ease-in-out peaks at three times its average rate, which turns a long
 * pan into a whip. Sine peaks at π/2 ≈ 1.57×, so the middle of the move stays readable.
 */
function easeInOutSine(t: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * t));
}

/** Compass bearing a→b in MapLibre's degrees-clockwise-from-north. */
function bearingBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Signed degrees from `from` to `to` the short way round: always in (−180, 180], so
 * 350° → 10° is +20 and not −340. Everything that turns the camera goes through this.
 */
function shortestAngle(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * The direction the vehicle has been travelling, averaged over the last
 * `lookbackMeters` of road rather than read off the current polyline segment.
 *
 * OSM road geometry is a chain of short segments — frequently 10–20 m — and a city
 * street is never quite straight, so a per-segment bearing jitters constantly and
 * swings hard at every intersection. Walking back a fixed *distance* instead gives the
 * heading of the stretch just driven, which is both stable and what a pilot would
 * actually be pointing at.
 *
 * Returns null when too little road has been driven to mean anything (the first metres
 * of a leg), so the caller can hold its current bearing instead of snapping to the
 * direction of one stub of geometry.
 *
 * @param trail  the driven part of the leg, in order, ending at `head`
 * @param head   the vehicle's current position, `[lon, lat]`
 */
function trailHeading(
  trail: [number, number][],
  head: [number, number],
  lookbackMeters: number,
): number | null {
  let accrued = 0;
  let previous = head;
  for (let i = trail.length - 1; i >= 0; i--) {
    accrued += metersBetween(previous, trail[i]);
    previous = trail[i];
    if (accrued >= lookbackMeters) return bearingBetween(trail[i], head);
  }
  // Short leg, or the first moments of one: usable only if it is long enough that the
  // direction is real and not the rounding of a single vertex.
  return accrued > 25 && trail.length > 0 ? bearingBetween(trail[0], head) : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(title: string, rows: [string, string][], caveat?: string | null): string {
  const body = rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');
  const note = caveat ? `<p class="isthmus-popup__caveat">${escapeHtml(caveat)}</p>` : '';
  return `<div class="isthmus-popup"><h4>${escapeHtml(title)}</h4><dl>${body}</dl>${note}</div>`;
}

function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Metres between two WGS84 points, flat-earth approximation — fine at city scale. */
function metersBetween(a: [number, number], b: [number, number]): number {
  const mLat = 111132.0;
  const mLon = 111320.0 * Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * mLon;
  const dy = (b[1] - a[1]) * mLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** A leg prepared for animation: `[lon, lat]` coordinates plus cumulative distance. */
interface AnimLeg {
  coords: [number, number][];
  cum: number[];
  total: number;
  seconds: number;
  color: string;
  label: string;
}

/** Builds the cumulative-distance table a leg needs to be walked at constant speed. */
function prepareLeg(
  path: [number, number][] | null | undefined,
  seconds: number | null | undefined,
  color: string,
  label: string,
): AnimLeg | null {
  if (!path || path.length < 2) return null;
  // Stored as [lat, lon]; GeoJSON wants [lon, lat].
  const coords: [number, number][] = path.map((p) => [p[1], p[0]]);
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + metersBetween(coords[i - 1], coords[i]));
  }
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  return { coords, cum, total, seconds: seconds ?? 0, color, label };
}

/**
 * The portion of a leg travelled at `fraction`, plus the head position — the partial
 * polyline is cut exactly at the interpolated point so the vehicle marker always sits
 * on the end of the drawn trail rather than ahead of or behind it.
 */
function sliceLeg(leg: AnimLeg, fraction: number): { coords: [number, number][]; head: [number, number] } {
  const target = Math.max(0, Math.min(1, fraction)) * leg.total;
  const out: [number, number][] = [leg.coords[0]];
  for (let i = 1; i < leg.coords.length; i++) {
    if (leg.cum[i] <= target) {
      out.push(leg.coords[i]);
      continue;
    }
    const span = leg.cum[i] - leg.cum[i - 1];
    const t = span > 0 ? (target - leg.cum[i - 1]) / span : 0;
    const head: [number, number] = [
      leg.coords[i - 1][0] + (leg.coords[i][0] - leg.coords[i - 1][0]) * t,
      leg.coords[i - 1][1] + (leg.coords[i][1] - leg.coords[i - 1][1]) * t,
    ];
    out.push(head);
    return { coords: out, head };
  }
  return { coords: out, head: leg.coords[leg.coords.length - 1] };
}

/*
 * Builds a circle as a polygon ring, because MapLibre has no circle whose radius is
 * expressed in metres — `circle-radius` is in screen pixels, so a crowd drawn that way
 * would cover four city blocks at one zoom and half a building at another. 72 points is
 * past the threshold where the straight edges are visible at street zoom.
 *
 * The longitude step is divided by cos(latitude) so the shape stays circular on the
 * ground rather than being squashed into an ellipse by the Mercator projection.
 */
function circleRing(lat: number, lon: number, radiusMeters: number, points = 72): [number, number][] {
  const latDegPerMeter = 1 / 110_574;
  const lonDegPerMeter = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    ring.push([
      lon + radiusMeters * lonDegPerMeter * Math.cos(theta),
      lat + radiusMeters * latDegPerMeter * Math.sin(theta),
    ]);
  }
  return ring;
}

function polygonFeature(ring: [number, number][], props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function lineFeature(coords: [number, number][], props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } };
}

/** Builds the `interpolate` expression that colours extrusions by height. */
function heightColorExpression(): ExpressionSpecification {
  const stops: (number | string)[] = [];
  for (const [m, c] of BUILDING_HEIGHT_RAMP) {
    stops.push(m, c);
  }
  return [
    'interpolate',
    ['linear'],
    ['get', 'h'],
    ...stops,
  ] as unknown as ExpressionSpecification;
}

/** Builds the expression that colours extrusions by where their height came from. */
function confidenceColorExpression(): ExpressionSpecification {
  return [
    'match',
    ['get', 'conf'],
    'measured',
    BUILDING_CONFIDENCE_COLORS.measured,
    'levels',
    BUILDING_CONFIDENCE_COLORS.levels,
    BUILDING_CONFIDENCE_COLORS.assumed,
  ] as unknown as ExpressionSpecification;
}

function markerElement(variant: string, glyph: string, size: number, chosen: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `isthmus-marker isthmus-marker--${variant}${chosen ? ' isthmus-marker--chosen' : ''}`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  if (glyph) {
    const span = document.createElement('span');
    span.textContent = glyph;
    el.appendChild(span);
  }
  return el;
}

/* ------------------------------------------------------------- the component -- */

export default function IsthmusMap3D({
  lines,
  buildings,
  hospitals,
  stations,
  venues,
  showNetwork = true,
  showBridges = true,
  showBuildings = true,
  estimatedSpeedOnly = false,
  hideClinics = false,
  buildingShading = 'height',
  incident = null,
  responsePath = null,
  transportPath = null,
  responseSeconds = null,
  transportSeconds = null,
  chosenHospitalId = null,
  chosenStationId = null,
  onMapClick,
  trafficMode = false,
  crowdZones = null,
  pulseOrigin = null,
  bounds = null,
  focus = null,
  focusToken = 0,
  resetToken = 0,
  frame = null,
  frameToken = 0,
  roadInspect = true,
  showDriveClock = true,
  followRoute = false,
  onVenueSelect,
  playToken = 0,
  onPlaybackEnd,
  className,
}: IsthmusMap3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const didFitRef = useRef(false);
  const homeCameraRef = useRef<{ center: LngLatLike; zoom: number; pitch: number; bearing: number } | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const rafRef = useRef<number | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Held in refs so that changing a callback never forces the map to be rebuilt.
  const clickHandlerRef = useRef<IsthmusMap3DProps['onMapClick']>(onMapClick);
  clickHandlerRef.current = onMapClick;
  const playbackEndRef = useRef<IsthmusMap3DProps['onPlaybackEnd']>(onPlaybackEnd);
  playbackEndRef.current = onPlaybackEnd;
  const venueSelectRef = useRef<IsthmusMap3DProps['onVenueSelect']>(onVenueSelect);
  venueSelectRef.current = onVenueSelect;
  // Read inside a handler registered on `load`, so it must be a ref: the prop value at
  // registration time would be frozen forever.
  const roadInspectRef = useRef(roadInspect);
  roadInspectRef.current = roadInspect;
  // Read at playback start, inside an effect that is keyed on the route rather than on
  // this flag — a ref keeps the decision current without restarting the animation.
  const followRouteRef = useRef(followRoute);
  followRouteRef.current = followRoute;

  /* --- map creation (once) --- */
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    // Built by hand rather than fetched from a style URL: the only external request
    // this scene makes is for the OSM raster tiles it was already making in 2D.
    const style: StyleSpecification = {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#070d16' } },
        {
          id: 'osm',
          type: 'raster',
          source: 'osm',
          paint: {
            // Pushes the basemap down to a dim monochrome ground plane so that the
            // data we actually loaded — roads, buildings, routes — is what reads.
            // Lake Mendota and Lake Monona still show, which matters: without the
            // water, an isthmus is not recognisably an isthmus.
            'raster-saturation': -0.72,
            'raster-brightness-max': 0.42,
            'raster-contrast': 0.08,
            'raster-opacity': 0.5,
          },
        },
      ],
      sky: {
        'sky-color': '#0d2440',
        'horizon-color': '#1d3d5c',
        'fog-color': SKY_COLOR,
        'fog-ground-blend': 0.6,
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.5,
        'atmosphere-blend': 0.7,
      },
    };

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: MADISON_FALLBACK_CENTER,
        zoom: 13.2,
        pitch: 55,
        bearing: -18,
        maxPitch: 75,
        // Antialiasing moved under canvasContextAttributes in maplibre-gl v6. It is
        // worth the fill cost here: without it the extrusion edges crawl visibly
        // against the dark basemap whenever the camera rotates.
        canvasContextAttributes: { antialias: true },
        attributionControl: { compact: true },
      });
    } catch (err) {
      // Almost always "WebGL not supported" — a headless or software-rendered
      // browser. Say so plainly instead of leaving an empty rectangle.
      setGlError(err instanceof Error ? err.message : String(err));
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('click', (e) => {
      const handler = clickHandlerRef.current;
      if (handler) handler(e.lngLat.lat, e.lngLat.lng);
    });

    map.on('error', (e) => {
      // Tile 404s and transient network errors are not worth surfacing, but a style
      // or WebGL failure leaves a blank canvas that needs explaining.
      const msg = (e?.error as Error | undefined)?.message ?? '';
      if (/webgl|context lost|style/i.test(msg)) setGlError(msg);
    });

    map.on('load', () => {
      /* --- sources: one per dataset, all starting empty --- */
      for (const id of [
        'buildings',
        'roads',
        'bridges',
        'route-plan',
        'route-done',
        'route-head',
        'zones',
        'pulse',
        'arrival',
      ]) {
        map.addSource(id, { type: 'geojson', data: emptyCollection() });
      }

      /* --- crowd and flood areas ---------------------------------------- */
      // Added before the buildings so the city rises out of the wash rather than
      // being tinted by it — a crowd is on the streets, not on the rooftops.
      map.addLayer({
        id: 'zones-fill',
        type: 'fill',
        source: 'zones',
        paint: {
          'fill-color': ['get', 'color'],
          // Scaled by severity so the dense core of a crowd reads darker than its
          // fringe without needing a second colour.
          'fill-opacity': ['get', 'fillOpacity'],
        },
      });

      map.addLayer({
        id: 'zones-edge',
        type: 'line',
        source: 'zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.5,
          'line-width': 1,
          'line-dasharray': [3, 3],
        },
      });

      /* --- buildings ---------------------------------------------------- */
      map.addLayer({
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          'fill-extrusion-color': heightColorExpression(),
          // Starts flat and is raised once after the data lands, so the city grows
          // out of the ground instead of popping into existence.
          'fill-extrusion-height': 0,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.94,
          'fill-extrusion-vertical-gradient': true,
          'fill-extrusion-height-transition': { duration: 1600, delay: 0 },
        },
      });

      // Landmarks ride in their own layer so they can be accented without
      // complicating the main colour expression.
      map.addLayer({
        id: 'buildings-landmark',
        type: 'fill-extrusion',
        source: 'buildings',
        filter: ['==', ['get', 'mark'], 1],
        paint: {
          'fill-extrusion-color': BUILDING_LANDMARK_COLOR,
          'fill-extrusion-height': 0,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.95,
          'fill-extrusion-vertical-gradient': true,
          'fill-extrusion-height-transition': { duration: 1600, delay: 200 },
        },
      });

      /* --- roads -------------------------------------------------------- */
      // Standing water, drawn first and widest: a soft navy band lying along the
      // stretches the scenario has closed. Navy rather than a new colour because the
      // lakes on this map are already that navy, so the band reads as the lake having
      // arrived somewhere it should not be.
      map.addLayer({
        id: 'roads-flood',
        type: 'line',
        source: 'roads',
        filter: ['==', ['get', 'closed'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': FLOOD_WATER_COLOR,
          'line-opacity': 0.8,
          'line-blur': 7,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 26, 17, 54],
        },
      });

      // The burn. Each congested stretch is drawn twice — this wide blurred pass
      // underneath, then the sharp line over it — which is what makes a jammed artery
      // look lit from within rather than merely tinted. Opacity comes from the
      // feature's own glow value, so free-flowing roads contribute nothing: if
      // everything glowed, nothing would read as urgent.
      map.addLayer({
        id: 'roads-glow',
        type: 'line',
        source: 'roads',
        filter: ['>', ['get', 'glow'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['*', ['get', 'glow'], 0.55],
          'line-blur': 6,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            ['*', ['get', 'w'], 2.2],
            14,
            ['*', ['get', 'w'], 5.5],
            17,
            ['*', ['get', 'w'], 12],
          ],
          'line-opacity-transition': { duration: 600, delay: 0 },
        },
      });

      map.addLayer({
        id: 'roads',
        type: 'line',
        source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.9,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            ['*', ['get', 'w'], 0.4],
            14,
            ['get', 'w'],
            17,
            ['*', ['get', 'w'], 2.6],
          ],
        },
      });

      // The closure itself, over the water: a dashed red line whose opacity breathes.
      // Dashed because a solid red line is indistinguishable from severe congestion,
      // and the difference between "slow" and "you cannot go this way" is the single
      // most important thing on this map.
      map.addLayer({
        id: 'roads-closed',
        type: 'line',
        source: 'roads',
        filter: ['==', ['get', 'closed'], 1],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#ff6b6b',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 14, 4, 17, 8],
          'line-dasharray': [1.4, 1.2],
        },
      });

      map.addLayer({
        id: 'bridges',
        type: 'line',
        source: 'bridges',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BRIDGE_COLOR,
          'line-opacity': 0.95,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 4.5, 17, 9],
        },
      });

      /* --- routes ------------------------------------------------------- */
      // The full plan sits underneath at low opacity, so the whole journey is legible
      // before and after playback; the bright layers show only what has been driven.
      map.addLayer({
        id: 'route-plan',
        type: 'line',
        source: 'route-plan',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.3,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 14, 6, 17, 12],
          'line-dasharray': [2, 1.6],
        },
      });

      map.addLayer({
        id: 'route-done-glow',
        type: 'line',
        source: 'route-done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 0.26,
          'line-blur': 10,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 12, 14, 22, 17, 40],
        },
      });

      map.addLayer({
        id: 'route-done',
        type: 'line',
        source: 'route-done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': 1,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 14, 5.5, 17, 11],
        },
      });

      map.addLayer({
        id: 'route-head-glow',
        type: 'circle',
        source: 'route-head',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.3,
          'circle-blur': 1,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 22],
        },
      });

      map.addLayer({
        id: 'route-head',
        type: 'circle',
        source: 'route-head',
        paint: {
          'circle-color': '#ffffff',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 15, 6.5],
          'circle-stroke-width': 2,
          'circle-stroke-color': ['get', 'color'],
        },
      });

      /* --- the stadium pulse -------------------------------------------- */
      // A ring that expands out of Camp Randall, redrawn as a real ground polygon on
      // every frame. It carries no data a number could not state; what it does is
      // answer "where is all this coming from?" before anyone has to ask.
      map.addLayer({
        id: 'pulse-ring',
        type: 'line',
        source: 'pulse',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['get', 'op'],
          'line-width': ['get', 'lw'],
          'line-blur': 2,
        },
      });

      /* --- arrival flashes ---------------------------------------------- */
      // Its own source rather than a second use of `pulse`, which the stadium ring
      // rewrites on every frame and would wipe this out from under itself. Two
      // moments earn a flash and no others: reaching the patient, and reaching the
      // hospital doors. Keeping it to those two is what makes them land.
      map.addLayer({
        id: 'arrival-ring',
        type: 'line',
        source: 'arrival',
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['get', 'op'],
          'line-width': ['get', 'lw'],
          'line-blur': 1.4,
        },
      });

      /* --- bridge hover readout ----------------------------------------- */
      const bridgePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
      map.on('mouseenter', 'bridges', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (!f) return;
        const nm = (f.properties?.name as string) || 'Unnamed road';
        bridgePopup.setLngLat(e.lngLat).setHTML(`<div class="isthmus-popup"><h4>${escapeHtml(nm)}</h4><dl><dt>Type</dt><dd>Bridge</dd></dl></div>`).addTo(map);
      });
      map.on('mouseleave', 'bridges', () => {
        map.getCanvas().style.cursor = '';
        bridgePopup.remove();
      });

      /* --- click a road to see why it is that colour -------------------- */
      // Every claim the colour makes is itemised here: the street's real name and real
      // OSM speed, whether that speed was measured or inferred, and what the scenario
      // did to it. A viewer who distrusts a red road can check it in two clicks.
      const roadPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 10, maxWidth: '280px' });
      map.on('click', 'roads', (e) => {
        if (!roadInspectRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties ?? {};
        const name = (p.name as string) || 'Unnamed road';
        const cong = Number(p.cong ?? 100);
        const kph = Number(p.kph ?? 0);
        const closed = Number(p.closed ?? 0) === 1;
        const estimated = Number(p.est ?? 0) === 1;
        const rows: [string, string][] = [
          ['Normally', kph > 0 ? `${Math.round(kph)} km/h` : '—'],
          ['Right now', closed ? 'Closed — impassable' : `${Math.round(kph * (cong / 100))} km/h (${cong}% of normal)`],
          ['Speed limit', estimated ? 'Inferred from road type' : 'From OpenStreetMap maxspeed'],
        ];
        roadPopup
          .setLngLat(e.lngLat)
          .setHTML(
            popupHtml(
              name,
              rows,
              closed
                ? 'Closure is modelled for this scenario. The road and its name are real OpenStreetMap data.'
                : cong < 100
                  ? 'Traffic level is modelled for this scenario. The road, its name and its speed limit are real.'
                  : null,
            ),
          )
          .addTo(map);
      });
      map.on('mouseenter', 'roads', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'roads', () => {
        map.getCanvas().style.cursor = '';
      });

      loadedRef.current = true;
      setReady(true);
    });

    mapRef.current = map;

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* --- initial extent plus a cinematic arrival, applied once --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !bounds || didFitRef.current) return;
    didFitRef.current = true;

    const bbox: LngLatBoundsLike = [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ];
    const camera = map.cameraForBounds(bbox, { padding: 40 });
    if (!camera) return;

    // Drop in from a high, flat, rotated view to the pitched working view. Honest
    // framing, and it reads as deliberate rather than as a page that failed to settle.
    map.jumpTo({ center: camera.center, zoom: (camera.zoom ?? 13) - 1.1, pitch: 0, bearing: 24 });
    const home = { center: camera.center, zoom: camera.zoom ?? 13, pitch: 55, bearing: -18 };
    // Remembered so Reset can return to exactly this framing. Recomputing it later
    // would re-fit to whatever bounds happened to be current and quietly drift.
    homeCameraRef.current = home;
    map.easeTo({ ...home, duration: 3200, essential: true });
  }, [bounds, ready]);

  /* --- fly to a place of interest ------------------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusToken || !focus) return;
    map.flyTo({
      center: [focus.longitude, focus.latitude],
      zoom: focus.zoom ?? 15.2,
      pitch: focus.pitch ?? 62,
      bearing: focus.bearing ?? -18,
      // Slow enough to follow, short enough that nobody waits. `curve` keeps the
      // swoop low rather than zooming out to orbit and back in.
      duration: 2600,
      curve: 1.3,
      essential: true,
    });
    // `focus` is read but deliberately not a dependency: the token is the trigger, so
    // that a parent re-render with the same coordinates does not re-fly the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, ready]);

  /* --- pull back until the whole journey is in shot -------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !frameToken || !frame) return;

    const camera = map.cameraForBounds(
      [
        [frame.west, frame.south],
        [frame.east, frame.north],
      ],
      // Asymmetric on purpose: the instrument stack occupies the left edge and the
      // answer card the bottom, so the route is framed into the clear glass-free area
      // rather than being centred and then half-covered.
      { padding: { top: 90, bottom: 170, left: 360, right: 80 } },
    );
    if (!camera) return;

    // `cameraForBounds` solves for a flat camera, so a pitched view of the same zoom
    // pushes the far end of the route past the horizon. Backing off a third of a zoom
    // level and keeping the pitch moderate holds the whole leg on screen.
    map.easeTo({
      center: camera.center,
      zoom: Math.max(11, (camera.zoom ?? 13) - 0.35),
      pitch: 45,
      bearing: -18,
      duration: 2400,
      essential: true,
    });
    // Keyed on the token alone — the same journey re-framed is a deliberate repeat, and
    // a parent re-render carrying identical bounds must not re-move the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameToken, ready]);

  /* --- reset to the opening view -------------------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !resetToken) return;
    const home = homeCameraRef.current;
    if (!home) return;
    map.flyTo({ ...home, duration: 2200, curve: 1.25, essential: true });
  }, [resetToken, ready]);

  /* --- crowd and flood areas ------------------------------------------ */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const features: Feature[] = (crowdZones ?? []).map((z) => {
      // A multiplier of 0.28 is a worse jam than 0.6, so the darker wash belongs to
      // the smaller number; the mapping is inverted deliberately.
      const severity = Math.max(0, Math.min(1, 1 - z.speedMultiplier));
      return polygonFeature(circleRing(z.centerLatitude, z.centerLongitude, z.radiusMeters), {
        color: 'rgb(255, 176, 32)',
        fillOpacity: 0.05 + severity * 0.12,
        reason: z.reason ?? '',
      });
    });

    (map.getSource('zones') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }, [crowdZones, ready]);

  /* --- the stadium pulse, and the breathing closure -------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const pulseSrc = map.getSource('pulse') as GeoJSONSource | undefined;

    if (!pulseOrigin) {
      pulseSrc?.setData(emptyCollection());
      if (map.getLayer('roads-closed')) map.setPaintProperty('roads-closed', 'line-opacity', 0.9);
      return;
    }

    // Three rings, evenly offset in phase, each expanding from the stadium to 2.2 km
    // over 3.6 s and fading as it goes. Reduced motion is honoured by drawing the
    // rings once at rest instead of animating them — the information (where the crowd
    // comes from) survives; only the movement is dropped.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const PERIOD = 3600;
    const MAX_RADIUS = 2200;
    const RINGS = 3;
    let frame = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const elapsed = now - start;
      const features: Feature[] = [];
      for (let i = 0; i < RINGS; i++) {
        const phase = reduced ? (i + 1) / (RINGS + 1) : ((elapsed / PERIOD + i / RINGS) % 1);
        const radius = 120 + phase * MAX_RADIUS;
        features.push(
          polygonFeature(circleRing(pulseOrigin.latitude, pulseOrigin.longitude, radius, 96), {
            color: 'rgb(255, 176, 32)',
            // Fades as it widens, so the ring dissolves instead of stopping.
            op: 0.42 * (1 - phase) * (1 - phase),
            lw: 1 + 2.2 * (1 - phase),
          }),
        );
      }
      pulseSrc?.setData({ type: 'FeatureCollection', features });

      if (map.getLayer('roads-closed')) {
        map.setPaintProperty(
          'roads-closed',
          'line-opacity',
          reduced ? 0.9 : 0.62 + 0.3 * Math.sin((elapsed / 1500) * Math.PI),
        );
      }

      if (!reduced) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frame);
  }, [pulseOrigin, ready]);

  /* --- buildings --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const visible = showBuildings && !!buildings;
    map.setLayoutProperty('buildings', 'visibility', visible ? 'visible' : 'none');
    map.setLayoutProperty('buildings-landmark', 'visibility', visible ? 'visible' : 'none');
    if (!buildings) return;

    const features: Feature[] = buildings.map((b) => ({
      type: 'Feature',
      properties: {
        h: b.heightMeters,
        kind: b.buildingKind,
        name: b.name,
        mark: b.isNotableLandmark ? 1 : 0,
        conf: b.heightConfidence,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [b.ring.map((p) => [p[1], p[0]])],
      },
    }));

    (map.getSource('buildings') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });

    // Raise them on the next frame so the height transition has something to animate
    // from; without the deferral the source update and the paint change coalesce.
    requestAnimationFrame(() => {
      if (!mapRef.current || !loadedRef.current) return;
      map.setPaintProperty('buildings', 'fill-extrusion-height', ['get', 'h']);
      map.setPaintProperty('buildings-landmark', 'fill-extrusion-height', ['get', 'h']);
    });
  }, [buildings, showBuildings, ready]);

  /* --- building shading mode --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(
      'buildings',
      'fill-extrusion-color',
      buildingShading === 'confidence' ? confidenceColorExpression() : heightColorExpression(),
    );
    // In confidence mode the landmark accent would overwrite the very thing the mode
    // exists to show, so it steps aside.
    map.setLayoutProperty(
      'buildings-landmark',
      'visibility',
      buildingShading === 'confidence' || !showBuildings ? 'none' : 'visible',
    );
  }, [buildingShading, showBuildings, ready]);

  /* --- roads --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    map.setLayoutProperty('roads', 'visibility', showNetwork ? 'visible' : 'none');
    if (!lines) return;

    const features: Feature[] = [];
    for (const line of lines) {
      if (estimatedSpeedOnly && !line.speedIsEstimated) continue;
      const style = roadStyle(line.roadClass);
      // In traffic mode the colour says how fast you can move; the class only survives
      // as line weight, which keeps the city's hierarchy legible underneath the
      // traffic. Closed stretches keep their geometry and gain a flag rather than
      // being dropped: an invisible closure looks exactly like a road that never
      // existed, and the viewer cannot tell they are being shown a consequence.
      const closed = trafficMode && line.isClosed;
      features.push(
        lineFeature(
          line.points.map((p) => [p[1], p[0]]),
          {
            color: trafficMode ? congestionColor(line.congestionPercent, line.isClosed) : style.color,
            w: style.weight,
            name: line.streetName,
            cls: line.roadClass,
            glow: trafficMode ? congestionGlow(line.congestionPercent, line.isClosed) : 0,
            closed: closed ? 1 : 0,
            cong: line.congestionPercent,
            est: line.speedIsEstimated ? 1 : 0,
            kph: line.speedKph,
          },
        ),
      );
    }
    (map.getSource('roads') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }, [lines, showNetwork, estimatedSpeedOnly, trafficMode, ready]);

  /* --- bridges, drawn separately so they are never hidden by the class colour --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    map.setLayoutProperty('bridges', 'visibility', showBridges ? 'visible' : 'none');
    if (!lines) return;

    const features: Feature[] = lines
      .filter((l) => l.isBridge)
      .map((l) => lineFeature(l.points.map((p) => [p[1], p[0]]), { name: l.streetName }));

    (map.getSource('bridges') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features,
    });
  }, [lines, showBridges, ready]);

  /* --- facilities and the incident, as HTML markers --- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    const add = (lngLat: LngLatLike, el: HTMLElement, html: string) => {
      // Without this, clicking a marker would also place an incident underneath it.
      el.addEventListener('click', (ev) => ev.stopPropagation());
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: true }).setHTML(html))
        .addTo(map);
      markersRef.current.push(marker);
    };

    for (const v of venues) {
      const isLandmark = v.venueKind === 'landmark';

      /*
       * When the page wants venues to be dispatch targets, the marker becomes a button
       * and nothing else: the same click that would have opened a facts popup now
       * places the incident and solves the route. A popup here would compete with the
       * answer card for the viewer's attention at the exact moment the answer arrives.
       */
      if (venueSelectRef.current) {
        const el = markerElement(isLandmark ? 'landmark' : 'venue', isLandmark ? '' : '▲', isLandmark ? 14 : 18, false);
        el.style.cursor = 'pointer';
        el.title = `Dispatch to ${v.name}`;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          venueSelectRef.current?.(v);
        });
        const marker = new maplibregl.Marker({ element: el }).setLngLat([v.longitude, v.latitude]).addTo(map);
        markersRef.current.push(marker);
        continue;
      }

      add(
        [v.longitude, v.latitude],
        markerElement(isLandmark ? 'landmark' : 'venue', isLandmark ? '' : '▲', isLandmark ? 14 : 18, false),
        popupHtml(
          v.name,
          [
            ['Kind', isLandmark ? 'Civic landmark' : 'Event venue'],
            ['Capacity', v.capacity ? String(v.capacity) : 'not loaded'],
            ['Snap to road', v.snapDistanceMeters ? `${Math.round(v.snapDistanceMeters)} m` : '—'],
            ['Source', v.source],
          ],
          v.capacity
            ? null
            : 'Capacity is intentionally empty: OpenStreetMap does not reliably publish it, and attendance is the main input to a game-day model, so it must not be guessed.',
        ),
      );
    }

    for (const s of stations) {
      add(
        [s.longitude, s.latitude],
        markerElement('station', '', 18, s.id === chosenStationId),
        popupHtml(s.name, [
          ['Kind', s.stationKind === 'ems_station' ? 'Ambulance station' : 'Fire station'],
          ['Operator', s.operator || 'not tagged'],
          ['Address', s.address || 'not tagged'],
          ['Snap to road', s.snapDistanceMeters ? `${Math.round(s.snapDistanceMeters)} m` : '—'],
          ['Source', s.source],
        ]),
      );
    }

    for (const h of hospitals) {
      const isEd = h.isEmergencyDestination === true;
      if (!isEd && hideClinics) continue;
      add(
        [h.longitude, h.latitude],
        markerElement(isEd ? 'ed' : 'clinic', isEd ? '+' : '', isEd ? 22 : 11, h.id === chosenHospitalId),
        popupHtml(
          h.name,
          [
            ['Facility', h.facilityKind || 'unknown'],
            ['Ambulance destination', isEd ? 'yes' : 'no'],
            ['Operator', h.operator || 'not tagged'],
            ['Address', h.address || 'not tagged'],
            ['Trauma level', h.traumaLevel ? String(h.traumaLevel) : 'not loaded'],
            ['Snap to road', h.snapDistanceMeters ? `${Math.round(h.snapDistanceMeters)} m` : '—'],
            ['Source', h.source],
          ],
          h.dataQualityNote ||
            (h.traumaLevel
              ? null
              : 'Clinical capability (trauma level, stroke centre, cath lab) is empty because OpenStreetMap does not carry it. It is left blank rather than guessed.'),
        ),
      );
    }

    if (incident) {
      add(
        [incident.longitude, incident.latitude],
        markerElement('incident', '', 20, false),
        popupHtml('Incident', [
          ['Latitude', incident.latitude.toFixed(5)],
          ['Longitude', incident.longitude.toFixed(5)],
        ]),
      );
    }
  }, [hospitals, stations, venues, incident, chosenHospitalId, chosenStationId, hideClinics, ready]);

  /* --- route playback --- */
  const legs = useMemo(() => {
    const out: AnimLeg[] = [];
    const l1 = prepareLeg(responsePath, responseSeconds, RESPONSE_LEG_COLOR, 'Responding unit to the incident');
    const l2 = prepareLeg(transportPath, transportSeconds, TRANSPORT_LEG_COLOR, 'Incident to the hospital');
    if (l1) out.push(l1);
    if (l2) out.push(l2);
    return out;
  }, [responsePath, transportPath, responseSeconds, transportSeconds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const planSrc = map.getSource('route-plan') as GeoJSONSource | undefined;
    const doneSrc = map.getSource('route-done') as GeoJSONSource | undefined;
    const headSrc = map.getSource('route-head') as GeoJSONSource | undefined;
    if (!planSrc || !doneSrc || !headSrc) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const arrivalSrc = map.getSource('arrival') as GeoJSONSource | undefined;
    /** Arrival rings currently expanding. At most two ever exist at once. */
    const flashes: { at: [number, number]; t0: number; color: string }[] = [];
    /** The leg the vehicle was on last frame, so a change means one just completed. */
    let seenLeg = -1;
    let endedAt = 0;

    /** Puts the vehicle halo back to its resting size, so a parked head stops blinking. */
    const restoreHeadGlow = () => {
      if (!map.getLayer('route-head-glow')) return;
      map.setPaintProperty('route-head-glow', 'circle-opacity', HEAD_GLOW_OPACITY);
      map.setPaintProperty('route-head-glow', 'circle-radius', [
        'interpolate',
        ['linear'],
        ['zoom'],
        11,
        HEAD_GLOW_NEAR,
        15,
        HEAD_GLOW_FAR,
      ]);
    };

    if (legs.length === 0) {
      planSrc.setData(emptyCollection());
      doneSrc.setData(emptyCollection());
      headSrc.setData(emptyCollection());
      arrivalSrc?.setData(emptyCollection());
      restoreHeadGlow();
      if (clockRef.current) clockRef.current.textContent = '';
      return;
    }

    // The whole journey, dim, so the plan is readable before playback starts.
    planSrc.setData({
      type: 'FeatureCollection',
      features: legs.map((l) => lineFeature(l.coords, { color: l.color, label: l.label })),
    });

    // Playback time is divided between the legs in proportion to real drive seconds,
    // so a leg that genuinely takes longer visibly takes longer.
    const totalSeconds = legs.reduce((a, l) => a + Math.max(l.seconds, 0.001), 0);
    const durations = legs.map((l) => (Math.max(l.seconds, 0.001) / totalSeconds) * PLAYBACK_SECONDS * 1000);

    /*
     * The chase camera lives in this same loop on purpose. Driven from its own timer
     * it could drift a frame or two out of step with the vehicle it is supposed to be
     * following, and a shot that lags its subject inconsistently looks like a bug
     * rather than like camerawork.
     */
    /*
     * Reduced motion switches the ride-along, the beacon and the arrival flashes off,
     * and leaves the framed pull-back to do the work. A camera that moves continuously
     * for nine seconds is exactly what that setting exists to prevent, and the route
     * itself still draws either way — only the flourishes are dropped.
     */
    const chasing = followRouteRef.current && !reduced;
    const cam = {
      center: [map.getCenter().lng, map.getCenter().lat] as [number, number],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      leg: -1,
      legAt: 0,
      released: false,
      last: 0,
      /** Smoothed 0–1 "how hard is the road bending", driving the lift-and-pan. */
      turn: 0,
      /** When this leg's establishing sweep began, how long it gets, and its progress. */
      orientAt: 0,
      orientMs: FOLLOW_ORIENT_MIN_MS,
      orientProgress: 0,
    };
    // A `flyTo` from the dive may still be in flight, and it writes the transform every
    // frame — without this the chase would silently lose every frame to it.
    if (chasing) map.stop();

    // The viewer's hand always wins. One drag or one wheel tick ends the shot for good:
    // a camera that springs back to its own idea of the right view feels broken.
    const release = () => {
      cam.released = true;
    };
    if (chasing) {
      map.on('dragstart', release);
      map.on('wheel', release);
    }

    const start = performance.now();
    const step = (now: number) => {
      if (!mapRef.current || !loadedRef.current) return;
      let elapsed = now - start;

      const doneFeatures: Feature[] = [];
      let head: { point: [number, number]; color: string } | null = null;
      let headLeg = -1;
      let headTrail: [number, number][] | null = null;
      let finished = true;

      for (let i = 0; i < legs.length; i++) {
        if (elapsed >= durations[i]) {
          doneFeatures.push(lineFeature(legs[i].coords, { color: legs[i].color, label: legs[i].label }));
          elapsed -= durations[i];
          continue;
        }
        const frac = elapsed / durations[i];
        const { coords, head: hp } = sliceLeg(legs[i], frac);
        doneFeatures.push(lineFeature(coords, { color: legs[i].color, label: legs[i].label }));
        head = { point: hp, color: legs[i].color };
        headLeg = i;
        headTrail = coords;
        finished = false;
        break;
      }

      doneSrc.setData({ type: 'FeatureCollection', features: doneFeatures });
      headSrc.setData(
        head
          ? {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', properties: { color: head.color }, geometry: { type: 'Point', coordinates: head.point } },
              ],
            }
          : emptyCollection(),
      );

      if (clockRef.current) {
        // The clock counts modelled drive seconds, not playback seconds, so the
        // number on screen is the one the Dispatch panel reports.
        const fraction = Math.min(1, (now - start) / (PLAYBACK_SECONDS * 1000));
        clockRef.current.textContent = formatDuration(fraction * totalSeconds);
      }

      /* --- the two moments worth marking ------------------------------- */
      if (!reduced && headLeg !== seenLeg) {
        if (seenLeg >= 0) {
          // A leg just ended. Amber for reaching the patient — the same colour the
          // stadium pulse uses for "this is where it is happening". White for the
          // hospital doors, matching the vehicle itself: the run is complete.
          const finishedLeg = legs[seenLeg];
          flashes.push({
            at: finishedLeg.coords[finishedLeg.coords.length - 1],
            t0: now,
            color: seenLeg === legs.length - 1 ? '#ffffff' : 'rgb(255, 176, 32)',
          });
        }
        seenLeg = headLeg;
      }

      if (flashes.length > 0 && arrivalSrc) {
        const ringFeatures: Feature[] = [];
        for (let i = flashes.length - 1; i >= 0; i--) {
          const age = (now - flashes[i].t0) / FLASH_MS;
          if (age >= 1) {
            flashes.splice(i, 1);
            continue;
          }
          // Two rings a beat apart, each easing outward and fading as it widens.
          for (const offset of [0, 0.22]) {
            const p = age - offset;
            if (p <= 0) continue;
            ringFeatures.push(
              polygonFeature(
                circleRing(flashes[i].at[1], flashes[i].at[0], 18 + easeOutCubic(p) * FLASH_RADIUS_M, 72),
                { color: flashes[i].color, op: 0.75 * (1 - p) * (1 - p), lw: 0.8 + 2.4 * (1 - p) },
              ),
            );
          }
        }
        arrivalSrc.setData({ type: 'FeatureCollection', features: ringFeatures });
      }

      /* --- the light bar ----------------------------------------------- */
      if (!reduced && head && map.getLayer('route-head-glow')) {
        // A halo that breathes rather than a second colour: the unit reads as a live
        // vehicle, and the palette stays at one accent plus the traffic three.
        const beat = 0.5 + 0.5 * Math.sin((now / BEACON_MS) * Math.PI * 2);
        const scale = 0.82 + 0.5 * beat;
        map.setPaintProperty('route-head-glow', 'circle-opacity', 0.2 + 0.26 * beat);
        map.setPaintProperty('route-head-glow', 'circle-radius', [
          'interpolate',
          ['linear'],
          ['zoom'],
          11,
          HEAD_GLOW_NEAR * scale,
          15,
          HEAD_GLOW_FAR * scale,
        ]);
      }

      /* --- ride along --------------------------------------------------- */
      if (chasing && !cam.released && head && headLeg >= 0) {
        if (headLeg !== cam.leg) {
          cam.leg = headLeg;
          cam.legAt = now;
          // Each leg earns its own establishing sweep, armed here and started on the
          // first frame that has enough road driven to read a heading from.
          cam.orientAt = 0;
          cam.orientProgress = 0;
        }

        /*
         * Normalise the smoothing to real frame time. Without this the camera chases
         * twice as fast on a 120 Hz display as on a 60 Hz one, which is the sort of
         * difference that only ever shows up on the one machine used for the demo.
         */
        const dt = cam.last ? Math.min(64, now - cam.last) : 16.7;
        cam.last = now;
        const approach = (ease: number) => 1 - Math.pow(1 - ease, dt / 16.7);
        const kHeight = approach(FOLLOW_HEIGHT_EASE);

        /*
         * Two readings of the same trail: where the road has been going overall, and
         * where it is going right now. The camera aims at the first and takes its cue to
         * rise from the gap between them. Neither is read off the current polyline
         * segment, so a kink in the geometry or a crossing cannot kick the view, and a
         * null (too little road driven to mean anything) holds what we have.
         */
        const trail = headTrail ?? [];
        const far = trailHeading(trail, head.point, FOLLOW_HEADING_LOOKBACK_M);
        const near = trailHeading(trail, head.point, FOLLOW_CURVE_WINDOW_M);
        const aimed = far ?? near ?? cam.bearing;

        /*
         * Answer a corner by rising, not by swinging. `turn` is how hard the road is
         * bending — the near heading running ahead of the far one — smoothed slower than
         * the bend itself, so the widening arrives and leaves as one slow breath rather
         * than flickering with every wobble in the road.
         */
        const bend = far !== null && near !== null ? Math.abs(shortestAngle(far, near)) : 0;
        cam.turn += (Math.min(1, bend / FOLLOW_TURN_FULL_DEG) - cam.turn) * approach(FOLLOW_TURN_LOAD_EASE);

        // One lift as the second leg takes over: the unit has reached the scene.
        const sinceLeg = now - cam.legAt;
        const lift =
          headLeg > 0 && sinceLeg < FOLLOW_LIFT_MS
            ? Math.sin((sinceLeg / FOLLOW_LIFT_MS) * Math.PI) * FOLLOW_LIFT_ZOOM
            : 0;
        // Blend the chase target in so the hand-over from the dive is a continuation of
        // that move rather than a second, competing one.
        const settle = easeOutCubic(Math.min(1, (now - start) / FOLLOW_SETTLE_MS));
        const kTurn = approach(FOLLOW_TURN_EASE);
        const zoomTarget = FOLLOW_ZOOM - lift - FOLLOW_TURN_ZOOM_OUT * cam.turn;
        const pitchTarget = FOLLOW_PITCH - FOLLOW_TURN_PITCH_DROP * cam.turn;
        const wantZoom = cam.zoom + (zoomTarget - cam.zoom) * settle;
        const wantPitch = cam.pitch + (pitchTarget - cam.pitch) * settle;

        /*
         * Position is the one term allowed to hurry: the vehicle must stay in frame and
         * must not appear to slow down because the camera did. Normally this is the
         * plain lazy ease; if the gap ever opens past `FOLLOW_LAG_CATCHUP_M` the ease
         * firms up in proportion until it closes again.
         */
        const lagMeters = metersBetween(cam.center, head.point);
        const urgency = Math.max(1, lagMeters / FOLLOW_LAG_CATCHUP_M);
        const kCenter = Math.min(1, approach(FOLLOW_EASE) * urgency);
        cam.center = [
          cam.center[0] + (head.point[0] - cam.center[0]) * kCenter,
          cam.center[1] + (head.point[1] - cam.center[1]) * kCenter,
        ];

        cam.zoom += (wantZoom - cam.zoom) * kHeight;
        cam.pitch += (wantPitch - cam.pitch) * kHeight;

        const toAim = shortestAngle(cam.bearing, aimed);
        if (far !== null && cam.orientAt === 0) {
          // Arm the sweep for this leg, long enough to cover the turn at the sweep rate.
          cam.orientAt = now;
          cam.orientMs = Math.min(
            FOLLOW_ORIENT_MAX_MS,
            Math.max(FOLLOW_ORIENT_MIN_MS, (Math.abs(toAim) / FOLLOW_ORIENT_DPS) * 1000),
          );
        }

        if (cam.orientAt > 0 && now - cam.orientAt < cam.orientMs) {
          /*
           * The establishing sweep. Rather than easing toward the heading and hoping to
           * arrive, take the share of the *remaining* error that puts the whole turn on
           * an ease-in-out curve finishing exactly at the deadline. Expressed this way
           * the sweep still lands on time if the heading drifts mid-turn, and it
           * decelerates into the settled shot instead of stopping dead.
           */
          const progress = Math.min(1, (now - cam.orientAt) / cam.orientMs);
          const was = easeInOutSine(cam.orientProgress);
          const isNow = easeInOutSine(progress);
          cam.orientProgress = progress;
          const share = was < 1 ? Math.min(1, (isNow - was) / (1 - was)) : 1;
          const sweepMax = (FOLLOW_ORIENT_MAX_DPS * dt) / 1000;
          cam.bearing += Math.max(-sweepMax, Math.min(sweepMax, toAim * share));
        } else {
          /*
           * Settled: ease toward the heading, then clamp how far that rotation was
           * allowed to get this frame. The ease is front-loaded by nature — its first
           * frames of a correction are its fastest — so the ceiling, not the ease, is
           * what keeps a bend reading as a slow pan.
           */
          const maxStep = (FOLLOW_TURN_MAX_DPS * dt) / 1000;
          cam.bearing += Math.max(-maxStep, Math.min(maxStep, toAim * kTurn));
        }

        map.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch });
      }

      if (finished) {
        // Report the arrival once, then keep the loop alive just long enough for the
        // hospital flash to finish expanding — returning here would delete it on the
        // very frame it was created.
        if (!endedAt) {
          endedAt = now;
          restoreHeadGlow();
          if (playbackEndRef.current) playbackEndRef.current();
        }
        if (flashes.length === 0) {
          arrivalSrc?.setData(emptyCollection());
          rafRef.current = null;
          return;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (chasing) {
        map.off('dragstart', release);
        map.off('wheel', release);
      }
      // A run cut short by a new dispatch must not leave a half-expanded ring or a
      // blinking halo behind for the next one to inherit.
      arrivalSrc?.setData(emptyCollection());
      restoreHeadGlow();
    };
  }, [legs, playToken, ready]);

  /* --- keep the GL canvas sized to its container --- */
  const resize = useCallback(() => {
    mapRef.current?.resize();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);

  const classes = useMemo(
    () => ['isthmus-map3d', onMapClick ? 'isthmus-map3d--clickable' : '', className ?? ''].filter(Boolean).join(' '),
    [onMapClick, className],
  );

  return (
    <div className={classes}>
      <div ref={containerRef} className="isthmus-map3d__canvas" />
      {showDriveClock && legs.length > 0 && (
        <div className="isthmus-map3d__clock">
          <span className="isthmus-map3d__clock-label">Drive time</span>
          <span ref={clockRef} className="isthmus-map3d__clock-value" />
        </div>
      )}
      {glError && (
        <div className="isthmus-map3d__error">
          <p className="font-semibold">The 3D scene could not start.</p>
          <p className="isthmus-map3d__error-detail">{glError}</p>
          <p>
            This view needs WebGL. It is usually missing in a headless or
            software-rendered browser rather than a real one.
          </p>
        </div>
      )}
    </div>
  );
}
