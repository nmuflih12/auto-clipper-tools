"""Source preparation and highlight detection.

prepare(): proxy video for the browser, loudness envelope, black-bar detection.
find_candidates(): scores moments from loudness spikes, transcript keywords and
YouTube "most replayed" heatmap, then returns ranked clip windows.
"""
import re
import subprocess

import numpy as np

from common import run_ffmpeg, video_encoder_args, ffprobe, has_cuda_decode

HOP = 0.1  # seconds per envelope frame


# ---------------------------------------------------------------- proxy

def make_proxy(src, out, duration, on_progress=None, cancel_event=None):
    """540p H.264 copy with short GOP so the browser can seek fast. Rotation is baked in."""
    def args(hw):
        a = (["-hwaccel", "cuda"] if hw else []) + ["-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
                                                    "-vf", "scale=-2:540:flags=bilinear,fps=30,format=yuv420p"]
        a += video_encoder_args("proxy")
        return a + ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", str(out)]
    try:
        run_ffmpeg(args(has_cuda_decode()), duration=duration, on_progress=on_progress, cancel_event=cancel_event)
    except RuntimeError:
        if not has_cuda_decode():
            raise
        run_ffmpeg(args(False), duration=duration, on_progress=on_progress, cancel_event=cancel_event)


# ---------------------------------------------------------------- loudness

def loudness_envelope(src, on_progress=None, duration=None):
    """RMS loudness in dBFS every HOP seconds (mono 16 kHz decode streamed through numpy)."""
    sr = 16000
    hop_n = int(sr * HOP)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr),
           "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    out = []
    leftover = np.zeros(0, dtype=np.float32)
    block = hop_n * 100 * 2  # 10 s of audio per read
    done_frames = 0
    while True:
        chunk = proc.stdout.read(block)
        if not chunk:
            break
        x = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
        x = np.concatenate([leftover, x])
        n = len(x) // hop_n
        if n:
            frames = x[: n * hop_n].reshape(n, hop_n)
            rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
            out.append(20 * np.log10(rms + 1e-9))
            done_frames += n
            if on_progress and duration:
                on_progress(min(1.0, done_frames * HOP / duration))
        leftover = x[n * hop_n:]
    proc.wait()
    if not out:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(out).astype(np.float32)


# ---------------------------------------------------------------- black bars

