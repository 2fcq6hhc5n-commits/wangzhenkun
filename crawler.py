import gzip
import json
import re
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import storage


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
VERSIONS_DIR = DATA_DIR / "versions"
LATEST_FILE = DATA_DIR / "latest.json"
VERSIONS_FILE = VERSIONS_DIR / "index.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

SOURCES = [
    {
        "key": "school",
        "label": "校招",
        "recruit_type": 1,
        "url": "https://www.nowcoder.com/jobs/school/jobs",
    },
    {
        "key": "intern",
        "label": "实习",
        "recruit_type": 2,
        "url": "https://www.nowcoder.com/jobs/intern/center",
    },
    {
        "key": "fulltime",
        "label": "社招",
        "recruit_type": 3,
        "url": "https://www.nowcoder.com/jobs/fulltime/center",
    },
]

EDU_LEVEL_MAP = {
    0: "不限",
    3000: "大专",
    4000: "本科",
    5000: "本科",
    5001: "硕士",
    5002: "博士",
    6000: "硕士",
}

_lock = threading.RLock()
_status = {
    "is_crawling": False,
    "last_crawled_at": None,
    "next_crawl_at": None,
    "last_error": None,
    "last_version": None,
}
_current = {
    "version": None,
    "created_at": None,
    "jobs": [],
    "meta": {},
}


def _read_json(path, default=None):
    return storage.read_json(path, default)


def _write_json(path, payload):
    storage.write_json(path, payload)


def _fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if resp.headers.get("Content-Encoding", "").lower() == "gzip":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def _fetch_page(url):
    last_error = None
    for attempt in range(3):
        try:
            html = _fetch(url)
            if "aliyun_waf" in html or "window.__INITIAL_STATE__=" not in html:
                raise RuntimeError("页面返回了验证页或缺少初始化数据")
            return html
        except Exception as exc:
            last_error = exc
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"抓取失败: {last_error}")


def _parse_state(html):
    marker = "window.__INITIAL_STATE__="
    start = html.find(marker)
    if start < 0:
        raise RuntimeError("未找到页面初始化数据")
    payload = html[start + len(marker):]
    state, _ = json.JSONDecoder().raw_decode(payload)
    return state


def _extract_jobs(state, source_key):
    if source_key == "school":
        for module in (state.get("app") or {}).values():
            if isinstance(module, dict) and isinstance(module.get("jobListData"), list):
                return module["jobListData"]
        return []

    store = state.get("store") or {}
    if source_key == "intern":
        return (store.get("interCenter") or {}).get("jobList") or []
    if source_key == "fulltime":
        return (store.get("fulltimeCenter") or {}).get("jobList") or []
    return []


def _clean(value):
    if value is None:
        return ""
    return str(value).strip()


def _company_name(data):
    company = data.get("recommendInternCompany") or {}
    name = company.get("companyName") or company.get("companyShortName")
    if not name:
        user = data.get("user") or {}
        identities = user.get("identity") or []
        if identities:
            name = identities[0].get("companyName")
    return _clean(name) or "-"


def _company_fields(data, name):
    company = data.get("recommendInternCompany") or {}
    if not company:
        user = data.get("user") or {}
        identities = user.get("identity") or []
        if identities:
            company = {"companyId": identities[0].get("companyId")}
    industries = [
        _clean(item)
        for item in (company.get("industryTagNameList") or [])
        if _clean(item)
    ]
    return {
        "company_id": str(company.get("companyId") or company.get("tagId") or f"name:{name}"),
        "company_logo": _clean(company.get("picUrl")) or "",
        "company_industry": " / ".join(industries) or "",
        "company_scale": _clean(company.get("personScales")) or "",
        "company_financing": _clean(company.get("scaleTagName")) or "",
        "company_address": _clean(company.get("address")) or "",
    }


def _salary_text(data):
    if data.get("salaryShow"):
        return _clean(data["salaryShow"])
    salary_type = data.get("salaryType")
    salary_min = data.get("salaryMin")
    salary_max = data.get("salaryMax")
    if salary_type == 1 and salary_min and salary_max:
        return f"{salary_min}-{salary_max} 元/天"
    if salary_type == 2 and salary_min and salary_max:
        month = data.get("salaryMonth")
        suffix = f"·{month}薪" if month else ""
        return f"{salary_min}-{salary_max}k{suffix}"
    if salary_type == 3 and salary_min and salary_max:
        return f"{salary_min}-{salary_max} 元/小时"
    return "-"


