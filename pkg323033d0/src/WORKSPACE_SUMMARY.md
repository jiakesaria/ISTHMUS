# Workspace Summary

> This is the **work-to-date** summary of this workspace. It starts from the template's initial
> state below and **you (the agent) keep it updated** as you make meaningful changes (new/renamed
> types, new UI pages/routes, seed/data, key decisions). Read it first at the start of a chat to
> recall what has been done; update it as you go. Keep it concise — a map, not a transcript.

## Current state

**ISTHMUS** — a C3 digital twin of the Madison WI isthmus and the UW–Madison campus, built to
answer one question: *an emergency happens at point X; which unit reaches it first, which hospital
can it reach fastest, and which road or bridge closure hurts that answer most?*

Phases 1–3 are complete and running: the road network, facilities and venues are loaded from real
OpenStreetMap data; a two-Dijkstra routing engine solves response + transport legs against a
scenario overlay; **one authored scenario (post-game surge + John Nolen Drive flooding) is modelled
end-to-end and measured against the baseline at every intersection**; and a night-ops control room
renders it as a full-bleed traffic scene. Not built: a time scrubber, ambulance reroute trails, a
before/after wipe, hospital beacon columns, persisted incidents, a road-criticality sweep.

- **Backend (`src/`):** 7 entity types, 4 scenario-overlay types, 7 value types, 1 service type.
- **UI:** 4 routed pages, all fetching through `c3Action`. No mock data files remain. The map is a
  3D MapLibre GL scene with extruded buildings, traffic-coloured roads, flood water, a stadium
  pulse ring and animated route playback.
- **Data:** 21,457 OSM-derived rows in the database + 2 `Scenario` rows, 44 road overlays and
  4 zone overlays in `data/`.

## Packages

- `pkg323033d0` — the only package. Everything below lives in it.

## Backend types

### Network (the immutable base graph)

| Type | Id prefix | Role |
| --- | --- | --- |
| `RoadNode` | `ISTH_ROAD_NODE` | Graph vertex — an intersection. `inCoreArea` flags the core box. |
| `RoadSegment` | `ISTH_ROAD_SEGMENT` | **Directed** drivable edge (two rows per two-way street). Carries `lengthMeters`, `freeFlowSpeedKph`, `speedIsEstimated`, `speedSource`, `isBridge`, `isOneway`, `geometry`, `osmWayId`/`osmSequence`. |
| `Hospital` | `ISTH_HOSPITAL` | Healthcare facility. **Most rows are clinics** — filter on `isEmergencyDestination`. Clinical-capability fields are intentionally null. |
| `EmsStation` | `ISTH_EMS_STATION` | Fire / ambulance station — a response origin. |
| `Venue` | `ISTH_VENUE` | Stadium, arena or civic landmark. `capacity` intentionally null. |
| `Building` | `ISTH_BUILDING` | OSM footprint for the 3D scene. **Plays no part in routing.** Real `footprint` ring, but `heightMeters` is inferred for 99.86% of rows — always read `heightIsEstimated` / `heightSource` (`osm:height` \| `osm:building:levels` \| `osm:building:class-default`). |
| `OsmDataLoad` | `ISTH_OSM_DATA_LOAD` | Provenance manifest: both bboxes, tile count, raw bytes, SHA-256, record counts, notes. |

### Scenario overlay (how conditions are applied)

| Type | Id prefix | Role |
| --- | --- | --- |
| `Scenario` | `ISTH_SCENARIO` | Named set of conditions. `isBaseline` marks the undegraded case; `ambulanceSpeedFactor` is an **estimated** modelling assumption. |
| `ScenarioRoadOverlay` | `ISTH_SCN_ROAD` | Closes or slows a segment, or every directed edge of an `osmWayId`. |
| `ScenarioZoneOverlay` | `ISTH_SCN_ZONE` | Circular congestion zone (centre + radius + multiplier). |
| `ScenarioHospitalOverlay` | `ISTH_SCN_HOSP` | Diversion / ED wait for one hospital. |

### Routing

