import json
import os
import tempfile
import threading
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SEED_DIR = BASE_DIR / "seed_data"
EPHEMERAL_DIR = Path(tempfile.gettempdir()) / "nowcoder-jobs-board-data"

BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN") or os.environ.get(
    "VERCEL_BLOB_READ_WRITE_TOKEN"
)
IS_VERCEL = bool(os.environ.get("VERCEL"))

_lock = threading.RLock()


def _relative(path):
    return Path(path).resolve().relative_to(BASE_DIR.resolve()).as_posix()


def _read_seed(relative):
    seed_relative = relative[len("data/"):] if relative.startswith("data/") else relative
    seed_file = SEED_DIR / seed_relative
    try:
        return json.loads(seed_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _read_local(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def _write_local(path, payload):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(target)


def _read_blob(path, default):
    from vercel import blob

    try:
        result = blob.get(_relative(path), access="private", use_cache=False)
        return json.loads(result.content.decode("utf-8"))
    except blob.BlobNotFoundError:
        seed = _read_seed(_relative(path))
        return seed if seed is not None else default


def _write_blob(path, payload):
    from vercel import blob

    blob.put(
        _relative(path),
        json.dumps(payload, ensure_ascii=False, indent=2),
        access="private",
        content_type="application/json",
        overwrite=True,
        cache_control_max_age=60,
    )


def read_json(path, default=None):
    with _lock:
        if BLOB_TOKEN:
            return _read_blob(path, default)
        if IS_VERCEL:
            relative = _relative(path)
            ephemeral = EPHEMERAL_DIR / relative
            local = _read_local(ephemeral, None)
            if local is not None:
                return local
            seed = _read_seed(relative)
            return seed if seed is not None else default
        return _read_local(path, default)


def write_json(path, payload):
    with _lock:
        if BLOB_TOKEN:
            _write_blob(path, payload)
            return
        if IS_VERCEL:
            _write_local(EPHEMERAL_DIR / _relative(path), payload)
            return
        _write_local(path, payload)
