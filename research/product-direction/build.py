#!/usr/bin/env python3
"""Validate research inputs and build a standalone, offline HTML report."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
SECTION_IDS = ["overview", "diagnosis", "market", "audience", "ideas", "strategy", "top3", "recommendation", "mvp", "roadmap", "cuts", "sources"]
CRITERIA_IDS = ["pain", "evidence", "difference", "first", "return", "cold", "cost", "depth", "scale"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def unique_ids(items, label):
    ids = [item.get("id") for item in items]
    require(all(isinstance(value, str) and value for value in ids), f"{label}: missing id")
    require(len(ids) == len(set(ids)), f"{label}: duplicate id")
    return set(ids)


def source_refs(items, source_ids, label):
    for item in items:
        refs = item.get("sources")
        require(isinstance(refs, list) and bool(refs), f"{label}: missing sources for {item.get('id', item.get('title'))}")
        missing = set(refs) - source_ids
        require(not missing, f"{label}: unknown sources {sorted(missing)}")


class DocumentCheck(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.sections, self.sources = [], [], []
        self.local_links, self.external_assets = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        if tag == "section":
            self.sections.append(attrs.get("id"))
        if attrs.get("data-source"):
            self.sources.append(attrs["data-source"])
        if tag == "a" and attrs.get("href", "").startswith("#"):
            self.local_links.append(attrs["href"][1:])
        if tag in {"script", "img", "iframe", "audio", "video", "source"} and attrs.get("src"):
            self.external_assets.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.external_assets.append(attrs.get("href"))


def build():
    data = {"date": "2026-10-29", "products": [], "sources": [], "voices": []}
    for filename in ("market-community.json", "market-terminal.json", "root-research.json"):
        bundle = read_json(filename)
        for key in ("products", "sources", "voices"):
            require(isinstance(bundle.get(key), list), f"{filename}: {key} must be an array")
            data[key].extend(bundle[key])
    data["ideas"], data["criteria"] = read_json("ideas.json"), read_json("criteria.json")
    require(len(data["products"]) == 24, "Expected 24 product/tool entries")
    require(len(data["ideas"]) == 10, "Expected 10 idea candidates")
    require(len(data["criteria"]) == 9, "Expected 9 evaluation criteria")
    unique_ids(data["products"], "products")
    unique_ids(data["ideas"], "ideas")
    source_ids = unique_ids(data["sources"], "sources")
    require([criterion["id"] for criterion in data["criteria"]] == CRITERIA_IDS, "Criteria order mismatch")
    weights = [criterion["weight"] for criterion in data["criteria"]]
    require(sum(weights) == 100 and all(weight > 0 for weight in weights), "Default weights must sum to 100")
    for source in data["sources"]:
        require(urlparse(source.get("url", "")).scheme in {"https", "http"}, f"Unsafe source URL: {source['id']}")
        require(source.get("type") in {"공식", "사용자 의견", "연구"}, f"Unknown source type: {source['id']}")
        require(source.get("checked") == data["date"], f"Source check date mismatch: {source['id']}")
    for key in ("products", "ideas", "voices"):
        source_refs(data[key], source_ids, key)
    for idea in data["ideas"]:
        scores, reasons = idea.get("scores", []), idea.get("reasons", [])
        require(len(scores) == 9 and len(reasons) == 9, f"{idea['id']}: score/reason length mismatch")
        require(all(type(score) is int and 1 <= score <= 5 for score in scores), f"{idea['id']}: scores must be integers from 1 to 5")
        require(all(isinstance(reason, str) and reason.strip() for reason in reasons), f"{idea['id']}: empty score rationale")
        for field in ("problem", "audience", "solution", "scenario", "difference", "terminal", "return", "cold", "implementation", "risk"):
            require(isinstance(idea.get(field), str) and idea[field].strip(), f"{idea['id']}: missing {field}")

    shell = (ROOT / "shell.html").read_text(encoding="utf-8")
    content = "\n".join((ROOT / name).read_text(encoding="utf-8") for name in ("sections-a.html", "sections-b.html", "sections-c.html"))
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    javascript = (ROOT / "app.js").read_text(encoding="utf-8")
    require(not re.search(r"</style", css, re.I), "CSS contains an HTML closing-style sequence")
    require(not re.search(r"</script", javascript, re.I), "JavaScript contains an HTML closing-script sequence")
    serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    replacements = {
        "<!-- CONTENT -->": content,
        "/* INLINE_CSS */": css,
        "/* INLINE_DATA */": "window.REPORT=" + serialized + ";",
        "/* INLINE_JS */": javascript,
    }
    html = shell
    for marker, value in replacements.items():
        require(html.count(marker) == 1, f"Missing or repeated template marker: {marker}")
        html = html.replace(marker, value, 1)
    check = DocumentCheck()
    check.feed(html)
    require(check.sections == SECTION_IDS, f"Unexpected section sequence: {check.sections}")
    require(len(check.ids) == len(set(check.ids)), "Duplicate HTML id")
    require(not (set(check.sources) - source_ids), f"Unknown static source references: {set(check.sources) - source_ids}")
    require(not (set(check.local_links) - set(check.ids)), f"Broken local section links: {set(check.local_links) - set(check.ids)}")
    require(not check.external_assets, f"Runtime assets are not self-contained: {check.external_assets}")
    require(not any(marker in html for marker in replacements), "Unreplaced build marker")
    (ROOT / "research-data.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (ROOT / "index.html").write_text(html, encoding="utf-8")
    ranking = sorted(data["ideas"], key=lambda idea: -sum(score * weight for score, weight in zip(idea["scores"], weights)))
    summary = {
        "products": len(data["products"]), "ideas": len(data["ideas"]),
        "sources": len(data["sources"]), "unique_source_urls": len({source["url"] for source in data["sources"]}),
        "voices": len(data["voices"]), "criteria": len(data["criteria"]),
        "html_bytes": (ROOT / "index.html").stat().st_size,
        "data_bytes": (ROOT / "research-data.json").stat().st_size,
        "top3": [{"id": idea["id"], "score": sum(score * weight for score, weight in zip(idea["scores"], weights)) / sum(weights) * 20} for idea in ranking[:3]],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build()
