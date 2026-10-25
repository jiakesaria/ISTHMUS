/*
 * ISTHMUS routing engine.
 *
 * The network is a few thousand vertices, so the whole graph is loaded and solved per
 * request rather than cached. That costs a few hundred milliseconds and buys the
 * guarantee that a scenario edit takes effect immediately with no cache to invalidate.
 */

var ISTH_MPS_PER_KPH = 1000.0 / 3600.0;
var ISTH_EARTH_RADIUS_M = 6371008.8;
var ISTH_ATTRIBUTION = 'Roads, buildings, hospitals, stations and venues: © OpenStreetMap contributors, ODbL 1.0';

/* ---------- geometry ---------- */

function _isthHaversine(aLat, aLon, bLat, bLon) {
  var rad = Math.PI / 180.0;
  var dLat = (bLat - aLat) * rad;
  var dLon = (bLon - aLon) * rad;
  var s = Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) *
    Math.sin(dLon / 2.0) * Math.sin(dLon / 2.0);
  return 2.0 * ISTH_EARTH_RADIUS_M * Math.asin(Math.min(1.0, Math.sqrt(s)));
}

/* ---------- binary min-heap ---------- */

function _isthHeapPush(h, key, node) {
  h.push({ k: key, n: node });
  var i = h.length - 1;
  while (i > 0) {
    var p = (i - 1) >> 1;
    if (h[p].k <= h[i].k) { break; }
    var t = h[p]; h[p] = h[i]; h[i] = t;
    i = p;
  }
}

function _isthHeapPop(h) {
  var top = h[0];
  var last = h.pop();
  if (h.length > 0) {
    h[0] = last;
    var i = 0;
    var n = h.length;
    while (true) {
      var l = 2 * i + 1;
      var r = l + 1;
      var m = i;
      if (l < n && h[l].k < h[m].k) { m = l; }
      if (r < n && h[r].k < h[m].k) { m = r; }
      if (m === i) { break; }
      var t = h[m]; h[m] = h[i]; h[i] = t;
      i = m;
    }
  }
  return top;
}

/* ---------- scenario resolution ---------- */

function _isthResolveScenario(scenarioId) {
  var inc = 'this, roadOverlays.this, zoneOverlays.this, hospitalOverlays.this, hospitalOverlays.hospital.id';
  var filter = scenarioId ? Filter.eq('id', scenarioId) : Filter.eq('isBaseline', true);
  var rows = Scenario.fetch({ filter: filter, include: inc, limit: 2 }).objs;
  if (!rows || rows.length === 0) {
    throw Error.make({
      id: 'ISTHMUS_NO_SCENARIO',
      message: scenarioId
        ? 'No Scenario exists with id ' + scenarioId
        : 'No baseline Scenario exists; one row must have isBaseline true.'
    });
  }
  return rows[0];
}

/*
 * Resolves every overlay in the scenario into lookup tables, so the per-edge hot loop
 * does dictionary hits rather than rescanning overlay lists.
 */
function _isthOverlayIndex(scn) {
  var idx = {
    closedWays: {},
    closedSegs: {},
    waySlow: {},
    segSlow: {},
    zones: [],
    divertedHospitals: {},
    closureReasons: []
  };
  var ro = scn.roadOverlays || [];
  for (var i = 0; i < ro.length; i++) {
    var o = ro[i];
    // A multiplier at or below zero is a closure, not an infinite travel time.
    var closed = (o.isClosed === true) ||
      (o.speedMultiplier !== null && o.speedMultiplier !== undefined && o.speedMultiplier <= 0);
    if (o.osmWayId) {
      if (closed) { idx.closedWays[o.osmWayId] = true; }
      else if (o.speedMultiplier) { idx.waySlow[o.osmWayId] = (idx.waySlow[o.osmWayId] || 1.0) * o.speedMultiplier; }
    }
    if (o.segment && o.segment.id) {
      if (closed) { idx.closedSegs[o.segment.id] = true; }
      else if (o.speedMultiplier) { idx.segSlow[o.segment.id] = (idx.segSlow[o.segment.id] || 1.0) * o.speedMultiplier; }
    }
    if (closed && o.reason) { idx.closureReasons.push(o.reason); }
  }
  var zo = scn.zoneOverlays || [];
  for (var j = 0; j < zo.length; j++) {
    var z = zo[j];
    if (!z.speedMultiplier || z.speedMultiplier <= 0 || !z.radiusMeters) { continue; }
    idx.zones.push({ lat: z.centerLatitude, lon: z.centerLongitude, r: z.radiusMeters, m: z.speedMultiplier });
  }
  var ho = scn.hospitalOverlays || [];
  for (var k = 0; k < ho.length; k++) {
    if (ho[k].isDiverting === true && ho[k].hospital) {
      idx.divertedHospitals[ho[k].hospital.id] = ho[k].reason || 'diverting under this scenario';
    }
  }
  return idx;
}

