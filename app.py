import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import crawler
import server as local_board
import tracking


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"


class ApplicationPayload(BaseModel):
    company_id: str = ""
    company_name: str = ""
    status: str = "未投递"
    note: str = ""


class RemovePayload(BaseModel):
    company_id: str = ""


@asynccontextmanager
async def lifespan(_app: FastAPI):
    crawler.load_state()
    yield


app = FastAPI(
    title="牛客招聘雷达",
    description="实时抓取牛客网招聘信息，整理职位、企业和投递进度。",
    version="2.0.0",
    lifespan=lifespan,
)


@app.get("/api/status")
def api_status():
    return {
        "ok": True,
        "status": crawler.get_status(),
        "statuses": tracking.STATUSES,
    }


@app.get("/api/jobs")
def api_jobs():
    current = crawler.get_current()
    return {"ok": True, **current}


@app.get("/api/companies")
def api_companies():
    return {"ok": True, "companies": local_board._build_companies()}


@app.get("/api/applications")
def api_applications():
    return {"ok": True, "applications": tracking.list_applications()}


@app.get("/api/versions")
def api_versions():
    return {"ok": True, "versions": crawler.get_versions()}


@app.get("/api/versions/{version_id}")
def api_version(version_id: str):
    snapshot = crawler.get_version(version_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="version not found")
    return {"ok": True, "snapshot": snapshot}


@app.post("/api/refresh")
def api_refresh():
    status = crawler.get_status()
    if status.get("is_crawling"):
        return JSONResponse(status_code=409, content={"ok": False, "error": "正在抓取中"})
    try:
        version = crawler.crawl_now()
        return {"ok": True, "version": version}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "error": str(exc)})


@app.get("/api/cron/refresh")
def api_cron_refresh(request: Request):
    secret = os.environ.get("CRON_SECRET")
    if secret and request.headers.get("authorization") != f"Bearer {secret}":
        raise HTTPException(status_code=403, detail="invalid cron secret")
    return api_refresh()


@app.post("/api/applications")
def api_save_application(payload: ApplicationPayload):
    try:
        item = tracking.save_application(payload.model_dump())
        return {"ok": True, "application": item}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/applications/remove")
def api_remove_application(payload: RemovePayload):
    removed = tracking.remove_application(payload.company_id)
    return {"ok": True, "removed": removed}


def _static_file(path: str):
    if path in ("", "index.html"):
        target = PUBLIC_DIR / "index.html"
    else:
        target = (PUBLIC_DIR / path).resolve()
    root = PUBLIC_DIR.resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=403, detail="forbidden")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(target)


@app.get("/", include_in_schema=False)
def index():
    return _static_file("")


@app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def static_files(path: str):
    return _static_file(path)
