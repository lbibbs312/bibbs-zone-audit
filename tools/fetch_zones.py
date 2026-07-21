#!/usr/bin/env python3
"""Fetch the documented MDOT RIDE work-zone feed and write sanitized zones.json.

Runs in GitHub Actions with MDOT_RIDE_API_KEY provided as a repository
secret. The key is sent only as the api_key header to the fixed MDOT host;
it is never written to the output file, and the script refuses to publish
if the key bytes appear anywhere in the serialized result.

Output: site/data/zones.json — a whitelisted subset of the published WZDx
FeatureCollection, plus fetch metadata. No inference: missing fields stay
null and the client labels them "Not published".
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ENDPOINT = (
    "https://mdotridedata.state.mi.us/api/v1/organization/"
    "michigan_department_of_transportation/dataset/"
    "work_zone_information/query?limit=1&_format=json"
)
ALLOWED_HOST = "mdotridedata.state.mi.us"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
RETRYABLE = {429, 500, 502, 503, 504}
OUTPUT = Path(__file__).resolve().parent.parent / "site" / "data" / "zones.json"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        raise urllib.error.HTTPError(req.full_url, code, "redirect blocked", headers, fp)


def fetch(key: str) -> bytes:
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(
        ENDPOINT,
        headers={
            "api_key": key,
            "Accept": "application/json",
            "User-Agent": "BibbsZoneAudit-Publisher/1.0",
        },
        method="GET",
    )
    if request.host.split(":")[0] != ALLOWED_HOST:
        raise SystemExit("refusing to contact a host other than the documented one")
    last_error = None
    for attempt in range(3):
        try:
            with opener.open(request, timeout=60) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise SystemExit("response exceeded the size ceiling")
                return body
        except urllib.error.HTTPError as error:
            if error.code in RETRYABLE and attempt < 2:
                time.sleep(15 * (attempt + 1))
                last_error = error
                continue
            raise SystemExit(f"RIDE request failed with HTTP {error.code}")
        except urllib.error.URLError as error:
            if attempt < 2:
                time.sleep(15 * (attempt + 1))
                last_error = error
                continue
            raise SystemExit(f"RIDE request failed: {error.reason}")
    raise SystemExit(f"RIDE request failed after retries: {last_error}")


def decode_maybe_json(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value


def text_or_none(value):
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def round_coordinates(value):
    """Round longitude/latitude values to 5 decimals (~1.1 m) to bound file size."""
    if isinstance(value, (int, float)):
        return round(float(value), 5)
    if isinstance(value, list):
        return [round_coordinates(item) for item in value]
    return value


def sanitize_geometry(geometry):
    geometry = decode_maybe_json(geometry)
    if not isinstance(geometry, dict):
        return None
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if kind not in {"LineString", "MultiLineString", "Point"} or coordinates is None:
        return None
    return {"type": kind, "coordinates": round_coordinates(coordinates)}


def sanitize_lanes(lanes):
    lanes = decode_maybe_json(lanes)
    if not isinstance(lanes, list):
        return []
    cleaned = []
    for lane in lanes:
        if isinstance(lane, dict):
            cleaned.append(
                {
                    "order": lane.get("order"),
                    "type": text_or_none(lane.get("type")),
                    "status": text_or_none(lane.get("status")),
                }
            )
    return cleaned


def lane_summary(lanes: list[dict]) -> str:
    parts = []
    for lane in lanes:
        prefix = (
            f"Lane {lane['order']}"
            if lane.get("order") is not None
            else str(lane.get("type") or "lane").replace("-", " ").title()
        )
        status = str(lane.get("status") or "status unknown").replace("-", " ")
        parts.append(f"{prefix}: {status}")
    return "; ".join(parts) or "Lane details not published"


def sanitize_feature(feature: dict) -> dict | None:
    if not isinstance(feature, dict):
        return None
    event_id = text_or_none(feature.get("id"))
    properties = decode_maybe_json(feature.get("properties")) or {}
    if not isinstance(properties, dict):
        properties = {}
    core = decode_maybe_json(properties.get("core_details")) or {}
    if not isinstance(core, dict):
        core = {}
    road_names = decode_maybe_json(core.get("road_names"))
    if not isinstance(road_names, list):
        road_names = []
    road_names = [text_or_none(name) for name in road_names]
    road_names = [name for name in road_names if name]
    lanes = sanitize_lanes(properties.get("lanes"))
    zone = {
        "event_id": event_id,
        "road_names": road_names,
        "road_display": ", ".join(road_names) or "Road not published",
        "direction": text_or_none(core.get("direction")),
        "description": text_or_none(core.get("description")),
        "update_date": text_or_none(core.get("update_date")),
        "event_status": text_or_none(properties.get("event_status")),
        "start_date": text_or_none(properties.get("start_date")),
        "end_date": text_or_none(properties.get("end_date")),
        "beginning_cross_street": text_or_none(properties.get("beginning_cross_street")),
        "ending_cross_street": text_or_none(properties.get("ending_cross_street")),
        "vehicle_impact": text_or_none(properties.get("vehicle_impact")),
        "lanes": lanes,
        "lane_summary": lane_summary(lanes),
        "geometry": sanitize_geometry(feature.get("geometry")),
    }
    return zone if event_id else None


def main() -> int:
    key = (os.environ.get("MDOT_RIDE_API_KEY") or "").strip()
    if not key:
        raise SystemExit("MDOT_RIDE_API_KEY is not set")

    body = fetch(key)
    if key.encode("utf-8") in body:
        raise SystemExit("refusing to continue: response body contains the API key")

    payload = json.loads(body)
    if not isinstance(payload, list) or len(payload) != 1:
        raise SystemExit("response is not the documented one-element array")
    collection = decode_maybe_json(payload[0])
    if not isinstance(collection, dict) or collection.get("type") != "FeatureCollection":
        raise SystemExit("response element is not a FeatureCollection")
    features = decode_maybe_json(collection.get("features"))
    if not isinstance(features, list):
        raise SystemExit("FeatureCollection.features is not an array")

    zones = [zone for zone in (sanitize_feature(feature) for feature in features) if zone]
    road_event_feed_info = decode_maybe_json(collection.get("road_event_feed_info")) or {}
    if not isinstance(road_event_feed_info, dict):
        road_event_feed_info = {}

    result = {
        "generated_at_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "organization": "michigan_department_of_transportation",
            "dataset": "work_zone_information",
            "host": ALLOWED_HOST,
        },
        "feed": {
            "update_date": text_or_none(road_event_feed_info.get("update_date")),
            "version": text_or_none(road_event_feed_info.get("version")),
        },
        "zone_count": len(zones),
        "zones": zones,
    }

    serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if key in serialized:
        raise SystemExit("refusing to publish: serialized output contains the API key")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(serialized + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(OUTPUT.parents[2])} with {len(zones)} zones")
    return 0


if __name__ == "__main__":
    sys.exit(main())
