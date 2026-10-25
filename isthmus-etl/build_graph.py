#!/usr/bin/env python3
"""
ISTHMUS — Stage 2: turn raw OSM XML into a routable directed graph + POIs,
emitted as C3 `data/<TypeName>/*.json` files.

Pipeline:
  1. Parse every cached tile; dedupe nodes/ways by OSM id.
  2. Keep drivable highways only (excludes footways, cycleways, driveways,
     parking aisles, private access).
  3. Find true intersections = nodes shared by >=2 drivable ways, plus way endpoints.
  4. Split ways at intersections -> segments carrying their real polyline geometry.
  5. Length by haversine along the full polyline (not straight-line).
  6. Speed from `maxspeed` when tagged, else a per-class default -> flagged estimated.
  7. oneway handling: 2 directed edges for two-way streets, 1 for oneway/roundabout.
  8. Keep the largest strongly-connected component so any kept node can reach any other.
  9. Snap hospitals / fire+EMS stations / venues to their nearest kept graph node.

Nothing is invented: every emitted record carries `source` with its OSM id, and any
derived value is flagged (`speedIsEstimated`, `speedSource`).
"""
import json
import math
import os
import re
import sys
import hashlib
from collections import defaultdict
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
PKG = os.path.join(os.path.dirname(HERE), "pkg323033d0")
DATA = os.path.join(PKG, "data")

CORE = dict(south=43.0520, north=43.0880, west=-89.4450, east=-89.3700)
DL = dict(south=43.0450, north=43.0950, west=-89.4550, east=-89.3600)

DRIVABLE = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}
# service roads we do NOT want as through-routes
BAD_SERVICE = {"parking_aisle", "driveway", "drive-through", "emergency_access"}

MPH = 1.609344
DEFAULT_KPH = {
    "motorway": 65 * MPH, "trunk": 55 * MPH, "primary": 35 * MPH,
    "secondary": 30 * MPH, "tertiary": 30 * MPH, "unclassified": 25 * MPH,
    "residential": 25 * MPH, "living_street": 15 * MPH, "service": 15 * MPH,
    "motorway_link": 30 * MPH, "trunk_link": 30 * MPH, "primary_link": 25 * MPH,
    "secondary_link": 25 * MPH, "tertiary_link": 25 * MPH,
}


def haversine(a_lat, a_lon, b_lat, b_lon):
    R = 6371008.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def in_box(lat, lon, b):
    return b["south"] <= lat <= b["north"] and b["west"] <= lon <= b["east"]


def parse_maxspeed(v):
    """Return (kph, source) or (None, None) if unparseable."""
    if not v:
        return None, None
    v = v.strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*mph$", v)
    if m:
        return float(m.group(1)) * MPH, "osm:maxspeed"
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:km/h|kph)?$", v)
    if m:
        return float(m.group(1)), "osm:maxspeed"
    return None, None


# ---------------------------------------------------------------- load raw OSM
def load_raw():
    nodes, ways, rels = {}, {}, {}
    files = sorted(f for f in os.listdir(RAW) if f.endswith(".xml"))
    for fi, fn in enumerate(files, 1):
        for ev, el in ET.iterparse(os.path.join(RAW, fn), events=("end",)):
            if el.tag == "node":
                nid = el.get("id")
                if nid not in nodes:
                    tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
                    nodes[nid] = (float(el.get("lat")), float(el.get("lon")), tags)
            elif el.tag == "way":
                wid = el.get("id")
                if wid not in ways:
                    refs = [nd.get("ref") for nd in el.findall("nd")]
                    tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
                    ways[wid] = (refs, tags)
            elif el.tag == "relation":
                rid = el.get("id")
                if rid not in rels:
                    tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
                    mem = [(m.get("type"), m.get("ref"), m.get("role")) for m in el.findall("member")]
                    rels[rid] = (mem, tags)
            # Only clear top-level elements. Clearing <tag>/<nd> children wipes their
            # attributes before the parent's end-event fires, silently losing all tags.
            if el.tag in ("node", "way", "relation"):
                el.clear()
        print(f"  parsed {fi}/{len(files)} {fn}  nodes={len(nodes)} ways={len(ways)}", flush=True)
    return nodes, ways, rels