def _requirement(data):
    try:
        ext = json.loads(data.get("ext") or "{}")
        requirement = _clean(ext.get("requirements"))
        if not requirement:
            return ""
        return " ".join(requirement.split())[:120]
    except (TypeError, ValueError, json.JSONDecodeError):
        return ""


def _plain_text(value):
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(value))
    return " ".join(text.split())[:120]


def _normalize_external_job(data, raw, source):
    job_id = data.get("id") or raw.get("id") or data.get("entityId")
    recruit_type = source["recruit_type"]
    city = _clean(data.get("city")) or ""
    if not city:
        extra = data.get("extraInfo") or {}
        city = _clean(extra.get("jobCity_var"))
    tags = [_clean(item) for item in (data.get("skills") or []) if _clean(item)]
    pc_tags = data.get("pcTagInfo") or {}
    for tag_info in pc_tags.get("jobInfoTagList") or []:
        tag = (tag_info.get("tag") or {}).get("title")
        if tag:
            tags.append(_clean(tag))
    updated_ms = data.get("updateTime") or 0
    return {
        "key": f"{recruit_type}:{job_id}",
        "id": job_id,
        "source": source["key"],
        "source_label": source["label"],
        "recruit_type": recruit_type,
        "job_name": _clean(data.get("jobTitle")) or "-",
        "company_name": _clean(data.get("companyName")) or "-",
        "city": city or "-",
        "salary": _clean(data.get("salary")) or "-",
        "education": _clean(data.get("education")) or "不限",
        "graduate_year": "",
        "tags": tags,
        "requirement": _plain_text(data.get("description")),
        "updated_ms": int(updated_ms or 0),
        "publish_ms": int(data.get("createTime") or 0),
        "detail_url": _clean(data.get("router")) or f"https://www.nowcoder.com/jobs/detail/{job_id}",
        "company_id": str(data.get("companyId") or f"name:{data.get('companyName')}"),
        "company_logo": _clean(data.get("companyLogo")) or "",
        "company_industry": _clean(data.get("industry")) or "",
        "company_scale": _clean(data.get("scale")) or "",
        "company_financing": _clean(data.get("financing")) or "",
        "company_address": "",
        "change": "unchanged",
    }


def _normalize_job(raw, source):
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    if data.get("jobTitle") and data.get("companyName"):
        return _normalize_external_job(data, raw, source)
    job_id = data.get("id") or raw.get("id")
    recruit_type = source["recruit_type"]
    cities = data.get("jobCityList") or ([data["jobCity"]] if data.get("jobCity") else [])
    tags = [t.strip() for t in _clean(data.get("jobKeys")).split(",") if t.strip()]
    updated_ms = data.get("refreshTime") or data.get("updateTime") or 0
    publish_ms = data.get("createTime") or 0
    edu_level = data.get("eduLevel")

    company_name = _company_name(data)
    return {
        "key": f"{recruit_type}:{job_id}",
        "id": job_id,
        "source": source["key"],
        "source_label": source["label"],
        "recruit_type": recruit_type,
        "job_name": _clean(data.get("jobName")) or "-",
        "company_name": company_name,
        "city": "/".join(_clean(c) for c in cities) or "-",
        "salary": _salary_text(data),
        "education": EDU_LEVEL_MAP.get(edu_level, "不限" if not edu_level else "其他"),
        "graduate_year": _clean(data.get("graduationYear")) or "-",
        "tags": tags,
        "requirement": _requirement(data),
        "updated_ms": int(updated_ms or 0),
        "publish_ms": int(publish_ms or 0),
        "detail_url": f"https://www.nowcoder.com/jobs/detail/{job_id}",
        **(_company_fields(data, company_name)),
        "change": "unchanged",
    }


def _iso_now():
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def _append_changelog(version):
    path = BASE_DIR / "CHANGELOG.md"
    sources = version.get("sources") or {}
    parts = [
        "",
        f"## {version['version']} - {version['created_at']}",
        (
            f"- 抓取 {version['job_count']} 条职位"
            f"（校招 {sources.get('school', {}).get('count', 0)}，"
            f"实习 {sources.get('intern', {}).get('count', 0)}，"
            f"社招 {sources.get('fulltime', {}).get('count', 0)}），"
            f"新增 {version['added']}，更新 {version['updated']}，移除 {version['removed']}。"
        ),
    ]
    try:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if version["version"] not in text:
                path.write_text(text.rstrip() + "\n" + "\n".join(parts) + "\n", encoding="utf-8")
        else:
            path.write_text(
                "# 更新记录\n\n牛客招聘雷达每次成功抓取都会在这里追加一条记录。\n"
                + "\n".join(parts) + "\n",
                encoding="utf-8",
            )
    except OSError:
        pass