/* ---------- graph construction ---------- */

/*
 * Loads the immutable network and applies the scenario overlays to produce the edge set
 * actually searched. Segment geometry is deliberately NOT fetched here — it is a third
 * of the payload and is only needed for the handful of edges on the final route.
 */
function _isthLoadGraph(scn) {
  var ovl = _isthOverlayIndex(scn);
  var ambFactor = (scn.ambulanceSpeedFactor && scn.ambulanceSpeedFactor > 0) ? scn.ambulanceSpeedFactor : 1.0;

  var nodeRows = RoadNode.fetch({ include: 'id, latitude, longitude', limit: -1 }).objs;
  var n = nodeRows.length;
  var nodeId = [];
  var nodeLat = [];
  var nodeLon = [];
  var idxOf = {};
  for (var i = 0; i < n; i++) {
    nodeId.push(nodeRows[i].id);
    nodeLat.push(nodeRows[i].latitude);
    nodeLon.push(nodeRows[i].longitude);
    idxOf[nodeRows[i].id] = i;
  }

  var segRows = RoadSegment.fetch({
    include: 'id, fromNode.id, toNode.id, lengthMeters, freeFlowSpeedKph, speedIsEstimated, isBridge, streetName, osmWayId',
    limit: -1
  }).objs;

  var edges = [];
  var adjOut = [];
  var adjIn = [];
  for (var a = 0; a < n; a++) { adjOut.push([]); adjIn.push([]); }

  var droppedByClosure = 0;
  for (var s = 0; s < segRows.length; s++) {
    var seg = segRows[s];
    if (!seg.fromNode || !seg.toNode) { continue; }
    var ai = idxOf[seg.fromNode.id];
    var bi = idxOf[seg.toNode.id];
    if (ai === undefined || bi === undefined) { continue; }

    if (ovl.closedSegs[seg.id] || (seg.osmWayId && ovl.closedWays[seg.osmWayId])) {
      droppedByClosure++;
      continue;
    }

    var mult = 1.0;
    if (seg.osmWayId && ovl.waySlow[seg.osmWayId]) { mult *= ovl.waySlow[seg.osmWayId]; }
    if (ovl.segSlow[seg.id]) { mult *= ovl.segSlow[seg.id]; }

    if (ovl.zones.length > 0) {
      var midLat = (nodeLat[ai] + nodeLat[bi]) / 2.0;
      var midLon = (nodeLon[ai] + nodeLon[bi]) / 2.0;
      for (var z = 0; z < ovl.zones.length; z++) {
        var zn = ovl.zones[z];
        if (_isthHaversine(midLat, midLon, zn.lat, zn.lon) <= zn.r) { mult *= zn.m; }
      }
    }

    // The single place scenario influence becomes a number.
    var kph = seg.freeFlowSpeedKph * ambFactor * mult;
    if (!(kph > 0.1)) { droppedByClosure++; continue; }

    var w = seg.lengthMeters / (kph * ISTH_MPS_PER_KPH);
    var ei = edges.length;
    edges.push({
      a: ai, b: bi, w: w, len: seg.lengthMeters, segId: seg.id,
      est: seg.speedIsEstimated === true, bridge: seg.isBridge === true,
      name: seg.streetName || null
    });
    adjOut[ai].push(ei);
    adjIn[bi].push(ei);
  }

  return {
    n: n, nodeId: nodeId, nodeLat: nodeLat, nodeLon: nodeLon, idxOf: idxOf,
    edges: edges, adjOut: adjOut, adjIn: adjIn,
    segmentsConsidered: segRows.length, droppedByClosure: droppedByClosure,
    ambFactor: ambFactor, overlays: ovl
  };
}

/* ---------- shortest path ---------- */

/*
 * Dijkstra over the effective-speed weights. With reverse=true the search walks inbound
 * edges, so dist[v] is the time to travel FROM v TO src — which is what picking a
 * responding station requires.
 */
