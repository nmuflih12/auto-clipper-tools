"""Clipper: local web GUI for cutting vertical clips for clipping campaigns.

Run:  python clipper/app.py [--project <folder>] [--port 5170] [--no-browser]
Then open http://127.0.0.1:5170
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from flask import Flask, jsonify, request, send_file, abort

import numpy as np

from common import (CLIPPER_DIR, VIDEO_EXTS, IMAGE_EXTS, BRANDING_KEYS, DEFAULT_CAMPAIGN, P, rel, resolve,
                    read_json, write_json, slugify, load_campaign, migrate_campaign, has_campaign, media_kind,
                    ffprobe, has_nvenc, Cancelled, python_exe, project_root, set_project)
import analyze
import captions
import render
import youtube

app = Flask(__name__, static_folder=str(CLIPPER_DIR / "static"), static_url_path="/static")

# ---------------------------------------------------------------- jobs

JOBS = {}
JOB_LOCK = threading.Lock()
# heavy ffmpeg/whisper work runs one at a time so the laptop stays usable
HEAVY = threading.Semaphore(1)


def new_job(kind, title, target=None):
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "title": title, "target": target, "status": "queued",
           "progress": 0.0, "message": "", "error": None, "result": None,
           "created": time.time(), "cancel": threading.Event()}
    with JOB_LOCK:
        JOBS[jid] = job
        # keep the list short
        if len(JOBS) > 60:
            for k in sorted(JOBS, key=lambda k: JOBS[k]["created"])[:20]:
                if JOBS[k]["status"] in ("done", "error", "cancelled"):
                    JOBS.pop(k, None)
    return job


def run_job(job, fn, heavy=True):
    def target():
        try:
            if heavy:
                job["message"] = "menunggu antrian…"
                HEAVY.acquire()
            try:
                if job["cancel"].is_set():
                    raise Cancelled()
                job["status"] = "running"
                job["message"] = ""
                job["result"] = fn(job)
                job["status"] = "done"
                job["progress"] = 1.0
            finally:
                if heavy:
                    HEAVY.release()
        except Cancelled:
            job["status"] = "cancelled"
            job["message"] = "dibatalkan"
        except Exception as e:  # surface to the UI
            traceback.print_exc()
            job["status"] = "error"
            job["error"] = str(e)[-1500:]
    threading.Thread(target=target, daemon=True).start()
    return job


def job_public(job):
    return {k: v for k, v in job.items() if k != "cancel"}


# ---------------------------------------------------------------- sources

def source_dir(sid):
    return P("work", sid)


def load_source(sid):
    return read_json(source_dir(sid) / "source.json", None)


def save_source(meta):
    write_json(source_dir(meta["id"]) / "source.json", meta)


def scan_sources():
    """Register every video in raw/ and downloads/ (idempotent)."""
    known = {}
    work = P("work")
    if work.is_dir():
        for d in work.iterdir():
            m = read_json(d / "source.json", None)
            if m:
                known[m["path"]] = m
    for folder in ("raw", "downloads"):
        base = P(folder)
        if not base.is_dir():
            continue
        for f in sorted(base.rglob("*")):
            if f.suffix.lower() not in VIDEO_EXTS or not f.is_file():
                continue
            if re.search(r"\.f\d+$|\.temp$|\.part", f.stem):  # yt-dlp partial files
                continue
            rp = rel(f)
            if rp in known:
                continue
            sid = slugify(f.stem, "video")
            n = 2
            while source_dir(sid).exists() and (load_source(sid) or {}).get("path") != rp:
                sid = f"{slugify(f.stem, 'video')}-{n}"
                n += 1
            meta = {"id": sid, "path": rp, "kind": "youtube" if folder == "downloads" else "local",
                    "title": f.name, "prepared": False, "transcribed": False,
                    "added": datetime.datetime.now().isoformat(timespec="seconds")}
            yt = read_json(f.with_suffix(".yt.json"), None)
            if yt:
                meta["youtube"] = yt
                meta["title"] = yt.get("title") or f.name
            save_source(meta)
            known[rp] = meta
    out = []
    for m in known.values():
        if resolve(m["path"]).exists():
            out.append(m)
    out.sort(key=lambda m: (m.get("kind") != "local", m.get("title", "")))
    return out


def source_summary(m):
    keys = ("id", "path", "kind", "title", "duration", "width", "height", "fps", "prepared", "transcribed",
            "youtube_url", "added")
    s = {k: m.get(k) for k in keys}
    s["has_youtube"] = bool(m.get("youtube"))
    s["youtube_url"] = (m.get("youtube") or {}).get("url")
    s["clips"] = len([c for c in list_clips() if c.get("source_id") == m["id"]])
    return s


def prepare_source(job, sid):
    m = load_source(sid)
    src = resolve(m["path"])
    d = source_dir(sid)
    job["message"] = "membaca info video"
    info = ffprobe(src)
    m.update(info)
    job["message"] = "deteksi bar hitam"
    content = analyze.detect_content_rect(src, info)
    camp = load_campaign()
    ow, oh = camp["output"]["width"], camp["output"]["height"]
    if not m.get("layout_default"):
        m["layout_default"] = analyze.default_layout(info, content, ow, oh)
    m["content"] = content
    job["message"] = "analisis suara"
    env = analyze.loudness_envelope(src, on_progress=lambda p: job.update(progress=0.05 + 0.15 * p),
                                    duration=info["duration"])
    np.save(d / "envelope.npy", env)
    job["message"] = "membuat proxy preview"
    analyze.make_proxy(src, d / "proxy.mp4", info["duration"],
                       on_progress=lambda p: job.update(progress=0.2 + 0.78 * p), cancel_event=job["cancel"])
    m["prepared"] = True
    save_source(m)
    compute_candidates(sid)
    return {"source": sid}


def compute_candidates(sid, params=None):
    m = load_source(sid)
    d = source_dir(sid)
    if not (d / "envelope.npy").exists():
        return []
    env = np.load(d / "envelope.npy")
    transcript = read_json(d / "transcript.json", None)
    yt = m.get("youtube") or {}
    camp = load_campaign()
    params = params or m.get("candidate_params") or {}
    cands = analyze.find_candidates(
        env, m.get("duration") or len(env) * analyze.HOP, transcript=transcript,
        heatmap=yt.get("heatmap"), heatmap_offset=float(yt.get("offset", 0) or 0),
        keywords=camp.get("keywords"), top_k=int(params.get("top_k", 12)),
        pre=float(params.get("pre", 12)), post=float(params.get("post", 8)),
    )
    write_json(d / "candidates.json", cands)
    return cands


def transcribe_source(job, sid, model="auto"):
    m = load_source(sid)
    d = source_dir(sid)
    media = d / "proxy.mp4" if (d / "proxy.mp4").exists() else resolve(m["path"])
    run_whisper(job, media, d / "transcript.json", model)
    m = load_source(sid)
    m["transcribed"] = True
    save_source(m)
    compute_candidates(sid)
    return {"source": sid}


def run_whisper(job, media, out, model="auto", progress_from=0.0, progress_to=1.0):
    """Run transcribe.py in its own process, forwarding progress into the job."""
    camp = load_campaign()
    cmd = [python_exe(), str(CLIPPER_DIR / "transcribe.py"), str(media), str(out), "--model", model,
           "--lang", camp.get("language", "id"), "--prompt", camp.get("whisper_prompt", "")]
    job["message"] = "memuat model whisper (pertama kali: download model)"
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    err = []
    threading.Thread(target=lambda: err.extend(proc.stderr.readlines()), daemon=True).start()
    for line in proc.stdout:
        if job["cancel"].is_set():
            proc.kill()
            raise Cancelled()
        line = line.strip()
        if line.startswith("PROGRESS"):
            job["progress"] = progress_from + (progress_to - progress_from) * float(line.split()[1])
        elif line.startswith("DEVICE"):
            job["message"] = "transkripsi pakai " + line[7:]
        elif line.startswith("WARN"):
            job["message"] = line[5:]
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("Transkripsi gagal:\n" + "".join(err[-12:]))


# ---------------------------------------------------------------- clips

def clip_path(cid):
    return P("clips", f"{cid}.json")


def list_clips():
    d = P("clips")
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.json")):
        c = read_json(f, None)
        if c and c.get("id"):
            out.append(c)
    out.sort(key=lambda c: c.get("updated", ""), reverse=True)
    return out


def clip_summary(c):
    segs, dur = captions.build_segments(c)
    return {"id": c["id"], "title": c.get("title", c["id"]), "source_id": c.get("source_id"),
            "duration": dur, "segments": len(segs), "updated": c.get("updated"),
            "exported": c.get("exported")}


def text_defaults(layout):
    """Hook/caption heights that keep text off the facecam (split) or off the video (fit)."""
    mode = (layout or {}).get("mode", "split")
    if mode == "split":
        r = float(layout.get("split_ratio", 0.4))
        return {"hook": round(r if layout.get("cam_top", True) else 1 - r, 3), "captions": round(0.63 if layout.get("cam_top", True) else 0.3, 3)}
    if mode == "fit":
        return {"hook": 0.2, "captions": 0.62}
    return {"hook": 0.12, "captions": 0.63}


def new_clip(source_meta, segments=None, title=None):
    camp = load_campaign()
    base = slugify(title or f"{source_meta['id']}-klip")
    cid, n = base, 2
    while clip_path(cid).exists():
        cid = f"{base}-{n}"
        n += 1
    layout = json.loads(json.dumps(source_meta.get("layout_default") or {}))
    if not layout:
        info = {"width": source_meta.get("width", 1920), "height": source_meta.get("height", 1080)}
        layout = analyze.default_layout(info, {"x": 0, "y": 0, "w": 1, "h": 1})
    clip = {
        "id": cid, "title": title or cid, "source": source_meta["path"], "source_id": source_meta["id"],
        "segments": segments or [],
        "layout": layout,
        "hook": {"text": "", "style": "box-white", "y": text_defaults(layout)["hook"], "duration": 0},
        "captions": {"enabled": True, "style": "pop", "y": text_defaults(layout)["captions"], "words_per_chunk": 3,
                     "uppercase": True, "overrides": {}},
        "overlays": [],
        "watermark": {},
        "loudnorm": True,
        "voice_volume": 1.0,
        "music": None,
        "sfx": [],
        "fps": camp["output"].get("fps", 30),
        "post_caption": "",
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "updated": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    write_json(clip_path(cid), clip)
    return clip


def timeline_for(clip):
    sid = clip.get("source_id")
    transcript = read_json(source_dir(sid) / "transcript.json", None) if sid else None
    return captions.build_timeline(clip, transcript)


# ---------------------------------------------------------------- assets / exports

_media_dur_cache = {}


def media_duration(p):
    p = Path(p)
    key = (str(p), p.stat().st_mtime)
    if key not in _media_dur_cache:
        try:
            _media_dur_cache[key] = round(ffprobe(p)["duration"], 2)
        except Exception:
            _media_dur_cache[key] = None
    return _media_dur_cache[key]


def asset_status():
    """Campaign-level state of each branding element (watermark, banner, bumper in/out)."""
    camp = load_campaign()
    out = {}
    for key in BRANDING_KEYS:
        el = camp.get(key) or {}
        path = el.get("path") or ""
        p = resolve(path) if path else None
        exists = bool(p and p.is_file())
        kind = media_kind(path) if path else ""
        info = {"enabled": bool(el.get("enabled")), "required": bool(el.get("required")), "path": path,
                "exists": exists, "kind": kind, "duration": None}
        if exists and kind == "video":
            info["duration"] = media_duration(p)
        elif exists and kind == "image" and key.startswith("bumper"):
            info["duration"] = float(el.get("image_duration", 2.0))
        out[key] = info
    return out


def list_brand_assets():
    """Images and videos in assets/ (outside music/ and sfx/) that can be used for branding."""
    d = P("assets")
    items = []
    if d.is_dir():
        for f in sorted(d.rglob("*"), key=lambda f: f.name.lower()):
            if not f.is_file() or f.parent.name in ("music", "sfx"):
                continue
            kind = media_kind(f)
            if kind in ("image", "video"):
                items.append({"path": rel(f), "name": f.name, "kind": kind})
    return items


AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
_audio_dur_cache = {}


def audio_library():
    """Backsound files in assets/music and sound effects in assets/sfx (user files + built-in)."""
    out = {}
    for kind in ("music", "sfx"):
        d = P("assets", kind)
        items = []
        if d.is_dir():
            for f in sorted(d.rglob("*"), key=lambda f: f.name.lower()):
                if f.suffix.lower() not in AUDIO_EXTS or not f.is_file():
                    continue
                key = (str(f), f.stat().st_mtime)
                if key not in _audio_dur_cache:
                    try:
                        _audio_dur_cache[key] = round(ffprobe(f)["duration"], 2)
                    except Exception:
                        _audio_dur_cache[key] = None
                items.append({"path": rel(f), "name": f.stem, "duration": _audio_dur_cache[key]})
        out[kind] = items
    return out


def list_exports():
    d = P("exports")
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True):
        txt = f.with_suffix(".txt")
        out.append({"name": f.name, "path": rel(f), "size": f.stat().st_size,
                    "mtime": datetime.datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds"),
                    "caption": txt.read_text(encoding="utf-8") if txt.exists() else ""})
    return out


# ---------------------------------------------------------------- routes

@app.route("/")
def index():
    return send_file(CLIPPER_DIR / "static" / "index.html")


@app.get("/api/state")
def api_state():
    camp = load_campaign()
    ready = has_campaign()
    return jsonify({
        "project": {"root": str(project_root()), "name": project_root().name, "has_campaign": ready},
        "projects": known_projects(),
        "campaign": camp,
        "assets": asset_status(),
        "brand_assets": list_brand_assets() if ready else [],
        "sources": [source_summary(m) for m in scan_sources()] if ready else [],
        "clips": [clip_summary(c) for c in list_clips()] if ready else [],
        "exports": list_exports() if ready else [],
        "tools": {"nvenc": has_nvenc()},
        "styles": {"captions": captions.CAPTION_STYLES, "hooks": captions.HOOK_STYLES,
                   "overlays": captions.OVERLAY_STYLES},
        "audio": audio_library() if ready else {"music": [], "sfx": []},
    })


# ---------------------------------------------------------------- campaign settings + workspaces

LOCAL_FILE = CLIPPER_DIR / "local.json"  # per-computer settings (not in git): known campaign folders
WORKSPACE_DIRS = ("raw", "downloads", "clips", "exports", "assets", "assets/music", "assets/sfx", "work")


def local_settings():
    return read_json(LOCAL_FILE, {}) or {}


def remember_project(path):
    s = local_settings()
    path = str(Path(path).resolve())
    projects = [p for p in s.get("projects", []) if Path(p).resolve() != Path(path)]
    s["projects"] = [path] + projects
    s["last"] = path
    write_json(LOCAL_FILE, s)


def known_projects():
    """Campaign folders this computer has used, plus sibling folders of the current one with a campaign.json."""
    seen, out = set(), []
    cands = list(local_settings().get("projects", []))
    parent = project_root().parent
    if parent.is_dir():
        cands += [str(d) for d in sorted(parent.iterdir()) if (d / "campaign.json").is_file()]
    cands.append(str(project_root()))
    for c in cands:
        p = Path(c).resolve()
        if str(p).lower() in seen or not (p / "campaign.json").is_file():
            continue
        seen.add(str(p).lower())
        name = (read_json(p / "campaign.json", {}) or {}).get("name") or p.name
        out.append({"path": str(p), "folder": p.name, "name": name, "current": p == project_root()})
    return out


def open_workspace(path):
    set_project(path)
    for d in WORKSPACE_DIRS:
        P(d).mkdir(parents=True, exist_ok=True)
    make_builtin_audio()
    remember_project(path)


def make_builtin_audio():
    """Built-in SFX and sample beats for a workspace that has none yet."""
    if any(P("assets", "sfx").glob("*")):
        return
    subprocess.run([python_exe(), str(CLIPPER_DIR / "make_sfx.py"), "--out", str(P("assets"))],
                   capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def busy():
    return any(j["status"] in ("queued", "running") for j in JOBS.values())


@app.get("/api/campaign")
def api_campaign_get():
    return jsonify({"campaign": load_campaign(), "assets": asset_status(), "brand_assets": list_brand_assets()})


@app.put("/api/campaign")
def api_campaign_put():
    body = request.get_json(silent=True) or {}
    current = migrate_campaign(read_json(P("campaign.json"), {}) or {})
    # keep keys the GUI does not edit (payout, links, notes...)
    for k, v in body.items():
        if k in BRANDING_KEYS or k == "output":
            merged = dict(current.get(k) or {})
            merged.update(v or {})
            current[k] = merged
        else:
            current[k] = v
    write_json(P("campaign.json"), current)
    return jsonify({"campaign": load_campaign(), "assets": asset_status()})


@app.post("/api/assets/upload")
def api_asset_upload():
    """Save a file chosen in the browser into assets/ (music/ and sfx/ for audio)."""
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "Tidak ada file"}), 400
    name = Path(f.filename).name
    stem = re.sub(r"[^\w\- .]+", "", Path(name).stem).strip() or "file"
    ext = Path(name).suffix.lower()
    kind = request.form.get("kind", "")
    if ext in IMAGE_EXTS or ext in VIDEO_EXTS:
        folder = P("assets")
    elif ext in AUDIO_EXTS:
        folder = P("assets", "sfx" if kind == "sfx" else "music")
    else:
        return jsonify({"error": f"Tipe file {ext or '(tanpa ekstensi)'} tidak didukung"}), 400
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{stem}{ext}"
    n = 2
    while target.exists():
        target = folder / f"{stem}-{n}{ext}"
        n += 1
    f.save(target)
    return jsonify({"path": rel(target), "kind": media_kind(target), "name": target.name})


@app.get("/api/projects")
def api_projects():
    return jsonify({"current": str(project_root()), "projects": known_projects()})


@app.post("/api/projects/switch")
def api_project_switch():
    path = Path((request.get_json(silent=True) or {}).get("path", ""))
    if not (path / "campaign.json").is_file():
        return jsonify({"error": "Folder itu tidak punya campaign.json"}), 400
    if busy():
        return jsonify({"error": "Masih ada proses berjalan. Tunggu selesai atau batalkan dulu."}), 409
    open_workspace(path)
    return jsonify({"ok": True, "root": str(project_root())})


@app.post("/api/projects/new")
def api_project_new():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Isi nama campaign"}), 400
    if busy():
        return jsonify({"error": "Masih ada proses berjalan. Tunggu selesai atau batalkan dulu."}), 409
    parent = Path(body.get("parent") or (project_root().parent if has_campaign() else project_root()))
    if not parent.is_dir():
        return jsonify({"error": f"Folder induk tidak ada: {parent}"}), 400
    folder = parent / slugify(name, "campaign")
    if (folder / "campaign.json").exists():
        return jsonify({"error": f"Campaign di {folder} sudah ada"}), 409
    folder.mkdir(parents=True, exist_ok=True)
    template = read_json(CLIPPER_DIR / "campaign.example.json", None) or json.loads(json.dumps(DEFAULT_CAMPAIGN))
    template["name"] = name
    write_json(folder / "campaign.json", template)
    open_workspace(folder)
    return jsonify({"ok": True, "root": str(project_root())})


@app.get("/api/audio")
def api_audio():
    for kind in ("music", "sfx"):
        P("assets", kind).mkdir(parents=True, exist_ok=True)
    return jsonify(audio_library())


@app.get("/api/sources/<sid>")
def api_source(sid):
    m = load_source(sid)
    if not m:
        abort(404)
    d = source_dir(sid)
    data = dict(m)
    if (d / "envelope.npy").exists():
        hop, vals = analyze.envelope_for_ui(np.load(d / "envelope.npy"))
        data["envelope"] = {"hop": hop, "db": vals}
    data["candidates"] = read_json(d / "candidates.json", [])
    tr = read_json(d / "transcript.json", None)
    if tr:
        data["transcript_segments"] = [{"start": s["start"], "end": s["end"], "text": s["text"]}
                                       for s in tr.get("segments", [])]
        data["transcript_model"] = tr.get("model")
    data["clips"] = [clip_summary(c) for c in list_clips() if c.get("source_id") == sid]
    data["proxy_url"] = f"/media/proxy/{sid}" if (d / "proxy.mp4").exists() else None
    return jsonify(data)


@app.post("/api/sources/<sid>/prepare")
def api_prepare(sid):
    m = load_source(sid)
    if not m:
        abort(404)
    job = new_job("prepare", f"Siapkan {m['title']}", sid)
    run_job(job, lambda j: prepare_source(j, sid))
    return jsonify(job_public(job))


@app.post("/api/sources/<sid>/transcribe")
def api_transcribe(sid):
    m = load_source(sid)
    if not m:
        abort(404)
    model = (request.get_json(silent=True) or {}).get("model", "auto")
    job = new_job("transcribe", f"Transkrip {m['title']}", sid)
    run_job(job, lambda j: transcribe_source(j, sid, model))
    return jsonify(job_public(job))


@app.post("/api/sources/<sid>/candidates")
def api_candidates(sid):
    m = load_source(sid)
    if not m:
        abort(404)
    params = request.get_json(silent=True) or {}
    m["candidate_params"] = params
    save_source(m)
    return jsonify(compute_candidates(sid, params))


@app.patch("/api/sources/<sid>")
def api_source_patch(sid):
    m = load_source(sid)
    if not m:
        abort(404)
    body = request.get_json(silent=True) or {}
    if "layout_default" in body:
        m["layout_default"] = body["layout_default"]
    save_source(m)
    return jsonify({"ok": True})


@app.get("/media/proxy/<sid>")
def media_proxy(sid):
    f = source_dir(sid) / "proxy.mp4"
    if not f.exists():
        abort(404)
    return send_file(f, mimetype="video/mp4", conditional=True)


@app.get("/media/file")
def media_file():
    """Serve a file inside the project (exports, drafts, assets)."""
    p = resolve(request.args.get("path", ""))
    try:
        p.resolve().relative_to(project_root())
    except ValueError:
        abort(403)
    if not p.is_file():
        abort(404)
    return send_file(p, conditional=True)


@app.get("/api/clips/<cid>")
def api_clip(cid):
    c = read_json(clip_path(cid), None)
    if not c:
        abort(404)
    return jsonify({"clip": c, "timeline": timeline_for(c)})


@app.post("/api/clips")
def api_clip_new():
    body = request.get_json(silent=True) or {}
    m = load_source(body.get("source_id", ""))
    if not m:
        abort(400)
    c = new_clip(m, body.get("segments"), body.get("title"))
    return jsonify({"clip": c, "timeline": timeline_for(c)})


@app.put("/api/clips/<cid>")
def api_clip_save(cid):
    body = request.get_json(silent=True) or {}
    if not clip_path(cid).exists():
        abort(404)
    body["id"] = cid
    body["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
    write_json(clip_path(cid), body)
    return jsonify({"clip": body, "timeline": timeline_for(body)})


@app.post("/api/clips/<cid>/duplicate")
def api_clip_dup(cid):
    c = read_json(clip_path(cid), None)
    if not c:
        abort(404)
    m = load_source(c["source_id"])
    nc = new_clip(m, c.get("segments"), (c.get("title") or cid) + " copy")
    keep = {k: v for k, v in c.items() if k not in ("id", "title", "created", "updated", "exported")}
    nc.update(keep)
    write_json(clip_path(nc["id"]), nc)
    return jsonify({"clip": nc, "timeline": timeline_for(nc)})


@app.delete("/api/clips/<cid>")
def api_clip_delete(cid):
    f = clip_path(cid)
    if f.exists():
        trash = P("clips", ".trash")
        trash.mkdir(parents=True, exist_ok=True)
        os.replace(f, trash / f"{cid}-{int(time.time())}.json")
    return jsonify({"ok": True})


@app.post("/api/clips/<cid>/render")
def api_clip_render(cid):
    c = read_json(clip_path(cid), None)
    if not c:
        abort(404)
    quality = (request.get_json(silent=True) or {}).get("quality", "final")

    def work(job):
        res = render.render_clip(c, quality, on_progress=lambda p: job.update(progress=p),
                                 cancel_event=job["cancel"])
        if quality != "draft":
            cc = read_json(clip_path(cid), c)
            cc["exported"] = rel(res["out"])
            write_json(clip_path(cid), cc)
        return {"path": rel(res["out"]), "warnings": res["warnings"], "duration": res["duration"]}

    label = "Draft" if quality == "draft" else "Export"
    job = new_job("render", f"{label} {c.get('title', cid)}", cid)
    run_job(job, work)
    return jsonify(job_public(job))


@app.get("/api/jobs")
def api_jobs():
    with JOB_LOCK:
        jobs = sorted(JOBS.values(), key=lambda j: j["created"], reverse=True)[:25]
        return jsonify([job_public(j) for j in jobs])


@app.post("/api/jobs/<jid>/cancel")
def api_job_cancel(jid):
    j = JOBS.get(jid)
    if j:
        j["cancel"].set()
    return jsonify({"ok": True})


@app.post("/api/open")
def api_open():
    """Open a project folder/file in Explorer."""
    p = resolve((request.get_json(silent=True) or {}).get("path", "."))
    try:
        p.resolve().relative_to(project_root())
    except ValueError:
        abort(403)
    if p.exists() and os.name == "nt":
        if p.is_file():
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            os.startfile(str(p))
    return jsonify({"ok": True})


# ---------------------------------------------------------------- YouTube

@app.post("/api/youtube/info")
def api_yt_info():
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not youtube.is_youtube_url(url):
        return jsonify({"error": "Link YouTube tidak valid"}), 400
    try:
        info = youtube.fetch_info(url)
    except Exception as e:
        return jsonify({"error": str(e)[-800:]}), 500
    camp = load_campaign()
    allowed = [a.lower().lstrip("@") for a in camp.get("allowed_channels", [])]
    ch = (info.get("channel_handle") or "").lower().lstrip("@")
    info["channel_ok"] = (not allowed) or ch in allowed or (info.get("channel") or "").lower().replace(" ", "") in allowed
    info["peaks"] = youtube.heatmap_peaks(info.get("heatmap"))
    info["scan"] = read_json(scan_dir(info["id"]) / "scan.json", None)
    return jsonify(info)


@app.post("/api/youtube/download")
def api_yt_download():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not youtube.is_youtube_url(url):
        return jsonify({"error": "Link YouTube tidak valid"}), 400
    start, end = body.get("start"), body.get("end")
    height = int(body.get("height", 1080))

    def work(job):
        path = youtube.download(url, P("downloads"), start=start, end=end, height=height,
                                on_progress=lambda p, msg=None: job.update(progress=p, message=msg or job["message"]),
                                cancel_event=job["cancel"])
        sources = scan_sources()
        sid = next((s["id"] for s in sources if s["path"] == rel(path)), None)
        return {"path": rel(path), "source_id": sid}

    rng = f" {youtube.fmt_hms(start)}–{youtube.fmt_hms(end)}" if start is not None and end is not None else ""
    job = new_job("download", f"Download YouTube{rng}", url)
    run_job(job, work, heavy=False)
    return jsonify(job_public(job))


def scan_dir(video_id):
    return P("work", "ytscan", re.sub(r"[^A-Za-z0-9_-]", "", video_id or ""))


@app.post("/api/youtube/scan")
def api_yt_scan():
    """Audio-only scan of a long VOD: loudness + optional transcript -> candidate moments."""
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not youtube.is_youtube_url(url):
        return jsonify({"error": "Link YouTube tidak valid"}), 400
    want_tr = bool(body.get("transcribe", True))

    def work(job):
        job["message"] = "ambil info video"
        info = youtube.fetch_info(url)
        d = scan_dir(info["id"])
        audio = youtube.download_audio(url, d, cancel_event=job["cancel"],
                                       on_progress=lambda p, msg=None: job.update(progress=0.3 * p, message=msg or ""))
        job["message"] = "analisis suara"
        dur = info.get("duration") or ffprobe(audio)["duration"]
        env = analyze.loudness_envelope(audio, duration=dur,
                                        on_progress=lambda p: job.update(progress=0.3 + 0.1 * p))
        np.save(d / "envelope.npy", env)
        transcript = None
        if want_tr:
            run_whisper(job, audio, d / "transcript.json", progress_from=0.4, progress_to=0.98)
            transcript = read_json(d / "transcript.json", None)
        camp = load_campaign()
        cands = analyze.find_candidates(env, dur, transcript=transcript, heatmap=info.get("heatmap"),
                                        keywords=camp.get("keywords"), top_k=20, pre=20, post=15, min_gap=60)
        result = {"id": info["id"], "url": info["url"], "title": info["title"], "duration": dur,
                  "transcribed": transcript is not None, "candidates": cands,
                  "scanned": datetime.datetime.now().isoformat(timespec="seconds")}
        write_json(d / "scan.json", result)
        return {"video_id": info["id"]}

    job = new_job("ytscan", "Scan momen YouTube", url)
    run_job(job, work)
    return jsonify(job_public(job))


def pick_start_project(arg):
    """--project, else the last campaign used on this computer, else the folder above the tool."""
    if arg:
        return Path(arg)
    last = local_settings().get("last")
    if last and (Path(last) / "campaign.json").is_file():
        return Path(last)
    return CLIPPER_DIR.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=None, help="folder campaign (berisi campaign.json)")
    ap.add_argument("--port", type=int, default=5170)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    start = pick_start_project(a.project)
    if (start / "campaign.json").is_file():
        open_workspace(start)
    else:
        set_project(start)  # no campaign here yet: the GUI offers to create or open one
    url = f"http://127.0.0.1:{a.port}"
    status = "" if has_campaign() else "  (belum ada campaign.json: buat campaign baru di GUI)"
    print(f"Clipper  ->  {url}\nCampaign: {project_root()}{status}\n(Ctrl+C untuk berhenti)")
    if not a.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=a.port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