def _diff_jobs(new_jobs, old_jobs):
    old_map = {job["key"]: job for job in old_jobs}
    new_map = {job["key"]: job for job in new_jobs}
    added_keys = set(new_map) - set(old_map)
    removed_keys = set(old_map) - set(new_map)
    updated_keys = {
        key
        for key in set(new_map) & set(old_map)
        if new_map[key].get("updated_ms") != old_map[key].get("updated_ms")
    }
    for job in new_jobs:
        if job["key"] in added_keys:
            job["change"] = "new"
        elif job["key"] in updated_keys:
            job["change"] = "updated"
    removed = [old_map[key] for key in sorted(removed_keys)]
    return added_keys, removed_keys, updated_keys, removed


def crawl_now():
    with _lock:
        if _status["is_crawling"]:
            return None
        _status["is_crawling"] = True
        _status["last_error"] = None

    try:
        all_jobs = []
        source_status = {}
        for source in SOURCES:
            try:
                state = _parse_state(_fetch_page(source["url"]))
                raw_jobs = _extract_jobs(state, source["key"])
                jobs = [_normalize_job(item, source) for item in raw_jobs]
                all_jobs.extend(jobs)
                source_status[source["key"]] = {"ok": True, "count": len(jobs), "label": source["label"]}
            except Exception as exc:
                source_status[source["key"]] = {"ok": False, "count": 0, "error": str(exc), "label": source["label"]}

        if not all_jobs:
            raise RuntimeError("所有数据源都未返回职位")

        all_jobs.sort(key=lambda job: (job.get("updated_ms") or 0), reverse=True)

        with _lock:
            old_snapshot = _read_json(LATEST_FILE, {})
            old_jobs = old_snapshot.get("jobs", []) if isinstance(old_snapshot, dict) else []
            added_keys, removed_keys, updated_keys, removed = _diff_jobs(all_jobs, old_jobs)

            versions_index = _read_json(VERSIONS_FILE, {"versions": []}) or {"versions": []}
            version_no = len(versions_index.get("versions", [])) + 1
            version_id = f"v{version_no:04d}"
            created_at = _iso_now()

            version = {
                "version": version_id,
                "created_at": created_at,
                "job_count": len(all_jobs),
                "added": len(added_keys),
                "removed": len(removed_keys),
                "updated": len(updated_keys),
                "sources": source_status,
            }
            snapshot = {
                **version,
                "jobs": all_jobs,
                "removed": removed,
            }

            _write_json(VERSIONS_DIR / f"{version_id}.json", snapshot)
            versions_index.setdefault("versions", []).append(version)
            _write_json(VERSIONS_FILE, versions_index)
            _write_json(LATEST_FILE, {"version": version_id, "created_at": created_at, "jobs": all_jobs, "meta": source_status})

            _current.update(
                version=version_id,
                created_at=created_at,
                jobs=all_jobs,
                meta={"sources": source_status},
            )
            _status["is_crawling"] = False
            _status["last_crawled_at"] = created_at
            _status["last_error"] = None
            _status["last_version"] = version_id

        _append_changelog(version)
        return version
    except Exception as exc:
        with _lock:
            _status["is_crawling"] = False
            _status["last_error"] = str(exc)
        raise


def load_state():
    with _lock:
        latest = _read_json(LATEST_FILE, {}) or {}
        versions_index = _read_json(VERSIONS_FILE, {"versions": []}) or {"versions": []}
        _current.update(
            version=latest.get("version"),
            created_at=latest.get("created_at"),
            jobs=latest.get("jobs", []),
            meta={"sources": latest.get("meta", {})},
        )
        _status["last_crawled_at"] = latest.get("created_at")
        _status["last_version"] = latest.get("version")
        return _current, versions_index.get("versions", []), _status


def get_status():
    with _lock:
        return dict(_status)


def set_next_crawl_at(value):
    with _lock:
        _status["next_crawl_at"] = value


def get_current():
    with _lock:
        return {
            "version": _current["version"],
            "created_at": _current["created_at"],
            "jobs": _current["jobs"],
            "meta": _current["meta"],
        }


def get_versions():
    versions_index = _read_json(VERSIONS_FILE, {"versions": []}) or {"versions": []}
    return versions_index.get("versions", [])


def get_version(version_id):
    path = VERSIONS_DIR / f"{version_id}.json"
    return _read_json(path, None)


if __name__ == "__main__":
    result = crawl_now()
    print(json.dumps(result, ensure_ascii=False, indent=2))
