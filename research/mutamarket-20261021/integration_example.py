"""Offline proof: map public API + ESI samples into our fitting structure.

Run from any directory: python <path>/integration_example.py
This is an integration example, not a registered application route.
"""
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def parse_item_link(text):
    match = re.search(r"showinfo:(\d+)//(\d+)", text)
    if not match:
        raise ValueError("请粘贴带 typeID//itemID 的游戏物品链接")
    type_id, item_id = map(int, match.groups())
    if not (0 < type_id < 2**31 and 0 < item_id < 2**53):
        raise ValueError("物品 ID 超出有效范围")
    return type_id, item_id


def normalize(module, esi, stats, server="tq"):
    if server != "tq":
        raise ValueError("MutaMarket 估价仅用于宁静服；国服必须使用独立数据源")
    if module["source_type"]["id"] != esi["source_type_id"]:
        raise ValueError("原型不一致，不能导入装配")
    if module["mutaplasmid"]["id"] != esi["mutator_type_id"]:
        raise ValueError("突变质体不一致，不能导入装配")
    # The ESI response is authoritative. MutaMarket also includes virtual and
    # derived attributes, which must never be injected into the fitting engine.
    rolled_ids = {a["id"] for a in module["mutated_attributes"]
                  if not a.get("is_derived") and not a.get("is_virtual")}
    attributes = {int(a["attribute_id"]): a["value"] for a in esi["dogma_attributes"]
                  if a["attribute_id"] in rolled_ids}
    if set(attributes) != rolled_ids:
        raise ValueError("估价返回的突变属性与 ESI 不一致")
    if not attributes or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in attributes.values()):
        raise ValueError("真实属性缺失或无效")
    model = next((s for s in stats if s["type_id"] == module["type"]["id"]), None)
    value = module.get("estimated_value")
    if value is not None and (not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0):
        value = None
    return {
        "server": server,
        "item_id": module["id"],
        "type_id": module["type"]["id"],
        "estimated_value": value,
        "estimated_value_updated_at": module.get("estimated_value_updated_at"),
        "model": {key: model.get(key) for key in ("data_count", "r2", "mae", "nmae", "last_trained_at")} if model else None,
        "source_url": "https://mutamarket.com/modules/" + module["slug"],
        "fit": {"type": module["type"]["id"],
                "mut": {"base": esi["source_type_id"], "mutator": esi["mutator_type_id"], "attrs": attributes}},
    }


def main():
    stats = read("estimator-statistics.json")
    battery = read("sample-module.json")["data"]
    bcs = read("bcs-module.json")["data"]
    result = [normalize(battery, read("sample-esi.json"), stats),
              normalize(bcs, read("bcs-esi.json"), stats)]
    assert parse_item_link(f"<url=showinfo:{battery['type']['id']}//{battery['id']}>module</url>") == (48439, 1056160153322)
    assert len(result[0]["fit"]["mut"]["attrs"]) == 4
    assert 5000004 not in result[1]["fit"]["mut"]["attrs"]
    assert 1255 not in result[1]["fit"]["mut"]["attrs"]
    unpriced = normalize({**battery, "estimated_value": None}, read("sample-esi.json"), stats)
    assert unpriced["estimated_value"] is None
    for server in ("serenity", "infinity"):
        try:
            normalize(battery, read("sample-esi.json"), stats, server)
        except ValueError:
            pass
        else:
            raise AssertionError("国服不应使用宁静估价")
    output = ROOT / "integration-sample.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PASS: 2 public modules mapped; derived/virtual fields excluded; null and server guards verified. {output.name}")


if __name__ == "__main__":
    main()
