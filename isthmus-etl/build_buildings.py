#!/usr/bin/env python3
"""
ISTHMUS — Stage 3: extract building footprints from the cached OSM XML tiles and
emit them as `data/Building/building.json` for upsert.

Runs entirely off the tiles already on disk in ./raw — no network access. The
tiles were cut on a lat/lon grid, so a building can appear in more than one of
them and a building near a tile seam can reference nodes that live in a
neighbouring tile; both are handled by parsing every tile into one node table
and deduplicating ways by OSM id before any geometry is built.

What is kept:
  * closed `building=*` ways whose centroid falls in the CORE box
  * with every referenced node resolvable (a way clipped by the *download* box
    edge is dropped rather than closed with a guessed vertex)
  * with footprint area >= MIN_AREA (drops sheds, bin stores, map noise)

Height is resolved in strict order of evidence and the winning rule is recorded
on the row, because ~85% of this extract has no height information at all:
  1. `height` / `building:height` tag        -> real,      "osm:height"
  2. `building:levels` x STOREY_METERS       -> estimated, "osm:building:levels"
  3. per-class default                       -> estimated, "default:<kind>"

`building:part` ways are deliberately skipped: they describe sub-volumes of a
building already present as its own way, and extruding both would double-draw
the same mass.
"""
import json
import math
import os
import re
from collections import defaultdict
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
PKG = os.path.join(os.path.dirname(HERE), "pkg323033d0")
DATA = os.path.join(PKG, "data")

# Same boxes build_graph.py used, so `inCoreArea` means the same thing on a
# Building as it does on a RoadNode.
CORE = dict(south=43.0520, north=43.0880, west=-89.4450, east=-89.3700)

MIN_AREA = 40.0          # m^2 — below this it is a shed or a digitising artefact
STOREY_METERS = 3.3      # assumed floor-to-floor; an estimate, flagged as one
MAX_RING_POINTS = 64     # ring vertex cap; only pathological rings exceed this

# Sub-volume and non-building tags we never want as their own extrusion.
SKIP_KINDS = {"no", "roof", "bridge", "construction"}

# Per-class fallback heights, in metres. Each is a storey count x STOREY_METERS,
# chosen to be plausible for Madison's isthmus rather than flattering: a wrong
# default should look boring, not dramatic.
DEFAULT_HEIGHT = {
    "house": 2 * STOREY_METERS,
    "detached": 2 * STOREY_METERS,
    "semidetached_house": 2 * STOREY_METERS,
    "bungalow": 1 * STOREY_METERS,
    "static_caravan": 1 * STOREY_METERS,
    "cabin": 1 * STOREY_METERS,
    "hut": 1 * STOREY_METERS,
    "shed": 1 * STOREY_METERS,
    "garage": 1 * STOREY_METERS,
    "garages": 1 * STOREY_METERS,
    "carport": 1 * STOREY_METERS,
    "greenhouse": 1 * STOREY_METERS,
    "service": 1 * STOREY_METERS,
    "terrace": 2 * STOREY_METERS,
    "residential": 3 * STOREY_METERS,
    "apartments": 4 * STOREY_METERS,
    "dormitory": 4 * STOREY_METERS,
    "hotel": 5 * STOREY_METERS,
    "retail": 2 * STOREY_METERS,
    "commercial": 3 * STOREY_METERS,
    "office": 4 * STOREY_METERS,
    "industrial": 2 * STOREY_METERS,
    "warehouse": 2 * STOREY_METERS,
    "manufacture": 2 * STOREY_METERS,
    "school": 3 * STOREY_METERS,
    "college": 4 * STOREY_METERS,
    "university": 4 * STOREY_METERS,
    "hospital": 5 * STOREY_METERS,
    "civic": 3 * STOREY_METERS,
    "public": 3 * STOREY_METERS,
    "government": 4 * STOREY_METERS,
    "church": 4 * STOREY_METERS,
    "cathedral": 6 * STOREY_METERS,
    "chapel": 3 * STOREY_METERS,
    "synagogue": 3 * STOREY_METERS,
    "mosque": 3 * STOREY_METERS,
    "temple": 3 * STOREY_METERS,
    "parking": 3 * STOREY_METERS,
    "stadium": 6 * STOREY_METERS,
    "sports_hall": 3 * STOREY_METERS,
    "sports_centre": 3 * STOREY_METERS,
    "train_station": 2 * STOREY_METERS,
    "transportation": 2 * STOREY_METERS,
    "yes": 2 * STOREY_METERS,
}
GENERIC_DEFAULT = 2 * STOREY_METERS


def in_box(lat, lon, b):
    return b["south"] <= lat <= b["north"] and b["west"] <= lon <= b["east"]