- `EmsRouter` (plain service type, `src/EmsRouter.js`) — four methods:
  - `mapNetwork(scenarioId)` — drawable network. Passing a scenario stamps every polyline with
    `congestionPercent` and `isClosed` and sets `scenarioName` / `closedLineCount` /
    `slowedLineCount`; passing null draws the plain base graph. ~970 ms, ~700 KB under the flood.
  - `mapBuildings(minAreaSquareMeters)` — **takes no scenario**: buildings are scenery no overlay
    can change, so the payload is fetched once per page.
  - `respond(latitude, longitude, scenarioId)` — the two-leg response plan.
  - `scenarioImpact(scenarioId)` — scores a scenario against its baseline **exhaustively**, at
    every one of the 2,436 modelled intersections, and returns the single worst-hit point with the
    street name it sits on. ~1.5 s.
- Value types: `RouteLeg`, `HospitalEta`, `StationEta`, `ResponsePlan`, `MapNetwork`,
  `MapBuildings`, `ScenarioImpact`.
- `MapNetwork.linesJson` and `MapBuildings.buildingsJson` use **positional-array encoding**
  (documented field-by-field in the `.c3typ`) so tens of thousands of coordinates are not wrapped
  in repeated field names. Buildings use 6 decimal places, roads 5 — an extruded wall shows a
  metre of error far more plainly than a road centreline does. `linesJson` is a **9-tuple**:
  `[roadClass, streetName, isBridge, isOneway, speedIsEstimated, speedKph, points,
  congestionPercent, isClosed]`; the frontend decoder tolerates the last two as absent so a cached
  older payload still draws, as unaffected traffic.

## UI pages / routes

| Route | Component | Shows |
| --- | --- | --- |
| `/` | `pages/Ops/Ops.tsx` | **The control room** — the demo surface, and deliberately only two gestures: *pick a condition* and *click a point*. Clicking anywhere on the map, or any venue marker, dispatches to that point in **three camera moves**: dive onto the point, then *ride along with the ambulance* (a low pitched chase camera that turns with the route, lifts at the hospital hand-off and flashes a ring at each arrival), then pull back until the whole journey is in shot. The answer lands in one bottom-centre card — fastest hospital, responding station, total, and the two legs. Flipping the conditions switch (*Normal* ⇄ *Post-game + flood*) recolours every road by traffic, floods John Nolen Drive, washes in the crowd zones, pulses a ring out of Camp Randall — and **re-solves the open incident**, so the viewer watches the destination hospital itself change. Chrome is the ISTHMUS wordmark and two panels top-left (Conditions, with just *Response avg* and *Times slower*; and Map key) plus keyboard shortcuts (space / R / Esc); the column is height-capped so it can never collide with MapLibre's own scale bar and credit. |
| `/model` | `pages/CityModel/CityModel.tsx` | The base twin in 3D: extruded buildings, network, facilities, venues, layer toggles, a height/confidence shading switch, legend, and both the speed and building-height estimated-vs-observed splits. |
| `/dispatch` | `pages/Dispatch/Dispatch.tsx` | Click-to-place incident → both legs drawn, timed and **animated** (a vehicle head traces the route, clock counting modelled drive seconds) with a Replay control, ranked candidate hospitals and stations, and the engine's `warnings` rendered verbatim. |
| `/provenance` | `pages/Provenance/Provenance.tsx` | Source, licence, checksum, live-vs-manifest row counts, scenario assumptions, building-height provenance, and the "empty on purpose" table. |

Shared frontend code:

- `components/Map/IsthmusMap3D.tsx` + `isthmusMap3d.css` — imperative **MapLibre GL** 3D scene:
  `fill-extrusion` buildings, dark-recoloured OSM raster basemap, cinematic camera arrival, and
  animated route playback. One `useEffect` per concern. (The former Leaflet `IsthmusMap` has been
  deleted; `leaflet`/`react-leaflet` remain in `package.json` but are now unimported.)
  Scenario layers added in draw order: `zones-fill`/`zones-edge` (crowd wash, drawn *under* the
  buildings so the city rises out of it) → `roads-flood` (wide, blurred lake navy) → `roads-glow`
  (wide blurry under-stroke, opacity = congestion) → `roads` (thin sharp over-stroke) →
  `roads-closed` (dashed, breathing opacity) → bridges/routes → `pulse-ring` → `arrival-ring`
  (expanding rings at each arrival; its own `arrival` source, because the stadium pulse rewrites
  `pulse` every frame). Props
  `trafficMode` / `crowdZones` / `pulseOrigin` / `resetToken` drive the scenario look.
  Camera and interaction props: `focus`+`focusToken` dives to a point, `frame`+`frameToken` eases
  out to fit a bbox (the two halves of the dispatch move), `roadInspect` (default **true**) gates
  the click-a-road popup so the control room can spend a click on dispatching instead, and
  `onVenueSelect` turns venue markers from popups into dispatch buttons. `followRoute` (default
  **false**) turns route playback into a chase camera that rides with the vehicle head, and
  `onPlaybackEnd` fires on arrival so the caller can decide what the camera does next;
  `showDriveClock` (default **true**) hides the in-map drive-time readout, which the control room
  turns off because it sits under the wordmark. Every one of these defaults to the old behaviour,
  so `/model` and `/dispatch` are untouched by the control-room rework. One
  `requestAnimationFrame` loop serves both the pulse and the closed-road breathing, and it draws a
  single static frame instead under `prefers-reduced-motion`.