function _isthDijkstra(g, src, reverse) {
  var adj = reverse ? g.adjIn : g.adjOut;
  var dist = [];
  var pred = [];
  var done = [];
  for (var i = 0; i < g.n; i++) { dist.push(Infinity); pred.push(-1); done.push(false); }
  dist[src] = 0.0;
  var h = [];
  _isthHeapPush(h, 0.0, src);
  while (h.length > 0) {
    var u = _isthHeapPop(h).n;
    if (done[u]) { continue; }
    done[u] = true;
    var lst = adj[u];
    for (var j = 0; j < lst.length; j++) {
      var ei = lst[j];
      var e = g.edges[ei];
      var v = reverse ? e.a : e.b;
      if (done[v]) { continue; }
      var nd = dist[u] + e.w;
      if (nd < dist[v]) {
        dist[v] = nd;
        pred[v] = ei;
        _isthHeapPush(h, nd, v);
      }
    }
  }
  return { dist: dist, pred: pred };
}

/*
 * Walks predecessors back to produce the traversed edge indices in travel order.
 * For a reverse search the chain already runs in travel order (origin -> src); for a
 * forward search it runs backwards and is flipped.
 */
function _isthEdgeSequence(g, res, src, target, reverse) {
  var seq = [];
  var cur = target;
  var guard = 0;
  while (cur !== src) {
    var ei = res.pred[cur];
    if (ei < 0 || guard++ > g.edges.length + 5) { return null; }
    seq.push(ei);
    cur = reverse ? g.edges[ei].b : g.edges[ei].a;
  }
  if (!reverse) { seq.reverse(); }
  return seq;
}

/* ---------- leg assembly ---------- */

function _isthBuildLeg(g, seq, fromLabel, toLabel) {
  var ids = [];
  var i;
  for (i = 0; i < seq.length; i++) { ids.push(g.edges[seq[i]].segId); }

  var geomById = {};
  if (ids.length > 0) {
    var rows = RoadSegment.fetch({
      filter: Filter.intersects('id', ids), include: 'id, geometry', limit: -1
    }).objs;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].geometry) {
        try { geomById[rows[i].id] = JSON.parse(rows[i].geometry); } catch (ignored) { }
      }
    }
  }

  var coords = [];
  var seconds = 0.0;
  var meters = 0.0;
  var estCount = 0;
  var bridgeCount = 0;
  var streets = [];

  for (i = 0; i < seq.length; i++) {
    var e = g.edges[seq[i]];
    seconds += e.w;
    meters += e.len;
    if (e.est) { estCount++; }
    if (e.bridge) { bridgeCount++; }
    if (e.name && streets[streets.length - 1] !== e.name) { streets.push(e.name); }

    var gm = geomById[e.segId];
    if (!gm || gm.length < 2) {
      gm = [[g.nodeLat[e.a], g.nodeLon[e.a]], [g.nodeLat[e.b], g.nodeLon[e.b]]];
    } else {
      // Orient the stored polyline to the direction of travel rather than trusting it.
      var dHead = _isthHaversine(gm[0][0], gm[0][1], g.nodeLat[e.a], g.nodeLon[e.a]);
      var dTail = _isthHaversine(gm[gm.length - 1][0], gm[gm.length - 1][1], g.nodeLat[e.a], g.nodeLon[e.a]);
      if (dTail < dHead) { gm = gm.slice().reverse(); }
    }
    var start = (coords.length > 0) ? 1 : 0;
    for (var k = start; k < gm.length; k++) { coords.push(gm[k]); }
  }

  return RouteLeg.make({
    fromLabel: fromLabel,
    toLabel: toLabel,
    seconds: Math.round(seconds * 10.0) / 10.0,
    meters: Math.round(meters * 10.0) / 10.0,
    geometry: JSON.stringify(coords),
    segmentIds: ids,
    streets: streets,
    estimatedSpeedSegmentCount: estCount,
    segmentCount: seq.length,
    bridgeCount: bridgeCount
  });
}

/* ---------- public: map payload ---------- */