def parse_height(tags):
    """Return metres from an explicit height tag, or None.

    OSM height is documented as metres, but feet-with-quotes and bare
    `12 m` both occur. Anything else is refused rather than coerced.
    """
    for key in ("height", "building:height"):
        v = tags.get(key)
        if not v:
            continue
        v = v.strip().lower()
        m = re.match(r"^(\d+(?:\.\d+)?)\s*m?$", v)
        if m:
            h = float(m.group(1))
            if 1.0 <= h <= 400.0:
                return h
        m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:ft|')$", v)
        if m:
            h = float(m.group(1)) * 0.3048
            if 1.0 <= h <= 400.0:
                return h
    return None


def parse_levels(tags):
    """Return a storey count from `building:levels`, or None.

    Fractional and signed values ("2.5", "-1" for a basement-only part) are
    refused: a level count that cannot be read as a whole above-ground storey
    is better treated as absent than rounded into a fact.
    """
    v = tags.get("building:levels")
    if not v:
        return None
    m = re.match(r"^(\d{1,2})$", v.strip())
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= 80 else None


def ring_metrics(points):
    """Centroid (vertex mean) and shoelace area in m^2 for a lat/lon ring."""
    # Drop the duplicated closing vertex for the averages.
    uniq = points[:-1] if len(points) > 1 and points[0] == points[-1] else points
    n = len(uniq)
    clat = sum(p[0] for p in uniq) / n
    clon = sum(p[1] for p in uniq) / n

    # Equirectangular projection about the centroid — the footprint is tens of
    # metres across, so the distortion is far below the digitising error.
    mlat = 111132.0
    mlon = 111320.0 * math.cos(math.radians(clat))
    acc = 0.0
    for i in range(n):
        x1 = (uniq[i][1] - clon) * mlon
        y1 = (uniq[i][0] - clat) * mlat
        j = (i + 1) % n
        x2 = (uniq[j][1] - clon) * mlon
        y2 = (uniq[j][0] - clat) * mlat
        acc += x1 * y2 - x2 * y1
    return clat, clon, abs(acc) / 2.0


def simplify_ring(points, clat, tol_m=0.4):
    """Douglas-Peucker on a closed lat/lon ring, tolerance in metres.

    OSM building outlines routinely carry vertices that sit on a straight wall,
    and at 0.4 m the tolerance is an order of magnitude below the accuracy of
    the aerial tracing that produced them — so this removes transmitted bytes,
    not shape. The ring is simplified as an open polyline between its first and
    last (identical) vertex, which pins the corner that closes it.
    """
    if len(points) <= 5:
        return points
    mlat = 111132.0
    mlon = 111320.0 * math.cos(math.radians(clat))
    pts = [((p[1]) * mlon, (p[0]) * mlat) for p in points]

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        x1, y1 = pts[lo]
        x2, y2 = pts[hi]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        worst, widx = -1.0, lo
        for i in range(lo + 1, hi):
            px, py = pts[i]
            if norm == 0.0:
                d = math.hypot(px - x1, py - y1)
            else:
                d = abs(dy * (px - x1) - dx * (py - y1)) / norm
            if d > worst:
                worst, widx = d, i
        if worst > tol_m:
            keep[widx] = True
            stack.append((lo, widx))
            stack.append((widx, hi))

    out = [p for p, k in zip(points, keep) if k]
    # A ring needs 3 distinct corners plus the closing vertex to be a polygon.
    return out if len(out) >= 4 else points


def thin_ring(points, cap):
    """Evenly drop vertices from an over-long ring, keeping it closed."""
    if len(points) <= cap:
        return points
    body = points[:-1]
    step = len(body) / float(cap - 1)
    kept = [body[int(i * step)] for i in range(cap - 1)]
    kept.append(kept[0])
    return kept


def load_names(filename, key="name"):
    path = os.path.join(DATA, filename)
    if not os.path.exists(path):
        return set()
    with open(path) as fh:
        rows = json.load(fh)
    return {r[key].strip().lower() for r in rows if r.get(key)}