- `components/Ops/OpsChrome.tsx` + `ops.css` — the control-room instrument kit: `GlassPanel`,
  `Readout` (counts to its value by writing `textContent` per frame, never `setState`), `Delta`,
  `ScenarioSwitch`, `TrafficLegend`, `DataChip`, `StatusLine`, plus the alert rail and reveal
  animations. Hand-written CSS rather than design-system tokens, because this surface needs a dark
  palette, a glass recipe and a monospace instrument face the light `--c3-style-basic-*` vocabulary
  does not provide; the other three pages still use the design system.
- `lib/isthmus.ts` — the only place the UI talks to the backend: `fetchMapNetwork(scenarioId)`,
  `parseNetworkLines`, `fetchMapBuildings`, `parseSceneBuildings`,
  `fetchHospitals`/`Stations`/`Venues`/`Scenarios`/`DataLoad`, `fetchScenarioDetail`,
  `fetchScenarioImpact`, `fetchLiveCounts`, `requestResponsePlan`, plus road styling, the
  traffic colour/glow ramps, building shading ramps and duration/distance formatting.
- `Interfaces.tsx` — ISTHMUS block mirroring every type above.
- `config/navigation.ts` — four nav items (Operations / City Model / Dispatch / Data & Provenance),
  matching the four routes in `App.tsx`.

Deleted from the template: `pages/Dashboard/` and `data/sampleData.ts` (dummy data).

## Seed / data

- `data/Scenario/SCN_baseline.json` — the baseline scenario row. Load with `upsertSeedData`.
- `data/Scenario/SCN_gameday_flood.json` — **"Post-game surge + John Nolen flooding."** The one
  authored scenario, built from `data/ScenarioRoadOverlay/scenarioroadoverlay.json` (44 rows: 36
  closures on the flooded John Nolen Drive causeway + 8 slow rows for standing water on North Shore
  Drive) and `data/ScenarioZoneOverlay/scenariozoneoverlay.json` (4 rows: Capitol Square ×0.6
  r1000 m, South Park Street ×0.45 r900 m, stadium approach ×0.55 r1700 m, Camp Randall egress
  ×0.28 r650 m — the last two centred on the real `Venue` row for Camp Randall Stadium).
  Every overlay carries its own plain-English `reason`, which the control room quotes **verbatim**
  rather than paraphrasing, and a `source` marking it modelled.
- `data/Building/building.json` — 9,959 footprints, generated by `isthmus-etl/build_buildings.py`
  from the **same cached OSM tiles** as the network (no second download).
- Network, facility and venue rows (11,498) were written by the OSM extraction and live in the
  database; the raw tiles and their SHA-256 are recorded in `OsmDataLoad/LOAD_osm_isthmus_v1`.
  Counts: RoadNode 3,432 · RoadSegment 8,032 · Hospital 21 (5 EDs) · EmsStation 6 · Venue 6 ·
  Building 9,959 (14 measured height / 1,691 from storey count / 8,254 class default).

## Key decisions

1. **Scenario-as-overlay, never a mutated network.** The base graph is immutable; a scenario is
   read as a set of overlays and collapses to one number per edge in exactly one place:
   `effectiveSpeed = freeFlowSpeedKph × ambulanceSpeedFactor × zoneMultiplier × roadMultiplier`.
   Closed edges are dropped from the graph rather than given a huge weight, so "unreachable" is
   reported honestly instead of as a very slow route.
2. **The baseline is a real `Scenario` row, not a null special case.** Every routing call takes a
   `scenarioId` from day one, so adding game-day conditions changes data, not signatures.