function mapNetwork(scenarioId) {
  var rows = RoadSegment.fetch({
    include: 'id, geometry, streetName, roadClass, isBridge, isOneway, speedIsEstimated, freeFlowSpeedKph, osmWayId, osmSequence',
    limit: -1
  }).objs;

  // The scenario is resolved even when the caller passed nothing, so the returned
  // congestion figures always belong to a named set of conditions rather than to
  // "whatever the client assumed".
  var scn = _isthResolveScenario(scenarioId);
  var ovl = _isthOverlayIndex(scn);

  var seen = {};
  var lines = [];
  var bridges = 0;
  var est = 0;
  var obs = 0;
  var closedLines = 0;
  var slowedLines = 0;
  var south = 90.0, north = -90.0, west = 180.0, east = -180.0;

  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    if (s.isBridge === true) { bridges++; }
    if (s.speedIsEstimated === true) { est++; } else { obs++; }

    // Collapse the reverse-direction twin of a two-way street into one drawn line.
    var key = s.osmWayId + ':' + s.osmSequence;
    if (seen[key]) { continue; }
    seen[key] = true;

    var gm;
    try { gm = JSON.parse(s.geometry || '[]'); } catch (ignored) { gm = []; }
    if (gm.length < 2) { continue; }

    var pts = [];
    for (var k = 0; k < gm.length; k++) {
      var la = Math.round(gm[k][0] * 100000.0) / 100000.0;
      var lo = Math.round(gm[k][1] * 100000.0) / 100000.0;
      if (la < south) { south = la; }
      if (la > north) { north = la; }
      if (lo < west) { west = lo; }
      if (lo > east) { east = lo; }
      pts.push([la, lo]);
    }

    // --- what this scenario does to this stretch of road ---
    //
    // Resolved with the same overlay index the solver uses, so the colour on the map
    // and the weight in the search cannot disagree. Note the ambulance speed factor is
    // deliberately left out: this figure describes the traffic, not the privileged
    // speed an emergency vehicle is assumed to make through it.
    var isClosed = (ovl.closedWays[s.osmWayId] === true) || (ovl.closedSegs[s.id] === true);
    var mult = 1.0;
    if (!isClosed) {
      if (ovl.waySlow[s.osmWayId]) { mult *= ovl.waySlow[s.osmWayId]; }
      if (ovl.segSlow[s.id]) { mult *= ovl.segSlow[s.id]; }
      if (ovl.zones.length > 0) {
        // The midpoint of the drawn polyline, which is the stretch the viewer sees —
        // not the straight-line midpoint between its end nodes.
        var mid = pts[Math.floor(pts.length / 2)];
        for (var z = 0; z < ovl.zones.length; z++) {
          var zn = ovl.zones[z];
          if (_isthHaversine(mid[0], mid[1], zn.lat, zn.lon) <= zn.r) { mult *= zn.m; }
        }
      }
    }
    var congestion = isClosed ? 0 : Math.round(mult * 100.0);
    if (isClosed) { closedLines++; }
    else if (congestion < 100) { slowedLines++; }

    lines.push([
      s.roadClass || '',
      s.streetName || '',
      s.isBridge === true ? 1 : 0,
      s.isOneway === true ? 1 : 0,
      s.speedIsEstimated === true ? 1 : 0,
      Math.round(s.freeFlowSpeedKph || 0),
      pts,
      congestion,
      isClosed ? 1 : 0
    ]);
  }

  return MapNetwork.make({
    linesJson: JSON.stringify(lines),
    lineCount: lines.length,
    segmentCount: rows.length,
    nodeCount: RoadNode.fetchCount({}),
    bridgeCount: bridges,
    estimatedSpeedCount: est,
    observedSpeedCount: obs,
    attribution: ISTH_ATTRIBUTION,
    bboxSouth: south, bboxNorth: north, bboxWest: west, bboxEast: east,
    scenarioId: scn.id, scenarioName: scn.name,
    closedLineCount: closedLines, slowedLineCount: slowedLines
  });
}

/* ---------- public: 3D building payload ---------- */