def is_drivable(tags):
    hw = tags.get("highway")
    if hw not in DRIVABLE:
        return False
    if tags.get("area") == "yes":
        return False
    if hw == "service" and tags.get("service") in BAD_SERVICE:
        return False
    if tags.get("access") in ("private", "no", "customers"):
        return False
    if tags.get("motor_vehicle") in ("private", "no"):
        return False
    return True


def main():
    print("Loading raw OSM tiles...", flush=True)
    nodes, ways, rels = load_raw()

    drivable = {wid: (refs, tags) for wid, (refs, tags) in ways.items() if is_drivable(tags)}
    print(f"\nDrivable ways: {len(drivable)}", flush=True)

    # ---- intersections: nodes used by >=2 drivable ways, or way endpoints
    use = defaultdict(int)
    for refs, _ in drivable.values():
        for r in set(refs):
            use[r] += 1
    junction = set()
    for refs, _ in drivable.values():
        if not refs:
            continue
        junction.add(refs[0]); junction.add(refs[-1])
        for r in refs:
            if use[r] >= 2:
                junction.add(r)
    junction = {r for r in junction if r in nodes}
    print(f"Candidate intersection nodes: {len(junction)}", flush=True)

    # ---- split ways into segments between consecutive intersection nodes
    raw_edges = []   # (fromRef, toRef, geometry[list of (lat,lon)], tags, wayId, seqIdx)
    for wid, (refs, tags) in drivable.items():
        refs = [r for r in refs if r in nodes]
        if len(refs) < 2:
            continue
        cur, seq = [refs[0]], 0
        for r in refs[1:]:
            cur.append(r)
            if r in junction:
                if len(cur) >= 2 and cur[0] != cur[-1]:
                    geom = [(nodes[x][0], nodes[x][1]) for x in cur]
                    raw_edges.append((cur[0], cur[-1], geom, tags, wid, seq))
                    seq += 1
                cur = [r]
    print(f"Undirected segments: {len(raw_edges)}", flush=True)

    # ---- directed edges with speed + length
    edges = []
    for frm, to, geom, tags, wid, seq in raw_edges:
        length = sum(haversine(geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1])
                     for i in range(len(geom) - 1))
        if length < 0.5:
            continue
        hw = tags["highway"]
        kph, spsrc = parse_maxspeed(tags.get("maxspeed"))
        estimated = kph is None
        if estimated:
            kph = DEFAULT_KPH.get(hw, 25 * MPH)
            spsrc = f"default:{hw}"

        ow = (tags.get("oneway") or "").lower()
        roundabout = tags.get("junction") in ("roundabout", "circular")
        if ow in ("yes", "true", "1") or roundabout or hw in ("motorway", "motorway_link"):
            dirs = [(frm, to, geom, True)]
        elif ow == "-1":
            dirs = [(to, frm, list(reversed(geom)), True)]
        else:
            dirs = [(frm, to, geom, False), (to, frm, list(reversed(geom)), False)]

        try:
            lanes = int(float(tags.get("lanes"))) if tags.get("lanes") else None
        except ValueError:
            lanes = None

        for a, b, g, oneway in dirs:
            edges.append(dict(
                fromRef=a, toRef=b, streetName=tags.get("name"),
                lengthMeters=round(length, 2), freeFlowSpeedKph=round(kph, 2),
                roadClass=hw, laneCount=lanes, isOneway=oneway,
                isBridge=tags.get("bridge") not in (None, "no"),
                isTunnel=tags.get("tunnel") not in (None, "no"),
                geometry=[[round(y, 6), round(x, 6)] for y, x in g],
                osmWayId=wid, osmSequence=seq,
                speedIsEstimated=estimated, speedSource=spsrc,
            ))
    print(f"Directed edges: {len(edges)}", flush=True)

    # ---- largest strongly connected component (guarantees mutual reachability)
    adj, radj = defaultdict(list), defaultdict(list)
    for e in edges:
        adj[e["fromRef"]].append(e["toRef"])
        radj[e["toRef"]].append(e["fromRef"])
    allv = set(adj) | set(radj)

    def order_pass(graph, verts):
        seen, out = set(), []
        for s in verts:
            if s in seen:
                continue
            stack = [(s, iter(graph.get(s, ())))]
            seen.add(s)
            while stack:
                v, it = stack[-1]
                adv = False
                for w in it:
                    if w not in seen:
                        seen.add(w)
                        stack.append((w, iter(graph.get(w, ()))))
                        adv = True
                        break
                if not adv:
                    out.append(stack.pop()[0])
        return out

    order = order_pass(adj, list(allv))
    seen, best = set(), set()
    for s in reversed(order):
        if s in seen:
            continue
        comp, stack = set(), [s]
        seen.add(s)
        while stack:
            v = stack.pop()
            comp.add(v)
            for w in radj.get(v, ()):
                if w not in seen:
                    seen.add(w); stack.append(w)
        if len(comp) > len(best):
            best = comp
    print(f"Largest SCC: {len(best)} / {len(allv)} nodes ({100*len(best)/max(1,len(allv)):.1f}%)", flush=True)

    edges = [e for e in edges if e["fromRef"] in best and e["toRef"] in best]
    keep_nodes = best
    print(f"Edges after SCC filter: {len(edges)}", flush=True)

    # ---- emit RoadNode
    nid_of = {}
    road_nodes = []
    for r in sorted(keep_nodes):
        lat, lon, _ = nodes[r]
        cid = f"N{r}"
        nid_of[r] = cid
        road_nodes.append(dict(
            id=cid, latitude=round(lat, 6), longitude=round(lon, 6),
            osmNodeId=r, inCoreArea=in_box(lat, lon, CORE),
            source=f"OpenStreetMap node/{r}",
        ))

    road_segments = []
    for i, e in enumerate(edges):
        road_segments.append(dict(
            id=f"S{e['osmWayId']}_{e['osmSequence']}_{nid_of[e['fromRef']]}_{nid_of[e['toRef']]}",
            fromNode=nid_of[e["fromRef"]], toNode=nid_of[e["toRef"]],
            streetName=e["streetName"], lengthMeters=e["lengthMeters"],
            freeFlowSpeedKph=e["freeFlowSpeedKph"], roadClass=e["roadClass"],
            freeFlowTravelTimeSeconds=round(e["lengthMeters"] / (e["freeFlowSpeedKph"] * 1000.0 / 3600.0), 3),
            laneCount=e["laneCount"], isOneway=e["isOneway"],
            isBridge=e["isBridge"], isTunnel=e["isTunnel"],
            geometry=json.dumps(e["geometry"], separators=(",", ":")),
            osmWayId=e["osmWayId"], osmSequence=e["osmSequence"],
            speedIsEstimated=e["speedIsEstimated"], speedSource=e["speedSource"],
            source=f"OpenStreetMap way/{e['osmWayId']}",
        ))

    # ---- POIs (nodes, ways, relations) -----------------------------------
    def centroid_of_way(wid):
        refs, _ = ways.get(wid, ([], {}))
        pts = [(nodes[r][0], nodes[r][1]) for r in refs if r in nodes]
        if not pts:
            return None
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

    def centroid_of_rel(rid):
        mem, _ = rels.get(rid, ([], {}))
        pts = []
        for mt, ref, role in mem:
            if mt == "way":
                c = centroid_of_way(ref)
                if c:
                    pts.append(c)
            elif mt == "node" and ref in nodes:
                pts.append((nodes[ref][0], nodes[ref][1]))
        if not pts:
            return None
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

    def all_tagged():
        """Yield (osmType, osmId, tags, (lat,lon))."""
        for nid, (lat, lon, tags) in nodes.items():
            if tags:
                yield "node", nid, tags, (lat, lon)
        for wid, (refs, tags) in ways.items():
            if tags:
                c = centroid_of_way(wid)
                if c:
                    yield "way", wid, tags, c
        for rid, (mem, tags) in rels.items():
            if tags:
                c = centroid_of_rel(rid)
                if c:
                    yield "relation", rid, tags, c

    def addr(t):
        parts = [t.get("addr:housenumber"), t.get("addr:street")]
        s = " ".join(p for p in parts if p)
        city = t.get("addr:city")
        if city:
            s = f"{s}, {city}" if s else city
        return s or None

    hospitals, stations, venues = {}, {}, {}
    for otype, oid, t, (lat, lon) in all_tagged():
        if not in_box(lat, lon, DL):
            continue
        name = t.get("name")
        src = f"OpenStreetMap {otype}/{oid}"

        is_hosp = t.get("amenity") == "hospital" or t.get("healthcare") == "hospital"
        is_clinic = t.get("amenity") == "clinic" or t.get("healthcare") == "clinic"
        if (is_hosp or is_clinic) and name:
            hospitals[name] = dict(
                id=None, name=name, address=addr(t),
                latitude=round(lat, 6), longitude=round(lon, 6),
                osmType=otype, osmId=oid, source=src,
                facilityKind="hospital" if is_hosp else "clinic",
                hasEmergency=t.get("emergency") == "yes" or None,
                operator=t.get("operator"),
            )

        if t.get("amenity") == "fire_station":
            stations[name or f"Fire station {oid}"] = dict(
                id=None, name=name or f"Fire station {oid}", address=addr(t),
                latitude=round(lat, 6), longitude=round(lon, 6),
                stationKind="fire_station", osmType=otype, osmId=oid, source=src,
                operator=t.get("operator"),
            )
        if t.get("emergency") == "ambulance_station":
            stations[name or f"Ambulance station {oid}"] = dict(
                id=None, name=name or f"Ambulance station {oid}", address=addr(t),
                latitude=round(lat, 6), longitude=round(lon, 6),
                stationKind="ems_station", osmType=otype, osmId=oid, source=src,
                operator=t.get("operator"),
            )

        # Venues that drive the gameday scenarios
        if name and (t.get("leisure") == "stadium" or t.get("building") == "stadium"
                     or t.get("leisure") == "sports_centre" or t.get("amenity") == "events_venue"
                     or t.get("building") == "public" or t.get("government") == "capitol"
                     or t.get("leisure") == "arena"):
            key = name.lower()
            if any(k in key for k in ("camp randall", "kohl center", "labahn",
                                      "capitol", "alliant", "breese stevens",
                                      "veterans memorial coliseum")):
                venues[name] = dict(
                    id=None, name=name, latitude=round(lat, 6), longitude=round(lon, 6),
                    osmType=otype, osmId=oid, source=src,
                    venueKind=("landmark" if "capitol" in key else "venue"),
                )

    # ---- snap POIs to nearest kept graph node
    node_pts = [(n["id"], n["latitude"], n["longitude"]) for n in road_nodes]

    def snap(lat, lon):
        best_id, best_d = None, 1e18
        for nid, nlat, nlon in node_pts:
            if abs(nlat - lat) > 0.02 or abs(nlon - lon) > 0.02:
                continue
            d = (nlat - lat) ** 2 + (nlon - lon) ** 2
            if d < best_d:
                best_d, best_id = d, nid
        if best_id is None:
            return None, None
        for nid, nlat, nlon in node_pts:
            if nid == best_id:
                return best_id, round(haversine(lat, lon, nlat, nlon), 1)
        return best_id, None

    def finalize(d, prefix, i):
        slug = re.sub(r"[^a-z0-9]+", "_", d["name"].lower()).strip("_")[:48]
        d["id"] = f"{prefix}_{slug}"
        nid, dist = snap(d["latitude"], d["longitude"])
        d["nearestNode"] = nid
        d["snapDistanceMeters"] = dist
        return d

    hosp_list = [finalize(h, "HOSP", i) for i, h in enumerate(sorted(hospitals.values(), key=lambda x: x["name"]))]

    # An ambulance may only transport to a true hospital that OSM explicitly tags as
    # having an emergency department. Clinics and untagged facilities are excluded
    # rather than optimistically assumed to accept emergencies.
    for h in hosp_list:
        h["isEmergencyDestination"] = bool(
            h["facilityKind"] == "hospital" and h.get("hasEmergency") is True)

    # Flag (do not silently merge) known upstream duplicates: OSM carries two separate
    # objects for the single VA hospital campus on Overlook Terrace.
    va = [h for h in hosp_list if "veteran" in h["name"].lower()]
    if len(va) > 1:
        names = " / ".join(sorted(x["name"] for x in va))
        for h in va:
            h["dataQualityNote"] = (
                f"OpenStreetMap carries {len(va)} separate objects for what appears to be the "
                f"same VA hospital campus ({names}), ~{haversine(va[0]['latitude'], va[0]['longitude'], va[1]['latitude'], va[1]['longitude']):.0f} m apart. "
                "Retained as extracted; not de-duplicated.")
    stat_list = [finalize(s, "STN", i) for i, s in enumerate(sorted(stations.values(), key=lambda x: x["name"]))]
    venue_list = [finalize(v, "VEN", i) for i, v in enumerate(sorted(venues.values(), key=lambda x: x["name"]))]

    # ---- provenance manifest
    raw_files = sorted(f for f in os.listdir(RAW) if f.endswith(".xml"))
    h = hashlib.sha256()
    for f in raw_files:
        with open(os.path.join(RAW, f), "rb") as fh:
            while chunk := fh.read(1 << 20):
                h.update(chunk)
    manifest = [dict(
        id="LOAD_osm_isthmus_v1",
        name="OSM isthmus extract v1",
        sourceApi="https://api.openstreetmap.org/api/0.6/map",
        sourceLicense="ODbL 1.0 - (c) OpenStreetMap contributors",
        bboxSouth=DL["south"], bboxNorth=DL["north"], bboxWest=DL["west"], bboxEast=DL["east"],
        coreBboxSouth=CORE["south"], coreBboxNorth=CORE["north"],
        coreBboxWest=CORE["west"], coreBboxEast=CORE["east"],
        rawTileCount=len(raw_files),
        rawBytes=sum(os.path.getsize(os.path.join(RAW, f)) for f in raw_files),
        rawChecksumSha256=h.hexdigest(),
        rawPath="isthmus-etl/raw",
        recordCounts=json.dumps(dict(
            RoadNode=len(road_nodes), RoadSegment=len(road_segments),
            Hospital=len(hosp_list), EmsStation=len(stat_list), Venue=len(venue_list)), separators=(",", ":")),
        notes=("Drivable highways only; split at intersections; largest strongly-connected "
               "component retained. Speeds use OSM maxspeed when tagged, else a per-road-class "
               "US urban default flagged via speedIsEstimated/speedSource. Hospital clinical "
               "capability (trauma level, stroke/cath/peds) is NOT in OSM and is left unset."),
    )]

    # ---- write
    def dump(tname, rows):
        d = os.path.join(DATA, tname)
        os.makedirs(d, exist_ok=True)
        # C3 convention: a single-record data file must be named after that record's id.
        fname = f"{rows[0]['id']}.json" if len(rows) == 1 else f"{tname.lower()}.json"
        for stale in os.listdir(d):
            if stale.endswith(".json") and stale != fname:
                os.remove(os.path.join(d, stale))
        with open(os.path.join(d, fname), "w") as f:
            json.dump(rows, f, indent=1)
        print(f"  wrote {len(rows):6d} -> data/{tname}/{fname}", flush=True)

    print("\nEmitting C3 data files:", flush=True)
    dump("RoadNode", road_nodes)
    dump("RoadSegment", road_segments)
    dump("Hospital", hosp_list)
    dump("EmsStation", stat_list)
    dump("Venue", venue_list)
    dump("OsmDataLoad", manifest)

    with open(os.path.join(HERE, "build_report.json"), "w") as f:
        json.dump(dict(
            roadNodes=len(road_nodes), roadSegments=len(road_segments),
            hospitals=[(x["name"], x["latitude"], x["longitude"], x["facilityKind"]) for x in hosp_list],
            stations=[(x["name"], x["latitude"], x["longitude"], x["stationKind"]) for x in stat_list],
            venues=[(x["name"], x["latitude"], x["longitude"]) for x in venue_list],
            estimatedSpeeds=sum(1 for s in road_segments if s["speedIsEstimated"]),
            realSpeeds=sum(1 for s in road_segments if not s["speedIsEstimated"]),
            bridges=sum(1 for s in road_segments if s["isBridge"]),
        ), f, indent=1)
    print("\nDone.", flush=True)


if __name__ == "__main__":
    main()
