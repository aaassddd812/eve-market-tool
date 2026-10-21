"""Collect public MutaMarket evidence; no account, cookies, or EVE tokens.

Default: a bounded set of GETs. --refresh-public-sample performs ONE POST
to refresh the already public sample (never use it in an automatic loop).
"""
import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
BASE = "https://mutamarket.com"
SAMPLE = 1056160153322  # Public listing linked by /modules on 2026-10-21.
UA = "EVEHelperResearch/0.1 (+https://eve.navexor.top/)"
records = []


def fetch(path, filename, body=None, origin=None):
    url = urljoin(BASE, path)
    headers = {"User-Agent": UA, "Accept": "application/json,text/html,*/*"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if origin:
        headers["Origin"] = origin
    req = Request(url, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    started = time.monotonic()
    try:
        response = urlopen(req, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        status = response.code
        selected_headers = {k.lower(): v for k, v in response.headers.items()
                            if k.lower() in {"content-type", "cache-control", "access-control-allow-origin", "vary", "retry-after"}}
    out = ROOT / filename
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(raw)
    record = {"url": url, "method": req.get_method(), "status": status,
              "seconds": round(time.monotonic() - started, 3), "file": filename,
              "sha256": hashlib.sha256(raw).hexdigest(), "headers": selected_headers,
              "observed_at": datetime.now(timezone.utc).isoformat()}
    records.append(record)
    print(json.dumps({k: record[k] for k in ["method", "url", "status", "seconds"]}), flush=True)
    if "json" in selected_headers.get("content-type", ""):
        return json.loads(raw) if status == 200 else None
    return raw.decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-public-sample", action="store_true")
    args = parser.parse_args()
    try:
        spec = fetch("/api/openapi.json", "openapi.json")
        stats = fetch("/api/estimator-statistics", "estimator-statistics.json")
        ranges = fetch("/api/abyssal-type-statistics", "abyssal-type-statistics.json")
        sample = fetch(f"/api/modules/{SAMPLE}", "sample-module.json", origin="https://eve.navexor.top")
        if sample and isinstance(sample.get("data"), dict):
            m = sample["data"]
            type_id = m["type"]["id"]
            summary = {"item_id": m["id"], "type": m["type"],
                       "source_type": m.get("source_type"), "mutaplasmid": m.get("mutaplasmid"),
                       "estimated_value": m.get("estimated_value"),
                       "estimated_value_updated_at": m.get("estimated_value_updated_at"),
                       "asking_price": (m.get("contract") or {}).get("price"),
                       "attribute_count": len(m.get("mutated_attributes", [])),
                       "model": next((x for x in stats or [] if x["type_id"] == type_id), None)}
            (ROOT / "sample-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(json.dumps(summary), flush=True)
            fetch(f"/api/modules/type/{type_id}", "sample-type-list.json")
            if args.refresh_public_sample:
                fetch("/api/modules", "sample-refresh.json", {"type_id": type_id, "item_id": SAMPLE})
        for page, name in [("/modules/add", "appraise"), ("/documentation/appraisal", "doc-appraisal"),
                           ("/documentation/api-overview", "doc-api-overview"),
                           ("/documentation/api-modules", "doc-api-modules")]:
            html = fetch(page, name + ".html")
            if name == "appraise" and isinstance(html, str):
                # Route nodes and the entrypoint are observed in the HTML.
                urls = re.findall(r'<link[^>]+href="([^"]+\.js)"', html)
                nodes = [urljoin(BASE + page, u) for u in urls if "/nodes/" in u or "/entry/app." in u]
                for u in dict.fromkeys(nodes):
                    fetch(u, "scripts/" + u.rsplit("/", 1)[-1])
        if stats:
            print(json.dumps({"model_types": len(stats), "trained": sum(x.get("r2") is not None for x in stats),
                              "untrained": sum(x.get("r2") is None for x in stats), "range_rows": len(ranges or [])}), flush=True)
    finally:
        (ROOT / "requests.json").write_text(json.dumps(records, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