function mapBuildings(minAreaSquareMeters) {
  var spec = {
    include: 'id, name, buildingKind, footprint, heightMeters, heightIsEstimated, heightSource, areaSquareMeters, isNotableLandmark',
    limit: -1
  };
  if (minAreaSquareMeters !== null && minAreaSquareMeters !== undefined && minAreaSquareMeters > 0) {
    spec.filter = 'areaSquareMeters >= ' + minAreaSquareMeters;
  }
  var rows = Building.fetch(spec).objs;

  var out = [];
  var est = 0, real = 0, levels = 0, named = 0, marks = 0;
  var tallest = 0.0;
  var south = 90.0, north = -90.0, west = 180.0, east = -180.0;

  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];

    var ring;
    try { ring = JSON.parse(b.footprint || '[]'); } catch (ignored) { ring = []; }
    // A polygon needs three distinct corners; anything less is a digitising artefact
    // that would render as a degenerate sliver, so it is dropped rather than drawn.
    if (ring.length < 4) { continue; }

    if (b.heightIsEstimated === true) { est++; } else { real++; }
    if (b.heightSource === 'osm:building:levels') { levels++; }
    if (b.name) { named++; }
    if (b.isNotableLandmark === true) { marks++; }

    var h = b.heightMeters || 0.0;
    if (h > tallest) { tallest = h; }

    var pts = [];
    for (var k = 0; k < ring.length; k++) {
      var la = Math.round(ring[k][0] * 1000000.0) / 1000000.0;
      var lo = Math.round(ring[k][1] * 1000000.0) / 1000000.0;
      if (la < south) { south = la; }
      if (la > north) { north = la; }
      if (lo < west) { west = lo; }
      if (lo > east) { east = lo; }
      pts.push([la, lo]);
    }

    // 0 measured, 1 from a storey count, 2 assumed from building class.
    var conf = 2;
    if (b.heightIsEstimated !== true) {
      conf = 0;
    } else if (b.heightSource === 'osm:building:levels') {
      conf = 1;
    }

    out.push([
      Math.round(h * 10.0) / 10.0,
      b.buildingKind || '',
      conf,
      b.isNotableLandmark === true ? 1 : 0,
      b.name || '',
      pts
    ]);
  }

  return MapBuildings.make({
    buildingsJson: JSON.stringify(out),
    buildingCount: out.length,
    totalBuildingCount: Building.fetchCount({}),
    estimatedHeightCount: est,
    realHeightCount: real,
    levelsHeightCount: levels,
    namedCount: named,
    landmarkCount: marks,
    tallestMeters: tallest,
    attribution: ISTH_ATTRIBUTION,
    bboxSouth: south, bboxNorth: north, bboxWest: west, bboxEast: east
  });
}

/* ---------- public: response plan ---------- */

