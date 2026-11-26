"""Builds backend/app/data/station_locations.json from DataMeet's railways dataset (ODbL).

    python -I scripts/build-station-locations.py path/to/datameet/stations.json

Download stations.json from https://github.com/datameet/railways first. Only stations in
backend/app/data/railway_stations.json are kept, and only points inside India's bounding box (the dataset has
a few placeholder rows without a location). The output maps a station code to [latitude, longitude].
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIONS = ROOT / "backend" / "app" / "data" / "railway_stations.json"
OUT = ROOT / "backend" / "app" / "data" / "station_locations.json"


def main(source: str) -> None:
    known = {row[0] for row in json.loads(STATIONS.read_text(encoding="utf-8"))["rows"]}
    features = json.loads(Path(source).read_text(encoding="utf-8"))["features"]
    locations = {}
    for f in features:
        geo, props = f.get("geometry"), f.get("properties") or {}
        code = str(props.get("code") or "").strip().upper()
        if not geo or geo.get("type") != "Point" or code not in known:
            continue
        lon, lat = geo["coordinates"][:2]
        if 6 <= lat <= 37 and 68 <= lon <= 98:
            locations[code] = [round(lat, 6), round(lon, 6)]
    out = {"source": "DataMeet railways stations.json (ODbL), https://github.com/datameet/railways",
           "columns": ["latitude", "longitude"], "locations": dict(sorted(locations.items()))}
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(locations)} of {len(known)} stations located -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
