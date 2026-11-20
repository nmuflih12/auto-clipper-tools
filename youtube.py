"""YouTube helpers on top of yt-dlp (info, most-replayed heatmap, full or partial download)."""
import json
import re
import shutil
import subprocess
from pathlib import Path

from common import python_exe, write_json, Cancelled

YT_RE = re.compile(r"^(https?://)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/", re.I)


def is_youtube_url(url):
    return bool(url) and bool(YT_RE.match(url.strip()))


def _base_cmd():
    cmd = [python_exe(), "-m", "yt_dlp", "--no-warnings", "--no-playlist"]
    if not shutil.which("deno") and shutil.which("node"):
        cmd += ["--js-runtimes", "node"]
    return cmd


def fmt_hms(sec):
    if sec is None:
        return ""
    sec = int(float(sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def fetch_info(url):
    r = subprocess.run(_base_cmd() + ["-J", "--skip-download", url], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-800:] or "yt-dlp gagal")
    d = json.loads(r.stdout)
    handle = d.get("uploader_id") or ""
    if not handle.startswith("@"):
        url_ch = d.get("uploader_url") or d.get("channel_url") or ""
        m = re.search(r"/(@[^/?]+)", url_ch)
        handle = m.group(1) if m else ""
    return {
        "id": d.get("id"), "url": d.get("webpage_url") or url, "title": d.get("title"),
        "duration": d.get("duration"), "channel": d.get("channel") or d.get("uploader"),
        "channel_handle": handle, "upload_date": d.get("upload_date"), "view_count": d.get("view_count"),
        "thumbnail": d.get("thumbnail"), "live_status": d.get("live_status"),
        "heatmap": d.get("heatmap") or [], "chapters": d.get("chapters") or [],
        "max_height": max((f.get("height") or 0 for f in d.get("formats", []) if f.get("vcodec") not in (None, "none")), default=0),
    }


def heatmap_peaks(heatmap, top=10, min_gap=45):
    """Local maxima of the most-replayed graph, strongest first."""
    if not heatmap:
        return []
    pts = sorted(heatmap, key=lambda h: h["start_time"])
    vals = [h.get("value", 0) for h in pts]
    cands = []
    for i, h in enumerate(pts):
        v = vals[i]
        left = vals[i - 1] if i > 0 else -1
        right = vals[i + 1] if i + 1 < len(vals) else -1
        if v >= left and v >= right:
            cands.append(((h["start_time"] + h["end_time"]) / 2, v))
    cands.sort(key=lambda c: -c[1])
    out = []
    for t, v in cands:
        if all(abs(t - o["time"]) >= min_gap for o in out):
            out.append({"time": round(t, 1), "value": round(v, 3), "label": fmt_hms(t)})
        if len(out) >= top:
            break
    return out


def download(url, out_dir, start=None, end=None, height=1080, on_progress=None, cancel_event=None):
    """Download the whole video or only [start, end] seconds. Returns the mp4 path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    info = fetch_info(url)
    vid = info["id"]
    if start is not None and end is not None:
        start, end = float(start), float(end)
        if end <= start:
            raise ValueError("Range download tidak valid")
        name = f"yt-{vid}-{int(start)}-{int(end)}"
    else:
        start = end = None
        name = f"yt-{vid}"
    target = out_dir / f"{name}.mp4"
    fmt = f"bv*[height<={height}]+ba/b[height<={height}]/bv*+ba/b"
    cmd = _base_cmd() + [
        "-f", fmt, "--merge-output-format", "mp4", "-o", str(out_dir / f"{name}.%(ext)s"),
        "--newline", "--progress-template", "download:PROG %(progress._percent_str)s|%(progress._eta_str)s",
        "--print", "after_move:FINAL %(filepath)s", "--force-overwrites",
    ]
    if start is not None:
        cmd += ["--download-sections", f"*{start:.2f}-{end:.2f}"]
    cmd.append(url)
    if on_progress:
        on_progress(0.01, "mulai download")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    final, tail = None, []
    for line in proc.stdout:
        if cancel_event is not None and cancel_event.is_set():
            proc.kill()
            raise Cancelled()
        line = line.strip()
        tail.append(line)
        tail[:] = tail[-20:]
        if line.startswith("PROG"):
            m = re.search(r"([\d.]+)%", line)
            if m and on_progress:
                eta = line.split("|")[-1].strip()
                on_progress(min(0.99, float(m.group(1)) / 100), f"download {m.group(1)}% (sisa {eta})")
        elif line.startswith("FINAL "):
            final = Path(line[6:].strip())
        elif "time=" in line and on_progress and start is not None:
            m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
            if m:
                t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                on_progress(min(0.99, t / max(1.0, end - start)), "download potongan")
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("yt-dlp gagal:\n" + "\n".join(tail[-10:]))
    final = final if final and final.exists() else target
    if not final.exists():
        raise RuntimeError("File hasil download tidak ditemukan")
    side = {k: info.get(k) for k in ("id", "url", "title", "channel", "channel_handle", "upload_date",
                                       "heatmap", "chapters", "duration")}
    side["offset"] = start or 0
    side["range"] = [start, end] if start is not None else None
    if start is not None:
        side["title"] = f"{info.get('title')} [{fmt_hms(start)}–{fmt_hms(end)}]"
    write_json(final.with_suffix(".yt.json"), side)
    return final


def download_audio(url, out_dir, on_progress=None, cancel_event=None):
    """Smallest audio-only stream (for scanning long VODs without downloading video)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = _base_cmd() + [
        "-f", "wa[acodec^=mp4a]/wa/ba", "-o", str(out_dir / "audio.%(ext)s"),
        "--newline", "--progress-template", "download:PROG %(progress._percent_str)s|%(progress._eta_str)s",
        "--print", "after_move:FINAL %(filepath)s", "--force-overwrites", url,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    final, tail = None, []
    for line in proc.stdout:
        if cancel_event is not None and cancel_event.is_set():
            proc.kill()
            raise Cancelled()
        line = line.strip()
        tail = (tail + [line])[-20:]
        if line.startswith("PROG") and on_progress:
            m = re.search(r"([\d.]+)%", line)
            if m:
                on_progress(float(m.group(1)) / 100, f"download audio {m.group(1)}% (sisa {line.split('|')[-1].strip()})")
        elif line.startswith("FINAL "):
            final = Path(line[6:].strip())
    proc.wait()
    if proc.returncode != 0 or not final or not final.exists():
        raise RuntimeError("Download audio gagal:\n" + "\n".join(tail[-10:]))
    return final