function respond(latitude, longitude, scenarioId) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
    throw Error.make({ id: 'ISTHMUS_NO_POINT', message: 'latitude and longitude are both required.' });
  }

  var scn = _isthResolveScenario(scenarioId);
  var g = _isthLoadGraph(scn);
  var warnings = [];
  var i;

  // Snap the incident to the nearest graph vertex. Routing runs between intersections,
  // so a mid-block incident is reported from the nearest one.
  var sIdx = -1;
  var sDist = Infinity;
  for (i = 0; i < g.n; i++) {
    var d = _isthHaversine(latitude, longitude, g.nodeLat[i], g.nodeLon[i]);
    if (d < sDist) { sDist = d; sIdx = i; }
  }
  if (sIdx < 0) {
    throw Error.make({ id: 'ISTHMUS_EMPTY_GRAPH', message: 'The road network contains no nodes.' });
  }
  if (sDist > 250.0) {
    warnings.push('Incident snapped ' + Math.round(sDist) + ' m to the nearest modelled intersection, ' +
      'which is far enough that the reported times describe a nearby road rather than this exact point.');
  }

  var stations = EmsStation.fetch({ include: 'id, name, stationKind, nearestNode.id', limit: -1 }).objs;
  var hospitals = Hospital.fetch({
    filter: Filter.eq('isEmergencyDestination', true),
    include: 'id, name, nearestNode.id', limit: -1
  }).objs;

  var rev = _isthDijkstra(g, sIdx, true);
  var fwd = _isthDijkstra(g, sIdx, false);

  // --- responding station ---
  var stationEtas = [];
  var bestStation = null;
  var bestStationIdx = -1;
  var bestStationSec = Infinity;
  for (i = 0; i < stations.length; i++) {
    var st = stations[i];
    var sn = st.nearestNode ? g.idxOf[st.nearestNode.id] : undefined;
    var sec = (sn === undefined) ? Infinity : rev.dist[sn];
    var reachable = isFinite(sec);
    stationEtas.push(StationEta.make({
      stationId: st.id, stationName: st.name, stationKind: st.stationKind,
      seconds: reachable ? Math.round(sec * 10.0) / 10.0 : null,
      meters: null, isReachable: reachable
    }));
    if (reachable && sec < bestStationSec) { bestStationSec = sec; bestStation = st; bestStationIdx = sn; }
  }
  stationEtas.sort(function (x, y) {
    if (x.seconds === null) { return 1; }
    if (y.seconds === null) { return -1; }
    return x.seconds - y.seconds;
  });

  // --- destination hospital ---
  var hospEtas = [];
  var bestHosp = null;
  var bestHospIdx = -1;
  var bestHospSec = Infinity;
  for (i = 0; i < hospitals.length; i++) {
    var hp = hospitals[i];
    var hn = hp.nearestNode ? g.idxOf[hp.nearestNode.id] : undefined;
    var hsec = (hn === undefined) ? Infinity : fwd.dist[hn];
    var hreach = isFinite(hsec);
    var excluded = g.overlays.divertedHospitals[hp.id] || null;
    hospEtas.push(HospitalEta.make({
      hospitalId: hp.id, hospitalName: hp.name,
      seconds: hreach ? Math.round(hsec * 10.0) / 10.0 : null,
      meters: null, isReachable: hreach, excludedReason: excluded
    }));
    if (hreach && !excluded && hsec < bestHospSec) { bestHospSec = hsec; bestHosp = hp; bestHospIdx = hn; }
  }
  hospEtas.sort(function (x, y) {
    if (x.seconds === null) { return 1; }
    if (y.seconds === null) { return -1; }
    return x.seconds - y.seconds;
  });

  // --- legs ---
  var responseLeg = null;
  var transportLeg = null;

  if (bestStation) {
    var rseq = _isthEdgeSequence(g, rev, sIdx, bestStationIdx, true);
    if (rseq) {
      responseLeg = _isthBuildLeg(g, rseq, bestStation.name, 'Incident');
    }
  } else {
    warnings.push('No EMS or fire station can reach this point under scenario "' + scn.name +
      '". Under the baseline network every point is mutually reachable, so this indicates the scenario has severed the network.');
  }

  if (bestHosp) {
    var tseq = _isthEdgeSequence(g, fwd, sIdx, bestHospIdx, false);
    if (tseq) {
      transportLeg = _isthBuildLeg(g, tseq, 'Incident', bestHosp.name);
    }
  } else {
    warnings.push('No emergency department is reachable from this point under scenario "' + scn.name + '".');
  }

  var unreachableHosp = 0;
  for (i = 0; i < hospEtas.length; i++) { if (!hospEtas[i].isReachable) { unreachableHosp++; } }
  if (unreachableHosp > 0) {
    warnings.push(unreachableHosp + ' of ' + hospEtas.length +
      ' emergency departments are unreachable from this point under this scenario.');
  }
  if (g.droppedByClosure > 0) {
    warnings.push(g.droppedByClosure + ' of ' + g.segmentsConsidered +
      ' directed road segments are closed or impassable in this scenario.');
  }

  var estSegs = (responseLeg ? responseLeg.estimatedSpeedSegmentCount : 0) +
    (transportLeg ? transportLeg.estimatedSpeedSegmentCount : 0);
  var allSegs = (responseLeg ? responseLeg.segmentCount : 0) + (transportLeg ? transportLeg.segmentCount : 0);
  if (allSegs > 0 && estSegs > 0) {
    warnings.push(estSegs + ' of ' + allSegs + ' road segments on this route have a speed estimated from road ' +
      'class because OpenStreetMap carries no maxspeed tag for them. Treat the times as comparative, not predictive.');
  }
  if (g.ambFactor !== 1.0) {
    warnings.push('Times include an estimated emergency-vehicle speed factor of ' + g.ambFactor +
      '× posted speed. No observed Madison Fire Department response telemetry is loaded in this model.');
  }

  var total = null;
  if (responseLeg && transportLeg) {
    total = Math.round((responseLeg.seconds + transportLeg.seconds) * 10.0) / 10.0;
  }

  return ResponsePlan.make({
    scenarioId: scn.id,
    scenarioName: scn.name,
    incidentLatitude: latitude,
    incidentLongitude: longitude,
    incidentNodeId: g.nodeId[sIdx],
    incidentSnapMeters: Math.round(sDist * 10.0) / 10.0,
    stationId: bestStation ? bestStation.id : null,
    stationName: bestStation ? bestStation.name : null,
    hospitalId: bestHosp ? bestHosp.id : null,
    hospitalName: bestHosp ? bestHosp.name : null,
    responseLeg: responseLeg,
    transportLeg: transportLeg,
    totalSeconds: total,
    candidateHospitals: hospEtas,
    candidateStations: stationEtas,
    warnings: warnings
  });
}

