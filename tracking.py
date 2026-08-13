import json
import threading
from datetime import datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
APPLICATIONS_FILE = DATA_DIR / "applications.json"

STATUSES = ["未投递", "已投递", "笔试中", "面试中", "已拿Offer", "暂不投递"]

_lock = threading.RLock()


def _read_applications():
    try:
        data = json.loads(APPLICATIONS_FILE.read_text(encoding="utf-8"))
        return data.get("applications", [])
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _write_applications(applications):
    APPLICATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = APPLICATIONS_FILE.with_suffix(".tmp")
    tmp.write_text(
        json.dumps({"applications": applications}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(APPLICATIONS_FILE)


def list_applications():
    with _lock:
        return _read_applications()


def get_application(company_id):
    with _lock:
        for item in _read_applications():
            if item.get("company_id") == str(company_id):
                return item
    return None


def save_application(payload):
    company_id = str(payload.get("company_id") or "").strip()
    company_name = (payload.get("company_name") or "").strip()
    status = (payload.get("status") or "未投递").strip()
    note = (payload.get("note") or "").strip()
    if not company_id or not company_name:
        raise ValueError("company_id 和 company_name 不能为空")
    if status not in STATUSES:
        raise ValueError(f"不支持的投递状态: {status}")
    updated_at = datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")

    with _lock:
        applications = _read_applications()
        item = next((a for a in applications if a.get("company_id") == company_id), None)
        if item:
            item["company_name"] = company_name
            item["status"] = status
            item["note"] = note
            item["updated_at"] = updated_at
        else:
            item = {
                "company_id": company_id,
                "company_name": company_name,
                "status": status,
                "note": note,
                "created_at": updated_at,
                "updated_at": updated_at,
            }
            applications.append(item)
        _write_applications(applications)
        return item


def remove_application(company_id):
    company_id = str(company_id or "").strip()
    with _lock:
        applications = _read_applications()
        remaining = [a for a in applications if a.get("company_id") != company_id]
        _write_applications(remaining)
        return len(applications) != len(remaining)