3. **Two independent Dijkstras.** Reverse search over inbound edges finds the responding station;
   forward search finds the destination ED. Madison's one-way couplets make inbound ≠ reverse of
   outbound, so the legs genuinely differ and are solved separately.
4. **Directed edges, collapsed only for drawing.** Two rows per two-way street for correctness;
   `mapNetwork()` dedupes on `osmWayId:osmSequence` to emit ~4,700 polylines instead of 8,032.
5. **No graph cache.** A full graph fetch is ~280 ms, so a scenario edit takes effect immediately
   with nothing to invalidate.
6. **Estimates are labelled, never laundered.** `speedIsEstimated` / `speedSource` per segment
   (68% estimated from road class), `ambulanceSpeedFactor` documented as an assumption, and
   unknown fields (`Hospital.traumaLevel`, `Venue.capacity`) left **null** rather than guessed.
   Travel times are comparative, not predictive — the UI says so on every page.
7. **Buildings are scenery, and say so.** They exist for comprehension, not computation — response
   times are solved entirely on the `RoadSegment` graph, so no height can move a travel time. Since
   99.86% of heights are inferred, the scene ships a **Height confidence** shading mode that paints
   measured / storey-count / class-default in three colours. Exquisite must never mean quietly
   fictional, so the viewer can always see which parts of the skyline are evidence.
8. **Imperative MapLibre GL, not a React wrapper.** 4,700 polylines plus ~10,000 extrusions as
   React elements would reconcile on every state change. One `useEffect` per concern instead.
   Three deliberate constraints: **no glyph server is configured**, so there are no `symbol` text
   layers at all — every label is an HTML `Marker`/`Popup`; **no terrain**, which would need an API
   key (and the isthmus is flat); and the basemap is the *same* OSM raster recoloured dark with
   `raster-saturation`/`-brightness-max`/`-contrast`, so there is **no new tile provider and no API
   key**. Water is kept visible because without it an isthmus is not recognisably an isthmus.
9. **MapLibre's worker URL must be set explicitly.** It defaults to `./maplibre-gl-worker.mjs`
   beside its own module, which under a bundler 404s and leaves the map blank with only a
   "Worker failed to load" console error. `IsthmusMap3D.tsx` imports it via Vite's `?url` and calls
   `setWorkerUrl`, which emits the worker as a real asset. Verified in dev and in `vite build`.
10. **No frontend fallback data.** A failed `c3Action` surfaces as a visible error banner; there is
    nothing for the UI to silently degrade to. WebGL failure is surfaced the same way, in an
    explicit panel rather than as a blank rectangle.
11. **The scenario moves no roads — only which roads traffic can use.** Nothing in the base graph
    is edited to stage the flood: the geometry, the speed limits, the stations and the hospitals are
    identical in both states. That is what makes the 1.76× comparable, and the control room says so
    on the weak-point card in those words.
12. **Exhaustive, not sampled.** `scenarioImpact` was first drafted to sample points, but inverting
    the search made sampling pointless: one forward Dijkstra per station plus one reverse per ED —
    11 searches per graph, 22 for the pair — yields the exact response and transport time at
    *every* vertex. Scoring all 2,436 intersections is therefore cheaper than defending a sample,
    and "the worst spot in the city" is a real maximum rather than the worst of a draw.
13. **One accent, and no fourth hue for the flood.** The palette is amber plus traffic
    green/amber/red. Standing water reuses the **existing lake navy** (`#1b4a7a`), so a flooded road
    reads as "the lake is here now" without spending a colour; closed is distinguished from merely
    jammed by a dash pattern and a breathing opacity, not by a new colour — which also keeps the
    legend line "Jammed or closed" truthful. The traffic ramp is continuous rather than banded, and
    flat above 85%, so rounding noise cannot make the whole city look faintly degraded.
14. **Palette constants are duplicated on purpose.** `TRAFFIC_CLEAR/SLOW/BLOCKED` in `lib/isthmus.ts`
    restate `--ops-clear/--ops-slow/--ops-blocked` from `ops.css`, because MapLibre paint properties
    take colour strings and cannot read CSS variables. Both files carry a comment saying a change
    must be made in both places — a map that disagrees with its own key is worse than no key.
15. **MapLibre has no metres-based circle radius**, so the crowd zones and the stadium pulse are
    generated 72/96-point **polygon rings** in geographic degrees. A `circle` layer's radius is in
    screen pixels, which would make a 650 m zone grow and shrink as the operator zooms — the
    opposite of what a zone means.