/* ---------- scenario cost ---------- */

/*
 * Response and transport time at EVERY vertex of one graph, in two passes.
 *
 * The naive way to answer "how long would an ambulance take to reach here" for every
 * intersection is one search per intersection. Inverting it is thousands of times
 * cheaper and exact: a forward search FROM a station yields that station's travel time
 * to every vertex at once, so the response field is the pointwise minimum over the
 * handful of stations. The transport field is the mirror image — a reverse search from
 * each emergency department yields the time from every vertex TO that department.
 *
 * Hospitals the scenario has put on diversion are skipped, so transport times reflect
 * where an ambulance would actually be accepted.
 */
function _isthFieldTimes(g, stations, hospitals) {
  var i, j;
  var resp = [];
  var trans = [];
  for (i = 0; i < g.n; i++) { resp.push(Infinity); trans.push(Infinity); }

  for (i = 0; i < stations.length; i++) {
    var sNode = stations[i].nearestNode ? g.idxOf[stations[i].nearestNode.id] : undefined;
    if (sNode === undefined) { continue; }
    var out = _isthDijkstra(g, sNode, false);
    for (j = 0; j < g.n; j++) { if (out.dist[j] < resp[j]) { resp[j] = out.dist[j]; } }
  }

  for (i = 0; i < hospitals.length; i++) {
    var hp = hospitals[i];
    if (g.overlays.divertedHospitals[hp.id]) { continue; }
    var hNode = hp.nearestNode ? g.idxOf[hp.nearestNode.id] : undefined;
    if (hNode === undefined) { continue; }
    var inb = _isthDijkstra(g, hNode, true);
    for (j = 0; j < g.n; j++) { if (inb.dist[j] < trans[j]) { trans[j] = inb.dist[j]; } }
  }

  return { resp: resp, trans: trans };
}

/*
 * Names the street a vertex sits on by looking at the roads that actually leave it.
 * Preference is given to the scenario graph so the label describes the street as it is
 * under those conditions, falling back to the baseline graph for a vertex whose every
 * outbound edge the scenario has closed.
 */
function _isthStreetAt(gPrimary, gFallback, idxPrimary, idxFallback) {
  /*
   * Widened to two hops because a surprising number of vertices sit only on roads
   * OpenStreetMap leaves unnamed — campus service drives, alleys, parking aisles. One
   * hop out from such a vertex there is almost always a named street, and "on Dayton
   * Street" is a far more useful finding than a pair of coordinates. Two hops is the
   * limit: beyond that the name stops describing where the vertex actually is.
   */
  var pick = function (g, idx) {
    if (idx === undefined || idx < 0) { return null; }
    var frontier = [idx];
    var seen = {};
    seen[idx] = true;
    for (var hop = 0; hop < 2; hop++) {
      var next = [];
      for (var f = 0; f < frontier.length; f++) {
        var u = frontier[f];
        var lst = g.adjOut[u].concat(g.adjIn[u]);
        for (var i = 0; i < lst.length; i++) {
          var e = g.edges[lst[i]];
          if (e.name) { return e.name; }
          var v = (e.a === u) ? e.b : e.a;
          if (!seen[v]) { seen[v] = true; next.push(v); }
        }
      }
      frontier = next;
    }
    return null;
  };
  return pick(gPrimary, idxPrimary) || pick(gFallback, idxFallback);
}