def detect_content_rect(src, info):
    """Find the area inside letterbox/pillarbox bars. Returns normalized {x,y,w,h}."""
    W, H, dur = info["width"], info["height"], info["duration"]
    boxes = []
    samples = [dur * f for f in (0.15, 0.35, 0.55, 0.75, 0.9)] if dur > 6 else [0]
    for t in samples:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-ss", f"{t:.2f}", "-i", str(src), "-t", "1.5",
             "-vf", "cropdetect=limit=0.07:round=2:reset=0", "-an", "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        found = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", r.stderr)
        if found:
            w, h, x, y = map(int, found[-1])
            if w > W * 0.3 and h > H * 0.3:
                boxes.append((x, y, x + w, y + h))
    if not boxes:
        return {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    # ignore tiny trims (< 1.5%) — treat as full frame on that axis
    if x0 < W * 0.015 and (W - x1) < W * 0.015:
        x0, x1 = 0, W
    if y0 < H * 0.015 and (H - y1) < H * 0.015:
        y0, y1 = 0, H
    # dark game scenes fool cropdetect; streams are 16:9, so snap to a 16:9 box when close
    if x0 > W * 0.03 and x1 < W * 0.97:  # pillarbox (e.g. phone screen recording)
        w169 = H * 16 / 9
        if abs(w169 - (x1 - x0)) < W * 0.05 and w169 <= W:
            cx = (x0 + x1) / 2
            x0 = max(0, min(W - w169, cx - w169 / 2))
            x1 = x0 + w169
            y0, y1 = 0, H
    elif y0 > H * 0.03 and y1 < H * 0.97:  # letterbox
        h169 = W * 9 / 16
        if abs(h169 - (y1 - y0)) < H * 0.05 and h169 <= H:
            cy = (y0 + y1) / 2
            y0 = max(0, min(H - h169, cy - h169 / 2))
            y1 = y0 + h169
            x0, x1 = 0, W
    return {"x": round(x0 / W, 4), "y": round(y0 / H, 4),
            "w": round((x1 - x0) / W, 4), "h": round((y1 - y0) / H, 4)}


def fit_aspect(rect, aspect, W, H):
    """Shrink a normalized rect (centered) so its pixel aspect w/h == aspect."""
    pw, ph = rect["w"] * W, rect["h"] * H
    if pw / ph > aspect:
        nw = ph * aspect
        x = rect["x"] * W + (pw - nw) / 2
        return {"x": x / W, "y": rect["y"], "w": nw / W, "h": rect["h"]}
    nh = pw / aspect
    y = rect["y"] * H + (ph - nh) / 2
    return {"x": rect["x"], "y": y / H, "w": rect["w"], "h": nh / H}


def default_layout(info, content, out_w=1080, out_h=1920):
    """Starting layout: facecam (bottom-right of the stream) on top, gameplay below."""
    W, H = info["width"], info["height"]
    ratio = 0.4
    cam_aspect = out_w / (out_h * ratio)
    game_aspect = out_w / (out_h * (1 - ratio))
    cx, cy, cw, ch = content["x"], content["y"], content["w"], content["h"]
    cam_h = ch * 0.30
    cam_w = cam_h * H * cam_aspect / W
    cam = {"x": cx + cw - cam_w, "y": cy + ch - cam_h, "w": cam_w, "h": cam_h}
    game = fit_aspect({"x": cx, "y": cy, "w": cw, "h": ch}, game_aspect, W, H)
    crop = fit_aspect({"x": cx, "y": cy, "w": cw, "h": ch}, out_w / out_h, W, H)
    r4 = lambda d: {k: round(v, 4) for k, v in d.items()}
    return {
        "mode": "split", "split_ratio": ratio, "cam_top": True,
        "cam": r4(cam), "game": r4(game), "crop": r4(crop), "content": r4(content),
        "fit_zoom": 1.0, "fit_y": 0.5, "bg": "blur",
    }


# ---------------------------------------------------------------- candidates

def _moving_avg(x, n):
    if n <= 1 or len(x) < n:
        return x.copy()
    k = np.ones(n, dtype=np.float32) / n
    return np.convolve(x, k, mode="same")


def _rolling_median(x, win_frames, step):
    """Cheap rolling median: compute on a decimated grid then interpolate."""
    if len(x) == 0:
        return x
    idx = np.arange(0, len(x), step)
    half = win_frames // 2
    med = np.array([np.median(x[max(0, i - half): i + half + 1]) for i in idx], dtype=np.float32)
    return np.interp(np.arange(len(x)), idx, med).astype(np.float32)


def _words(transcript):
    if not transcript:
        return []
    out = []
    for seg in transcript.get("segments", []):
        for w in seg.get("words", []) or []:
            out.append(w)
    return out


def _norm_word(w):
    return re.sub(r"[^a-z0-9]", "", (w or "").lower())


def find_candidates(env_db, duration, transcript=None, heatmap=None, keywords=None,
                    top_k=12, pre=12.0, post=8.0, min_gap=None, heatmap_offset=0.0):
    """Return ranked highlight windows [{start, end, peak, score, reasons, text}]."""
    env = np.asarray(env_db, dtype=np.float32)
    n = len(env)
    if n == 0:
        return []
    env = np.maximum(env, -70.0)
    smooth = _moving_avg(env, int(1.0 / HOP))
    base = _rolling_median(smooth, int(60 / HOP), int(1.0 / HOP))
    excite = smooth - base
    g_med = float(np.median(smooth))
    g_p95 = float(np.percentile(smooth, 95))
    spread = max(3.0, g_p95 - g_med)
    score = 0.7 * np.clip(excite / 12.0, 0, 1.5) + 0.3 * np.clip((smooth - g_med) / spread, 0, 1.5)
    reasons_loud = excite.copy()

    # transcript keywords and laughter
    kw_hits = np.zeros(n, dtype=np.float32)
    kw_set = {_norm_word(k) for k in (keywords or []) if k}
    words = _words(transcript)
    hit_words = []
    if kw_set and words:
        for w in words:
            nw = _norm_word(w.get("w"))
            if not nw:
                continue
            match = nw in kw_set or nw.startswith("wkwk") or nw.startswith("haha") or nw.startswith("anj")
            if match:
                c = int(((w["s"] + w["e"]) / 2) / HOP)
                a, b = max(0, c - 15), min(n, c + 15)
                kw_hits[a:b] += 0.35
                hit_words.append((w["s"], nw))
        score = score + np.clip(kw_hits, 0, 1.0)

    # YouTube most-replayed heatmap
    heat = np.zeros(n, dtype=np.float32)
    if heatmap:
        vmax = max((h.get("value", 0) for h in heatmap), default=0) or 1.0
        for h in heatmap:
            a = int((h["start_time"] - heatmap_offset) / HOP)
            b = int((h["end_time"] - heatmap_offset) / HOP)
            a, b = max(0, a), min(n, b)
            if b > a:
                heat[a:b] = h.get("value", 0) / vmax
        score = score + 1.2 * heat

    if min_gap is None:
        min_gap = max(8.0, min(25.0, duration / 4))
    gap_frames = int(min_gap / HOP)
    order = np.argsort(-score)
    taken = []
    for i in order:
        if len(taken) >= top_k:
            break
        if score[i] <= 0.05:
            break
        if all(abs(int(i) - t) >= gap_frames for t in taken):
            taken.append(int(i))

    segs = (transcript or {}).get("segments", []) if transcript else []
    results = []
    for i in taken:
        peak = i * HOP
        start = max(0.0, peak - pre)
        end = min(duration, peak + post)
        # snap start to the beginning of the transcript sentence it falls into
        for s in segs:
            if s["start"] <= start <= s["end"] and start - s["start"] < 4:
                start = max(0.0, s["start"] - 0.15)
                break
        for s in segs:
            if s["start"] <= end <= s["end"] and s["end"] - end < 4:
                end = min(duration, s["end"] + 0.3)
                break
        reasons = []
        if reasons_loud[i] > 4:
            reasons.append(f"suara naik +{reasons_loud[i]:.0f} dB")
        hits = sorted({w for t, w in hit_words if start <= t <= end})
        if hits:
            reasons.append("kata: " + ", ".join(hits[:5]))
        if heat[i] > 0.3:
            reasons.append(f"most replayed {heat[i] * 100:.0f}%")
        text = " ".join(w.get("w", "").strip() for w in words if start <= w["s"] <= end)
        results.append({
            "start": round(start, 2), "end": round(end, 2), "peak": round(peak, 2),
            "score": round(float(score[i]), 3), "reasons": reasons, "text": text[:220],
        })
    return results


def envelope_for_ui(env_db, max_points=6000):
    """Max-pool the envelope down for drawing; returns (hop, values)."""
    env = np.asarray(env_db, dtype=np.float32)
    if len(env) <= max_points:
        return HOP, [round(float(v), 1) for v in env]
    f = int(np.ceil(len(env) / max_points))
    pad = (-len(env)) % f
    e = np.concatenate([env, np.full(pad, -90.0, dtype=np.float32)]).reshape(-1, f).max(axis=1)
    return HOP * f, [round(float(v), 1) for v in e]


def probe(src):
    return ffprobe(src)
