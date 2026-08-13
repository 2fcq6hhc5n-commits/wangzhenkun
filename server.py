import json
import os
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import crawler
import tracking


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
REFRESH_INTERVAL_MINUTES = int(os.environ.get("REFRESH_INTERVAL_MINUTES", "10"))


def _json_bytes(payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return (status, {"Content-Type": "application/json; charset=utf-8"}, body)


def _most_common(values):
    counter = Counter(value for value in values if value)
    if not counter:
        return ""
    return counter.most_common(1)[0][0]


def _build_companies():
    current = crawler.get_current()
    jobs = current["jobs"] or []
    applications = tracking.list_applications()
    app_map = {item.get("company_id"): item for item in applications}
    grouped = {}

    for job in jobs:
        company_id = str(job.get("company_id") or f"name:{job.get('company_name', '')}")
        group = grouped.setdefault(
            company_id,
            {
                "company_id": company_id,
                "company_name": job.get("company_name", "-"),
                "company_logo": "",
                "industries": [],
                "scales": [],
                "financings": [],
                "addresses": [],
                "cities": set(),
                "source_labels": set(),
                "updated_ms": 0,
                "jobs": [],
            },
        )
        group["company_logo"] = group["company_logo"] or job.get("company_logo") or ""
        group["industries"].append(job.get("company_industry") or "")
        group["scales"].append(job.get("company_scale") or "")
        group["financings"].append(job.get("company_financing") or "")
        group["addresses"].append(job.get("company_address") or "")
        if job.get("city") and job["city"] != "-":
            group["cities"].update(part for part in job["city"].split("/") if part)
        group["source_labels"].add(job.get("source_label") or "")
        group["updated_ms"] = max(group["updated_ms"], int(job.get("updated_ms") or 0))
        group["jobs"].append(
            {
                "id": job.get("id"),
                "key": job.get("key"),
                "job_name": job.get("job_name"),
                "city": job.get("city"),
                "salary": job.get("salary"),
                "source_label": job.get("source_label"),
                "detail_url": job.get("detail_url"),
            }
        )

    companies = []
    for group in grouped.values():
        application = app_map.get(group["company_id"]) or {
            "company_id": group["company_id"],
            "company_name": group["company_name"],
            "status": "未投递",
            "note": "",
        }
        companies.append(
            {
                "company_id": group["company_id"],
                "company_name": group["company_name"],
                "company_logo": group["company_logo"],
                "industry": _most_common(group["industries"]),
                "scale": _most_common(group["scales"]),
                "financing": _most_common(group["financings"]),
                "address": _most_common(group["addresses"]),
                "cities": sorted(group["cities"]),
                "source_labels": sorted(label for label in group["source_labels"] if label),
                "job_count": len(group["jobs"]),
                "last_updated_ms": group["updated_ms"],
                "jobs": sorted(group["jobs"], key=lambda job: job.get("id") or 0),
                "application": application,
            }
        )
    companies.sort(key=lambda company: (-company["job_count"], company["company_name"]))
    return companies


class Handler(BaseHTTPRequestHandler):
    server_version = "NowcoderJobsBoard/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, status, headers, body):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    def _static(self, path):
        if path in ("/", "/index.html"):
            filename = PUBLIC_DIR / "index.html"
        else:
            filename = (PUBLIC_DIR / path.lstrip("/")).resolve()
            if PUBLIC_DIR.resolve() not in filename.parents:
                self._send(403, {"Content-Type": "text/plain; charset=utf-8"}, b"forbidden")
                return
        if not filename.is_file():
            self._send(404, {"Content-Type": "text/plain; charset=utf-8"}, b"not found")
            return
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }
        content_type = content_types.get(filename.suffix.lower(), "application/octet-stream")
        self._send(200, {"Content-Type": content_type}, filename.read_bytes())

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self._api_get(path)
            return
        self._static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/refresh":
            self._api_refresh()
            return
        if path == "/api/applications":
            self._api_save_application()
            return
        if path == "/api/applications/remove":
            self._api_remove_application()
            return
        self._send(404, {"Content-Type": "application/json; charset=utf-8"}, b'{"ok":false,"error":"not found"}')

    def _api_get(self, path):
        if path == "/api/status":
            status = crawler.get_status()
            self._send(*_json_bytes({"ok": True, "status": status, "statuses": tracking.STATUSES}))
            return
        if path == "/api/jobs":
            current = crawler.get_current()
            self._send(*_json_bytes({"ok": True, **current}))
            return
        if path == "/api/companies":
            self._send(*_json_bytes({"ok": True, "companies": _build_companies()}))
            return
        if path == "/api/applications":
            self._send(*_json_bytes({"ok": True, "applications": tracking.list_applications()}))
            return
        if path == "/api/versions":
            versions = crawler.get_versions()
            self._send(*_json_bytes({"ok": True, "versions": versions}))
            return
        if path.startswith("/api/versions/"):
            version_id = unquote(path.rsplit("/", 1)[-1])
            snapshot = crawler.get_version(version_id)
            if snapshot is None:
                self._send(*_json_bytes({"ok": False, "error": "version not found"}, status=404))
                return
            self._send(*_json_bytes({"ok": True, "snapshot": snapshot}))
            return
        self._send(*_json_bytes({"ok": False, "error": "not found"}, status=404))

    def _api_refresh(self):
        status = crawler.get_status()
        if status.get("is_crawling"):
            self._send(*_json_bytes({"ok": False, "error": "正在抓取中"}, status=409))
            return
        try:
            version = crawler.crawl_now()
            self._send(*_json_bytes({"ok": True, "version": version}))
        except Exception as exc:
            self._send(*_json_bytes({"ok": False, "error": str(exc)}, status=500))

    def _api_save_application(self):
        payload = self._read_json_body()
        try:
            item = tracking.save_application(payload)
            self._send(*_json_bytes({"ok": True, "application": item}))
        except ValueError as exc:
            self._send(*_json_bytes({"ok": False, "error": str(exc)}, status=400))
        except Exception as exc:
            self._send(*_json_bytes({"ok": False, "error": str(exc)}, status=500))

    def _api_remove_application(self):
        payload = self._read_json_body()
        company_id = payload.get("company_id")
        removed = tracking.remove_application(company_id)
        self._send(*_json_bytes({"ok": True, "removed": removed}))


def scheduler(interval_minutes):
    while True:
        try:
            crawler.crawl_now()
        except Exception as exc:
            print("scheduled crawl failed:", exc, flush=True)
        next_time = datetime.now() + timedelta(minutes=interval_minutes)
        next_at = next_time.astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
        crawler.set_next_crawl_at(next_at)
        print(f"next crawl at {next_at}", flush=True)
        time.sleep(interval_minutes * 60)


def main():
    port = int(os.environ.get("PORT", "8765"))
    crawler.load_state()

    thread = threading.Thread(target=scheduler, args=(REFRESH_INTERVAL_MINUTES,), daemon=True)
    thread.start()

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Nowcoder Jobs Board: http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