def main():
    tiles = sorted(f for f in os.listdir(RAW) if f.endswith(".xml"))
    if not tiles:
        raise SystemExit("no tiles in %s — nothing to extract" % RAW)

    nodes = {}
    ways = {}
    tag_census = defaultdict(int)
    relation_multipolygons = 0

    for t in tiles:
        # Clear via the root, not via the element: an `end` event fires for every
        # <tag> and <nd> child *before* its parent <way>, so clearing the element
        # the event hands you wipes the attributes you are about to read.
        ctx = ET.iterparse(os.path.join(RAW, t), events=("start", "end"))
        _, root = next(ctx)
        for ev, el in ctx:
            if ev != "end":
                continue
            if el.tag == "node":
                nid = el.get("id")
                if nid not in nodes:
                    nodes[nid] = (float(el.get("lat")), float(el.get("lon")))
            elif el.tag == "way":
                wid = el.get("id")
                if wid not in ways:
                    tags = {c.get("k"): c.get("v") for c in el.findall("tag")}
                    if "building" in tags:
                        ways[wid] = (
                            [n.get("ref") for n in el.findall("nd")],
                            tags,
                        )
            elif el.tag == "relation":
                tags = {c.get("k"): c.get("v") for c in el.findall("tag")}
                if tags.get("type") == "multipolygon" and "building" in tags:
                    relation_multipolygons += 1
            else:
                continue
            root.clear()

    out = []
    stats = defaultdict(int)
    stats["building_ways_seen"] = len(ways)
    stats["multipolygon_buildings_skipped"] = relation_multipolygons

    venue_names = load_names("Venue/venue.json")
    hospital_names = load_names("Hospital/hospital.json")
    landmark_names = venue_names | hospital_names

    for wid, (refs, tags) in ways.items():
        kind = (tags.get("building") or "yes").strip().lower()
        if kind in SKIP_KINDS:
            stats["skipped_kind"] += 1
            continue
        if len(refs) < 4:
            stats["skipped_too_few_nodes"] += 1
            continue
        if refs[0] != refs[-1]:
            stats["skipped_open_way"] += 1
            continue

        pts = []
        missing = False
        for r in refs:
            p = nodes.get(r)
            if p is None:
                missing = True
                break
            pts.append(p)
        if missing:
            stats["skipped_unresolved_node"] += 1
            continue

        # Collapse consecutive duplicate vertices before measuring.
        ring = [pts[0]]
        for p in pts[1:]:
            if p != ring[-1]:
                ring.append(p)
        if len(ring) < 3:
            stats["skipped_degenerate"] += 1
            continue
        ring.append(ring[0])

        clat, clon, area = ring_metrics(ring)
        if not in_box(clat, clon, CORE):
            stats["skipped_outside_core"] += 1
            continue
        if area < MIN_AREA:
            stats["skipped_small"] += 1
            continue

        stats["vertices_in"] += len(ring)
        ring = thin_ring(simplify_ring(ring, clat), MAX_RING_POINTS)
        stats["vertices_out"] += len(ring)

        height = parse_height(tags)
        if height is not None:
            est, src = False, "osm:height"
            stats["height_from_tag"] += 1
        else:
            levels = parse_levels(tags)
            if levels is not None:
                height = levels * STOREY_METERS
                est, src = True, "osm:building:levels"
                stats["height_from_levels"] += 1
            else:
                height = DEFAULT_HEIGHT.get(kind, GENERIC_DEFAULT)
                est, src = True, "default:%s" % kind
                stats["height_from_default"] += 1

        name = (tags.get("name") or "").strip() or None
        row = {
            "id": "BLD_%s" % wid,
            "osmWayId": wid,
            "buildingKind": kind,
            "centroidLatitude": round(clat, 6),
            "centroidLongitude": round(clon, 6),
            "footprint": json.dumps(
                [[round(p[0], 6), round(p[1], 6)] for p in ring],
                separators=(",", ":"),
            ),
            "areaSquareMeters": round(area, 1),
            "heightMeters": round(height, 1),
            "heightIsEstimated": est,
            "heightSource": src,
            "inCoreArea": True,
            "isNotableLandmark": bool(name and name.lower() in landmark_names),
            "source": "OpenStreetMap way/%s" % wid,
        }
        if name:
            row["name"] = name
        lv = parse_levels(tags)
        if lv is not None:
            row["levels"] = lv
        out.append(row)

    out.sort(key=lambda r: r["id"])
    dest = os.path.join(DATA, "Building")
    os.makedirs(dest, exist_ok=True)
    path = os.path.join(dest, "building.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    stats["emitted"] = len(out)
    stats["named"] = sum(1 for r in out if r.get("name"))
    stats["landmarks"] = sum(1 for r in out if r["isNotableLandmark"])
    stats["file_bytes"] = os.path.getsize(path)
    kinds = defaultdict(int)
    for r in out:
        kinds[r["buildingKind"]] += 1
    report = {
        "tiles": len(tiles),
        "stats": dict(sorted(stats.items())),
        "top_kinds": dict(sorted(kinds.items(), key=lambda kv: -kv[1])[:12]),
        "tallest": [
            {"name": r.get("name"), "h": r["heightMeters"], "est": r["heightIsEstimated"]}
            for r in sorted(out, key=lambda r: -r["heightMeters"])[:10]
        ],
    }
    with open(os.path.join(HERE, "buildings_report.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
