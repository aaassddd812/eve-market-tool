"""One public sample refresh plus read-only ESI/unit comparisons."""
import json
import probe


def compare(module, raw):
    actual = {a["attribute_id"]: a["value"] for a in raw.get("dogma_attributes", [])}
    return [{"attribute_id": a["id"], "name": a["name"], "api_value": a["value"],
             "esi_value": actual.get(a["id"]), "is_derived": a.get("is_derived"),
             "is_virtual": a.get("is_virtual"),
             "matches_raw": actual.get(a["id"]) == a["value"]}
            for a in module["mutated_attributes"]]


def main():
    manifest = probe.ROOT / "requests.json"
    probe.records.extend(json.loads(manifest.read_text(encoding="utf-8")))
    try:
        sample = json.loads((probe.ROOT / "sample-module.json").read_text(encoding="utf-8"))["data"]
        # This is an already public listing; refresh it once, with no user data.
        fresh = probe.fetch("/api/modules", "sample-refresh.json",
                            {"type_id": sample["type"]["id"], "item_id": sample["id"]})
        esi = probe.fetch(f"https://esi.evetech.net/latest/dogma/dynamic/items/{sample['type']['id']}/{sample['id']}/",
                          "sample-esi.json")
        bullets = probe.fetch("/api/modules/type/49738", "bcs-type-list.json")
        bcs = bullets["data"][0]
        (probe.ROOT / "bcs-module.json").write_text(json.dumps({"data": bcs}, indent=2), encoding="utf-8")
        bcs_raw = probe.fetch(f"https://esi.evetech.net/latest/dogma/dynamic/items/{bcs['type']['id']}/{bcs['id']}/",
                              "bcs-esi.json")
        summary = {"refresh_estimate": fresh["data"].get("estimated_value") if fresh else None,
                   "battery_comparison": compare(sample, esi) if esi else None,
                   "bcs_comparison": compare(bcs, bcs_raw) if bcs_raw else None}
        (probe.ROOT / "unit-comparison.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps(summary), flush=True)
    finally:
        manifest.write_text(json.dumps(probe.records, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
