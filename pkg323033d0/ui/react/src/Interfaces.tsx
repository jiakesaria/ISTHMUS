/*
 * Copyright 2009-2025 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import { ReactElement } from 'react';

export interface User {
  id: string;
  name: string;
  email: string;
  lastName: string;
  firstName: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
}

export interface SnackbarMessage {
  message: ReactElement;
  key: number;
  severity?: 'success' | 'info' | 'warning' | 'error';
  error?: boolean;
}

/** Sample / API document row (examples + fetchDocuments). */
export interface Document {
  documentName: string;
  program: string;
  owner: string;
  checklistApplied: string;
  attachments: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ProgramDocument {
  documentName: string;
  owner: string;
  status: string;
  uploadedAt: string;
}

/** Program row with optional nested documents (examples + fetchPrograms). */
export interface Program {
  id: string;
  program: string;
  totalDocuments: number;
  passed: number;
  failed: number;
  pending: number;
  documents?: ProgramDocument[];
}

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string;
  estimatedTime: string;
}

/* ------------------------------------------------------------------------- *
 * ISTHMUS — Madison isthmus / UW-Madison campus EMS digital twin.
 *
 * These mirror the C3 entity and value types in `pkg323033d0/src/`. Every one
 * of them is populated from the C3 backend via `c3Action`; none is hardcoded.
 * ------------------------------------------------------------------------- */

/** A reference to another C3 entity, when only its identity was included. */
export interface C3Ref {
  id: string;
}

/** Graph vertex — an intersection in the routable road network. */
export interface RoadNode {
  id: string;
  latitude: number;
  longitude: number;
  osmNodeId?: string;
  inCoreArea?: boolean;
  source: string;
}

/** One directed drivable edge between two {@link RoadNode}s. */
export interface RoadSegment {
  id: string;
  streetName?: string;
  lengthMeters: number;
  freeFlowSpeedKph: number;
  freeFlowTravelTimeSeconds: number;
  roadClass?: string;
  laneCount?: number;
  isOneway?: boolean;
  isBridge?: boolean;
  isTunnel?: boolean;
  geometry?: string;
  osmWayId?: string;
  osmSequence?: number;
  speedIsEstimated: boolean;
  speedSource?: string;
  source: string;
}

/**
 * A healthcare facility. Note `isEmergencyDestination` — most rows are clinics
 * that cannot receive an ambulance, and the UI must filter on this rather than
 * assuming every row is a hospital.
 */
export interface Hospital {
  id: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  nearestNode?: C3Ref;
  snapDistanceMeters?: number;
  facilityKind?: string;
  hasEmergency?: boolean;
  isEmergencyDestination?: boolean;
  operator?: string;
  source: string;
  /** Null after an OpenStreetMap-only load — never render a guess here. */
  traumaLevel?: number;
  capabilitySource?: string;
  dataQualityNote?: string;
}

/** A fire station or ambulance station — an EMS response origin. */
export interface EmsStation {
  id: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  nearestNode?: C3Ref;
  snapDistanceMeters?: number;
  stationKind?: string;
  operator?: string;
  source: string;
}

/** A stadium, arena or civic landmark — the game-day crowd generators. */
export interface Venue {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  nearestNode?: C3Ref;
  snapDistanceMeters?: number;
  venueKind?: string;
  /** Null after an OpenStreetMap-only load. */
  capacity?: number;
  capacitySource?: string;
  source: string;
}

/** Named set of conditions the network is evaluated under. */
export interface Scenario {
  id: string;
  name: string;
  description?: string;
  scenarioKind?: string;
  isBaseline?: boolean;
  ambulanceSpeedFactor?: number;
  source: string;
  notes?: string;
}

/** Provenance manifest for the OpenStreetMap extraction run. */
export interface OsmDataLoad {
  id: string;
  sourceApi: string;
  sourceLicense: string;
  bboxSouth: number;
  bboxNorth: number;
  bboxWest: number;
  bboxEast: number;
  coreBboxSouth: number;
  coreBboxNorth: number;
  coreBboxWest: number;
  coreBboxEast: number;
  rawTileCount?: number;
  rawBytes?: number;
  rawChecksumSha256?: string;
  rawPath?: string;
  recordCounts?: string;
  notes?: string;
}

/**
 * Raw map payload from `EmsRouter.mapNetwork`. The polylines arrive as a JSON
 * string in `linesJson` rather than typed objects because the payload is almost
 * entirely coordinates — see {@link parseNetworkLines}.
 */
export interface MapNetworkDto {
  linesJson: string;
  lineCount: number;
  segmentCount: number;
  nodeCount: number;
  bridgeCount: number;
  estimatedSpeedCount: number;
  observedSpeedCount: number;
  attribution: string;
  bboxSouth: number;
  bboxNorth: number;
  bboxWest: number;
  bboxEast: number;
  /**
   * The scenario the congestion figures in `linesJson` were computed under. Always
   * populated, so traffic colours can always be attributed to stated conditions.
   */
  scenarioId?: string;
  scenarioName?: string;
  /** Polylines this scenario closes outright; zero under the baseline. */
  closedLineCount?: number;
  /** Polylines it slows without closing; zero under the baseline. */
  slowedLineCount?: number;
}

/**
 * One OpenStreetMap building footprint, as stored. The 3D scene does not use this
 * shape — it reads the packed {@link MapBuildingsDto} instead — but the Provenance
 * page needs the per-row fields to show how a height was arrived at.
 */
