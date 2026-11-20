"""Shared helpers: project paths, JSON IO, ffprobe, ffmpeg runner with progress."""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

CLIPPER_DIR = Path(__file__).resolve().parent
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}

_project_root = CLIPPER_DIR.parent


def set_project(root):
    global _project_root
    _project_root = Path(root).resolve()


def project_root() -> Path:
    return _project_root


def P(*parts) -> Path:
    """Path inside the project root."""
    return _project_root.joinpath(*parts)


def rel(path) -> str:
    """Project-relative path with forward slashes (falls back to absolute)."""
    path = Path(path).resolve()
    try:
        return path.relative_to(_project_root).as_posix()
    except ValueError:
        return path.as_posix()


def resolve(path_str) -> Path:
    p = Path(path_str)
    return p if p.is_absolute() else (_project_root / p)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def slugify(text, fallback="clip"):
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:48].strip("-") or fallback


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

# Branding elements a campaign can ask for. Overlays sit on top of the clip; bumpers are separate
# videos (or still images) glued before / after it, untouched apart from fitting the frame.
BRANDING_KEYS = ("watermark", "banner", "bumper_in", "bumper_out")

DEFAULT_CAMPAIGN = {
    "name": "Campaign baru",
    "hashtags": [],
    "watermark": {"enabled": False, "required": False, "path": "", "x": 0.5, "y": 0.5, "w": 1.0, "opacity": 1.0},
    "banner": {"enabled": False, "required": False, "path": "", "x": 0.5, "y": 0.12, "w": 0.9, "opacity": 1.0,
               "start": 0.0, "duration": 0.0, "anim": "fade"},
    "bumper_in": {"enabled": False, "required": False, "path": "", "image_duration": 2.0},
    "bumper_out": {"enabled": False, "required": False, "path": "", "image_duration": 3.0},
    "output": {"width": 1080, "height": 1920, "fps": 30},
    "keywords": [],
    "whisper_prompt": "",
    "language": "id",
    "allowed_channels": [],
    "min_upload_date": "",
    "checklist": [],
}


def migrate_campaign(data):
    """Older campaign.json files had `outro` and a watermark without enabled/required flags."""
    data = dict(data or {})
    if "outro" in data and "bumper_out" not in data:
        o = data.pop("outro") or {}
        data["bumper_out"] = {"enabled": bool(o.get("path")), "required": bool(o.get("required", True)),
                              "path": o.get("path", "")}
    data.pop("outro", None)
    wm = data.get("watermark")
    if isinstance(wm, dict) and "enabled" not in wm:
        wm = dict(wm)
        wm.setdefault("enabled", bool(wm.get("path")))
        wm.setdefault("required", bool(wm.get("path")))
        data["watermark"] = wm
    return data


def load_campaign():
    data = migrate_campaign(read_json(P("campaign.json"), {}) or {})
    merged = json.loads(json.dumps(DEFAULT_CAMPAIGN))
    for k, v in data.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k].update(v)
        else:
            merged[k] = v
    return merged


def has_campaign():
    return P("campaign.json").is_file()


def media_kind(path):
    ext = Path(str(path)).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    return "other"


def branding_for(clip, campaign, key):
    """Campaign element merged with the clip's own setting. Returns dict with enabled/exists/path/kind."""
    el = dict(campaign.get(key) or {})
    own = (clip or {}).get(key)
    if key == "bumper_out" and own is None and clip is not None and "outro" in clip:
        own = clip.get("outro")  # clips made before bumpers existed
    if isinstance(own, bool):
        el["enabled"] = own
    elif isinstance(own, dict):
        el.update({k: v for k, v in own.items() if k != "path" or v})
    path = el.get("path") or ""
    p = resolve(path) if path else None
    el["exists"] = bool(p and p.is_file())
    el["abs"] = str(p) if p else ""
    el["kind"] = media_kind(path) if path else ""
    return el


# ---------------------------------------------------------------- ffprobe

def ffprobe(path):
    """Return display-oriented metadata for a media file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe gagal: {out.stderr.strip()[:300]}")
    data = json.loads(out.stdout)
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    info = {
        "duration": float(data.get("format", {}).get("duration") or 0),
        "has_audio": a is not None,
        "has_video": v is not None,
    }
    if v:
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(float(sd["rotation"]))
        if "rotate" in (v.get("tags") or {}):
            rot = int(v["tags"]["rotate"])
        if abs(rot) % 180 == 90:
            w, h = h, w
        fps = 30.0
        rate = v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1"
        try:
            n, d = rate.split("/")
            fps = float(n) / float(d) if float(d) else 30.0
        except Exception:
            pass
        info.update({"width": w, "height": h, "rotation": rot, "fps": round(fps, 3), "vcodec": v.get("codec_name")})
        if not info["duration"]:
            info["duration"] = float(v.get("duration") or 0)
    return info


# ---------------------------------------------------------------- encoders

_encoder_cache = {}


def has_nvenc():
    if "nvenc" not in _encoder_cache:
        try:
            r = subprocess.run(
                ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2",
                 "-c:v", "h264_nvenc", "-f", "null", "-"],
                capture_output=True, timeout=30,
            )
            _encoder_cache["nvenc"] = r.returncode == 0
        except Exception:
            _encoder_cache["nvenc"] = False
    return _encoder_cache["nvenc"]


def has_cuda_decode():
    """GPU decode via -hwaccel cuda; assumed available when NVENC works (same driver)."""
    if os.environ.get("CLIPPER_NO_HWDEC"):
        return False
    return has_nvenc()


def video_encoder_args(quality="final"):
    if has_nvenc():
        if quality == "draft":
            return ["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", "28", "-b:v", "0"]
        if quality == "proxy":
            return ["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "27", "-b:v", "0", "-g", "15", "-bf", "0"]
        return ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0",
                "-maxrate", "25M", "-bufsize", "50M", "-profile:v", "high"]
    if quality == "draft":
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]
    if quality == "proxy":
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-bf", "0"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high"]


# ---------------------------------------------------------------- process runner

class Cancelled(Exception):
    pass


def run_ffmpeg(args, duration=None, on_progress=None, cancel_event=None, cwd=None, log=None):
    """Run ffmpeg with -progress parsing. args excludes the leading 'ffmpeg'."""
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"] + list(args)
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
        text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    err_lines = []

    def _drain_err():
        for line in proc.stderr:
            err_lines.append(line.rstrip())
            if len(err_lines) > 200:
                del err_lines[:100]

    t = threading.Thread(target=_drain_err, daemon=True)
    t.start()
    try:
        for line in proc.stdout:
            if cancel_event is not None and cancel_event.is_set():
                proc.kill()
                raise Cancelled()
            line = line.strip()
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if duration and on_progress:
                    on_progress(min(1.0, max(0.0, us / 1e6 / duration)))
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    t.join(timeout=2)
    if cancel_event is not None and cancel_event.is_set():
        raise Cancelled()
    if proc.returncode != 0:
        tail = "\n".join(err_lines[-15:])
        if log:
            log(tail)
        raise RuntimeError(f"ffmpeg gagal (exit {proc.returncode}):\n{tail}")
    return True


def which(name):
    return shutil.which(name)


def fmt_time(sec):
    sec = max(0.0, float(sec))
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h}:{m:02d}:{s:05.2f}" if h else f"{m}:{s:05.2f}"


def now_ts():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def python_exe():
    return sys.executable