function scenarioImpact(scenarioId) {
  var scn = _isthResolveScenario(scenarioId);
  var base = _isthResolveScenario(null);

  var stations = EmsStation.fetch({ include: 'id, name, nearestNode.id', limit: -1 }).objs;
  var hospitals = Hospital.fetch({
    filter: Filter.eq('isEmergencyDestination', true),
    include: 'id, name, nearestNode.id', limit: -1
  }).objs;
  if (stations.length === 0 || hospitals.length === 0) {
    throw Error.make({
      id: 'ISTHMUS_NO_FACILITIES',
      message: 'Scenario impact needs at least one EmsStation and one emergency Hospital to compare against.'
    });
  }

  var gB = _isthLoadGraph(base);
  var gS = _isthLoadGraph(scn);
  var fB = _isthFieldTimes(gB, stations, hospitals);
  var fS = _isthFieldTimes(gS, stations, hospitals);

  // Only intersections inside the core area are judged. The buffer ring exists so that
  // routes may legally leave and re-enter the core; averaging over it would dilute the
  // result with sparse outlying roads the model was never meant to describe.
  var coreIds = {};
  var coreRows = RoadNode.fetch({ filter: Filter.eq('inCoreArea', true), include: 'id', limit: -1 }).objs;
  var c;
  for (c = 0; c < coreRows.length; c++) { coreIds[coreRows[c].id] = true; }

  var points = 0, compared = 0, stranded = 0;
  var sumRespB = 0.0, sumRespS = 0.0;
  var sumTotB = 0.0, sumTotS = 0.0, totN = 0;
  var worstDelta = -1.0, worstI = -1, worstB = 0.0, worstS = 0.0;

  for (var i = 0; i < gB.n; i++) {
    var nid = gB.nodeId[i];
    if (!coreIds[nid]) { continue; }
    points++;

    var iS = gS.idxOf[nid];
    if (iS === undefined) { continue; }

    var rb = fB.resp[i];
    var rs = fS.resp[iS];

    // A vertex no station can reach even under the baseline is a quirk of the extract
    // (a dead-end service road, a one-way stub), not something this scenario did. It is
    // excluded from both sides rather than blamed on the scenario.
    if (!isFinite(rb)) { continue; }
    if (!isFinite(rs)) { stranded++; continue; }

    compared++;
    sumRespB += rb;
    sumRespS += rs;

    var tb = fB.trans[i];
    var ts = fS.trans[iS];
    if (isFinite(tb) && isFinite(ts)) {
      sumTotB += rb + tb;
      sumTotS += rs + ts;
      totN++;
    }

    var delta = rs - rb;
    if (delta > worstDelta) { worstDelta = delta; worstI = i; worstB = rb; worstS = rs; }
  }

  if (compared === 0) {
    throw Error.make({
      id: 'ISTHMUS_NOTHING_COMPARABLE',
      message: 'No core intersection is reachable under both the baseline and scenario "' + scn.name + '".'
    });
  }

  var avgRespB = sumRespB / compared;
  var avgRespS = sumRespS / compared;
  var round1 = function (v) { return Math.round(v * 10.0) / 10.0; };

  // Distinct closure reasons, in the words the overlays themselves carry.
  var reasons = [];
  var seenReason = {};
  for (var r = 0; r < gS.overlays.closureReasons.length; r++) {
    var txt = gS.overlays.closureReasons[r];
    if (txt && !seenReason[txt]) { seenReason[txt] = true; reasons.push(txt); }
  }

  var worstName = null;
  var worstLat = null;
  var worstLon = null;
  if (worstI >= 0) {
    worstLat = gB.nodeLat[worstI];
    worstLon = gB.nodeLon[worstI];
    worstName = _isthStreetAt(gS, gB, gS.idxOf[gB.nodeId[worstI]], worstI);
  }

  return ScenarioImpact.make({
    scenarioId: scn.id,
    scenarioName: scn.name,
    baselineScenarioId: base.id,
    pointCount: points,
    comparedCount: compared,
    strandedCount: stranded,
    baselineResponseSeconds: round1(avgRespB),
    scenarioResponseSeconds: round1(avgRespS),
    responseRatio: Math.round((avgRespS / avgRespB) * 100.0) / 100.0,
    baselineTotalSeconds: totN > 0 ? round1(sumTotB / totN) : null,
    scenarioTotalSeconds: totN > 0 ? round1(sumTotS / totN) : null,
    worstLatitude: worstLat,
    worstLongitude: worstLon,
    worstBaselineSeconds: worstI >= 0 ? round1(worstB) : null,
    worstScenarioSeconds: worstI >= 0 ? round1(worstS) : null,
    worstStreetName: worstName,
    closedEdgeCount: gS.droppedByClosure,
    closureReason: reasons.length > 0 ? reasons.join(' ') : null,
    caveat: 'Road geometry, one-way restrictions and bridges are real OpenStreetMap data. ' +
      'Speed limits are real where OpenStreetMap carries a maxspeed tag and inferred from road ' +
      'class otherwise. The congestion multipliers, the closure and the ambulance speed factor are ' +
      'MODELLED assumptions, not observations — Madison publishes no open game-day traffic counts. ' +
      'Read the ratio, which is robust to those assumptions; do not quote the absolute minutes as a ' +
      'predicted response time.'
  });
}