16. **Prefetch the scenario, do not make them wait for it.** The baseline loads first and the flood
    network + impact are fetched 1.2 s later in the background and cached, so the switch is instant
    the first time it is flipped. Prefetch failures are swallowed: the user has not asked for
    anything yet, so there is nothing to report. A cache miss falls back to a visible busy state
    that dims the switch **without resizing it**, so a re-solve never reflows the panel under the
    pointer.
17. **The control room earns its clicks.** Every panel that only *described* the scene was removed
    (both "What you are looking at" cards, the weak-point card, the second conditions panel) and the
    readouts cut to two — response average and the slowdown multiple. What replaced them is not more
    chrome but an action: a click anywhere on the map is a dispatch. The page now teaches itself,
    because the only two things it accepts are the only two variables in the question it answers —
    *where* and *under what conditions*.
18. **The camera dive is held open until the route can play.** Dispatch is two moves: dive to the
    incident (`focusToken`), then pull back to frame the journey (`frameToken`). The solve usually
    returns in well under the 1,300 ms dive, so the plan is parked in a timer until the dive lands —
    otherwise the route animation would start mid-dive and the viewer would never see the ambulance
    leave. A `reqIdRef` generation counter discards a slow solve that lands after a newer click.
    `cameraForBounds` solves for a **flat** camera, so the pitched ease subtracts 0.35 zoom or the
    far end of the route falls past the horizon.
19. **Flipping conditions re-solves the open incident rather than recolouring under it.** Under the
    flood, Camp Randall's fastest ER changes from UnityPoint Meriter (140 s) to the William S.
    Middleton VA (669 s), because the nearer ER is now across a closed causeway. Repainting traffic
    while leaving the old answer on screen would have hidden the single most important thing the
    model knows.
20. **`clearCaches` after implementation edits, not just type edits.** A correct `.js` fix to
    `EmsRouter` kept returning the old (null) answer until the workspace caches were cleared; the
    logic had been right for several minutes. Verify a backend change against the data before
    assuming the change itself was wrong.
21. **One camera, three moves, and only one of them at a time.** The chase camera writes
    `map.jumpTo` every frame, so anything else driving the transform silently wins: the 2,600 ms
    dive `flyTo` is still in flight when playback starts (`map.stop()` cancels it), and the
    pull-back had to move out of the dwell timer into `onPlaybackEnd` or it eased out from
    underneath the ride-along. Smoothing is normalised for frame time
    (`k = 1 - (1 - ease)^(dt/16.7)`) so the feel does not change with frame rate, and zoom and
    pitch are blended in over 1.4 s so the chase *continues* the dive instead of competing
    with it. The viewer's hand always wins: a drag or wheel releases the camera for the rest of
    the run, and under `prefers-reduced-motion` the whole chase is skipped and the old framing
    behaviour stands. Arrival flashes are deliberately only **two marked moments** — amber at the
    scene, white at the hospital doors — and the loop is kept alive past `finished` by an
    `endedAt` latch so the last flash is not deleted on the frame it was created.
22. **The chase aims at where the road is *going*, not where it points right now.** Nine seconds
    of playback covers a couple of kilometres, so a corner is over in about half a second: a
    camera aimed at the local heading has to whip round for every turn, and at any rate slow
    enough to look calm it never catches up at all — it just rotates continuously for the whole
    drive. (The first cut did exactly that; a numeric simulation of the loop showed the camera
    rotation-bound for all nine seconds and the zoom never once reaching its target.) So the aim
    is the average heading of the last **600 m**, which a single turn barely moves, and the
    rotation is capped at **24°/s**. A corner is answered by *rising* instead: a short 150 m
    heading compared against the long one measures how hard the road is bending — independent of
    the camera's own lag — and that lifts the camera up to 0.85 zoom levels and lays the pitch
    back 9°, slowly, then returns it. On a straight arterial the camera is now completely still.
    Each leg still opens with one deliberate establishing sweep onto its heading, because the
    dive leaves the camera facing anywhere and the transport leg can set off back the way the
    unit came; that sweep is budgeted by **rate** (55°/s average, ease-in-out *sine* — cubic
    peaks at 3× its average and reads as a whip pan) rather than by a fixed window, so a small
    correction is not stretched into a crawl and a half-turn is not compressed into a snap.