export interface Building {
  id: string;
  osmWayId?: string;
  name?: string;
  buildingKind?: string;
  centroidLatitude: number;
  centroidLongitude: number;
  footprint: string;
  areaSquareMeters?: number;
  /** Null when OpenStreetMap carries no `building:levels` tag — most of the time. */
  levels?: number;
  heightMeters: number;
  /** True for ~99.9% of this extract. Never render the height as a fact without it. */
  heightIsEstimated: boolean;
  heightSource?: string;
  inCoreArea?: boolean;
  isNotableLandmark?: boolean;
  source: string;
}

/**
 * Raw building payload from `EmsRouter.mapBuildings`. Like {@link MapNetworkDto} the
 * geometry arrives as a JSON string — see {@link parseSceneBuildings} — and the height
 * provenance counts travel with it so the scene can never be drawn without them.
 */
export interface MapBuildingsDto {
  buildingsJson: string;
  buildingCount: number;
  totalBuildingCount: number;
  estimatedHeightCount: number;
  realHeightCount: number;
  levelsHeightCount: number;
  namedCount: number;
  landmarkCount: number;
  tallestMeters: number;
  attribution: string;
  bboxSouth: number;
  bboxNorth: number;
  bboxWest: number;
  bboxEast: number;
}

/**
 * How a building's height was arrived at. Three-way rather than a boolean because a
 * storey count is real evidence about *this* building while a class default is no
 * evidence at all, and the 3D scene colours them differently on purpose.
 */
export type BuildingHeightConfidence = 'measured' | 'levels' | 'assumed';

/** One extrudable building, decoded from `MapBuildingsDto.buildingsJson`. */
export interface SceneBuilding {
  heightMeters: number;
  buildingKind: string;
  heightConfidence: BuildingHeightConfidence;
  isNotableLandmark: boolean;
  /** Empty string when the building carries no OSM `name` tag. */
  name: string;
  /** Closed ring as `[latitude, longitude]`; GeoJSON needs the pair swapped. */
  ring: [number, number][];
}

/** One drawable road, decoded from `MapNetworkDto.linesJson`. */
export interface NetworkLine {
  roadClass: string;
  streetName: string;
  isBridge: boolean;
  isOneway: boolean;
  speedIsEstimated: boolean;
  speedKph: number;
  points: [number, number][];
  /**
   * How fast traffic moves on this stretch as a percentage of free flow under the
   * requested scenario: 100 is unaffected, 28 means a crawl. Always present — the
   * baseline reports 100 — so the map never has to guess at a missing value.
   */
  congestionPercent: number;
  /**
   * True when the scenario removes this stretch from the routable graph. Closed
   * stretches are still delivered and still drawn: a closure the viewer cannot see is
   * indistinguishable from a road that was never in the extract.
   */
  isClosed: boolean;
}

/**
 * What a scenario costs, measured by solving the whole city under the baseline and
 * again under the scenario. Mirrors the backend `ScenarioImpact` value type; see that
 * type for why the headline is a ratio rather than a count of minutes.
 */
export interface ScenarioImpactDto {
  scenarioId: string;
  scenarioName?: string;
  baselineScenarioId?: string;
  pointCount?: number;
  comparedCount?: number;
  strandedCount?: number;
  baselineResponseSeconds?: number;
  scenarioResponseSeconds?: number;
  responseRatio?: number;
  baselineTotalSeconds?: number;
  scenarioTotalSeconds?: number;
  worstLatitude?: number;
  worstLongitude?: number;
  worstBaselineSeconds?: number;
  worstScenarioSeconds?: number;
  worstStreetName?: string;
  closedEdgeCount?: number;
  closureReason?: string;
  caveat: string;
}

/** One road-level condition a scenario imposes, with the words that justify it. */
export interface ScenarioRoadOverlay {
  id: string;
  osmWayId?: string;
  isClosed?: boolean;
  speedMultiplier?: number;
  reason?: string;
  source: string;
}

/**
 * One circular area a scenario slows down — a crowd, a flooded district. Multipliers
 * compound where zones overlap, which is intended: a crowd inside a flood zone is
 * slower than either alone.
 */
export interface ScenarioZoneOverlay {
  id: string;
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
  speedMultiplier: number;
  reason?: string;
  source: string;
}

/** A scenario with its overlays attached, for the conditions panel. */
export interface ScenarioDetail extends Scenario {
  roadOverlays?: ScenarioRoadOverlay[];
  zoneOverlays?: ScenarioZoneOverlay[];
}

/** One leg of a response — station to incident, or incident to hospital. */
export interface RouteLeg {
  fromLabel?: string;
  toLabel?: string;
  seconds: number;
  meters: number;
  geometry: string;
  segmentIds?: string[];
  streets?: string[];
  estimatedSpeedSegmentCount?: number;
  segmentCount?: number;
  bridgeCount?: number;
}

/** A candidate destination hospital's travel time from the incident. */
export interface HospitalEta {
  hospitalId: string;
  hospitalName: string;
  seconds?: number | null;
  meters?: number | null;
  isReachable: boolean;
  excludedReason?: string | null;
}

/** A candidate responding station's time to reach the incident. */
export interface StationEta {
  stationId: string;
  stationName: string;
  stationKind?: string;
  seconds?: number | null;
  meters?: number | null;
  isReachable: boolean;
}

/** The computed answer to "an emergency happened here — what happens next". */
export interface ResponsePlan {
  scenarioId: string;
  scenarioName: string;
  incidentLatitude: number;
  incidentLongitude: number;
  incidentNodeId: string;
  incidentSnapMeters: number;
  stationId?: string | null;
  stationName?: string | null;
  hospitalId?: string | null;
  hospitalName?: string | null;
  responseLeg?: RouteLeg | null;
  transportLeg?: RouteLeg | null;
  totalSeconds?: number | null;
  candidateHospitals: HospitalEta[];
  candidateStations: StationEta[];
  warnings: string[];
}
