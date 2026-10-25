#!/usr/bin/env python3
"""
ISTHMUS — Stage 1: download raw OpenStreetMap data for the Madison isthmus / UW campus.

Uses the OSM main API (api.openstreetmap.org/api/0.6/map), which is reachable from this
environment (Overpass is blocked by the egress proxy). The map API caps each request at
50k nodes, so we tile the bbox and recursively subdivide any tile the server rejects.

Raw XML is cached under raw/ so the pipeline can be re-run WITHOUT re-downloading.
"""
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# Buffered download box (buffer ~1km beyond the core analysis area to avoid
# artificial dead-ends at the boundary distorting routing later).
DL = dict(south=43.0450, north=43.0950, west=-89.4550, east=-89.3600)

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")
API = "https://api.openstreetmap.org/api/0.6/map?bbox={w:.5f},{s:.5f},{e:.5f},{n:.5f}"
UA = "ISTHMUS-digital-twin/1.0 (C3 AI demo; EMS response modeling)"

NX, NY = 6, 4          # initial grid
MAX_DEPTH = 4          # recursive subdivision depth cap


def tile_path(s, w, n, e):
    return os.path.join(RAW, f"tile_{s:.5f}_{w:.5f}_{n:.5f}_{e:.5f}.xml")


def fetch(s, w, n, e, depth=0):
    """Download one tile; subdivide on rejection. Returns list of written paths."""
    path = tile_path(s, w, n, e)
    if os.path.exists(path) and os.path.getsize(path) > 200:
        return [path]

    url = API.format(s=s, w=w, n=n, e=e)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        print(f"  OK   depth={depth} {len(data)/1e6:6.2f}MB  {s:.4f},{w:.4f} {n:.4f},{e:.4f}", flush=True)
        return [path]
    except urllib.error.HTTPError as ex:
        # 400 = bbox too large / too many nodes -> subdivide. 509 = rate limited -> backoff.
        if ex.code in (400, 413) and depth < MAX_DEPTH:
            print(f"  SPLIT depth={depth} ({ex.code}) {s:.4f},{w:.4f} {n:.4f},{e:.4f}", flush=True)
            mlat, mlon = (s + n) / 2, (w + e) / 2
            out = []
            for qs, qw, qn, qe in ((s, w, mlat, mlon), (s, mlon, mlat, e),
                                   (mlat, w, n, mlon), (mlat, mlon, n, e)):
                out += fetch(qs, qw, qn, qe, depth + 1)
            return out
        if ex.code in (429, 509, 503):
            time.sleep(10 + 5 * depth)
            return fetch(s, w, n, e, depth)  # retry same tile
        print(f"  ERR  {ex.code} {ex.reason} {s:.4f},{w:.4f} {n:.4f},{e:.4f}", file=sys.stderr, flush=True)
        return []
    except Exception as ex:  # transient network
        if depth < MAX_DEPTH:
            time.sleep(5)
            return fetch(s, w, n, e, depth + 1) if False else fetch(s, w, n, e, depth)
        print(f"  ERR  {ex} {s:.4f},{w:.4f} {n:.4f},{e:.4f}", file=sys.stderr, flush=True)
        return []


def main():
    os.makedirs(RAW, exist_ok=True)
    dlat = (DL["north"] - DL["south"]) / NY
    dlon = (DL["east"] - DL["west"]) / NX
    tiles = []
    for i in range(NX):
        for j in range(NY):
            tiles.append((DL["south"] + j * dlat, DL["west"] + i * dlon,
                          DL["south"] + (j + 1) * dlat, DL["west"] + (i + 1) * dlon))
    print(f"Downloading {len(tiles)} tiles over {DL}", flush=True)

    written = []
    # Keep concurrency modest — api.openstreetmap.org is a shared community resource.
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(fetch, *t): t for t in tiles}
        for f in as_completed(futs):
            written += f.result()

    total = sum(os.path.getsize(p) for p in written)
    print(f"\nDONE {len(written)} files, {total/1e6:.1f} MB in {RAW}", flush=True)


if __name__ == "__main__":
    main()
