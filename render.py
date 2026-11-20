"""Render a clip JSON to a vertical MP4 with ffmpeg.

CLI:  python clipper/render.py clips/<id>.json [--draft] [--project <dir>]
"""
import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (P, resolve, read_json, load_campaign, ffprobe, run_ffmpeg, video_encoder_args,
                    set_project, rel, slugify, has_cuda_decode, branding_for)
from captions import build_segments, build_timeline, build_ass
from analyze import fit_aspect

ANIM_IN = 0.35  # seconds for banner fade/slide


def overlay_chain(i, base, out, el, W, H, main_dur, timed=False):
    """Scale an image input, then overlay it centred on (x, y). Banners can be timed and animated."""
    ww = max(2, int(W * float(el.get("w", 1.0))) // 2 * 2)
    op = float(el.get("opacity", 1.0))
    cx, cy = W * float(el.get("x", 0.5)), H * float(el.get("y", 0.5))
    chain = f"[{i}:v]scale={ww}:-2,format=rgba,colorchannelmixer=aa={op:.3f}"
    enable, y_expr = "", f"{cy:.1f}-h/2"
    if timed:
        start = max(0.0, float(el.get("start", 0)))
        dur = float(el.get("duration", 0)) or max(0.0, main_dur - start)
        end = min(main_dur, start + dur)
        anim = el.get("anim", "fade")
        if anim == "fade":
            chain += f",fade=t=in:st={start:.3f}:d={ANIM_IN}:alpha=1"
            if end < main_dur - 0.05:
                chain += f",fade=t=out:st={max(start, end - ANIM_IN):.3f}:d={ANIM_IN}:alpha=1"
        elif anim == "slide":
            # slides in from the nearest edge, eased out
            off = f"(h/2+{cy:.1f})" if cy < H / 2 else f"({H}-{cy:.1f}+h/2)"
            sign = "-" if cy < H / 2 else "+"
            p = f"min(max((t-{start:.3f})/{ANIM_IN}\\,0)\\,1)"
            y_expr = f"{cy:.1f}-h/2{sign}{off}*(1-{p})*(1-{p})"
        enable = f":enable='between(t\\,{start:.3f}\\,{end:.3f})'"
    return [chain + f"[img_{out}]",
            f"[{base}][img_{out}]overlay=x={cx:.1f}-w/2:y='{y_expr}':shortest=1:format=auto{enable},"
            f"format=yuv420p[{out}]"]


def bumper_chain(el, idx, tag, W, H, F):
    """Inputs + filters for a bumper (video or still image) -> [v<tag>][a<tag>] at the output format."""
    args, lines = [], []
    fit = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,"
           f"setsar=1,fps={F},format=yuv420p")
    if el["kind"] == "image":
        dur = max(0.5, float(el.get("image_duration", 2.0)))
        args += ["-loop", "1", "-t", f"{dur:.3f}", "-framerate", str(F), "-i", el["abs"]]
        lines.append(f"[{idx}:v]{fit}[v{tag}]")
        idx += 1
        args += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        lines.append(f"[{idx}:a]anull[a{tag}]")
        idx += 1
        return args, lines, dur, idx
    info = ffprobe(el["abs"])
    dur = info["duration"]
    args += ["-i", el["abs"]]
    vi = idx
    idx += 1
    lines.append(f"[{vi}:v]{fit}[v{tag}]")
    if info.get("has_audio"):
        lines.append(f"[{vi}:a]aformat=sample_rates=48000:channel_layouts=stereo[a{tag}]")
    else:
        args += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        lines.append(f"[{idx}:a]anull[a{tag}]")
        idx += 1
    return args, lines, dur, idx


def _px_rect(r, W, H, aspect=None):
    if aspect:
        r = fit_aspect(r, aspect, W, H)
    x = max(0, min(W - 2, int(round(r["x"] * W))))
    y = max(0, min(H - 2, int(round(r["y"] * H))))
    w = int(round(r["w"] * W)) // 2 * 2
    h = int(round(r["h"] * H)) // 2 * 2
    w = max(2, min(w, (W - x) // 2 * 2))
    h = max(2, min(h, (H - y) // 2 * 2))
    return w, h, x, y


def _zoom(kind, w, h, dur):
    """Per-frame zoom (scale with eval=frame, then centre-crop back)."""
    if kind == "push":
        z = f"(1+0.12*t/{max(dur, 0.1):.3f})"
    elif kind == "punch":
        z = "(1+0.22*min(t/0.12\\,1))"
    elif kind == "punch-out":
        z = "(1.25-0.25*min(t/0.35\\,1))"
    else:
        return ""
    return (f",scale=w='trunc({w}*{z}/2)*2':h='trunc({h}*{z}/2)*2':eval=frame:flags=bicubic"
            f",crop={w}:{h}")


def layout_chain(i, layout, info, W, H, seg, F):
    """Filter lines turning input i into [v{i}] of W x H."""
    sw, sh = info["width"], info["height"]
    mode = layout.get("mode", "split")
    sp = seg["speed"]
    head = f"[{i}:v]setpts=(PTS-STARTPTS)/{sp:.4f}"
    dur = seg["out_end"] - seg["out_start"]
    zoom = seg.get("zoom", "none")
    tail = f",fps={F},format=yuv420p,setsar=1[v{i}]"
    lines = []
    if mode == "split":
        ratio = float(layout.get("split_ratio", 0.4))
        ht = int(round(H * ratio / 2)) * 2
        hb = H - ht
        cw, ch, cx, cy = _px_rect(layout["cam"], sw, sh, W / ht)
        gw, gh, gx, gy = _px_rect(layout["game"], sw, sh, W / hb)
        lines.append(f"{head},split=2[c{i}][g{i}]")
        lines.append(f"[c{i}]crop={cw}:{ch}:{cx}:{cy},scale={W}:{ht}:flags=lanczos,setsar=1[top{i}]")
        lines.append(f"[g{i}]crop={gw}:{gh}:{gx}:{gy},scale={W}:{hb}:flags=lanczos,setsar=1"
                     f"{_zoom(zoom, W, hb, dur)}[bot{i}]")
        order = f"[top{i}][bot{i}]" if layout.get("cam_top", True) else f"[bot{i}][top{i}]"
        lines.append(f"{order}vstack=inputs=2{tail}")
    elif mode == "crop":
        w, h, x, y = _px_rect(layout["crop"], sw, sh, W / H)
        lines.append(f"{head},crop={w}:{h}:{x}:{y},scale={W}:{H}:flags=lanczos,setsar=1{_zoom(zoom, W, H, dur)}{tail}")
    else:  # fit
        w, h, x, y = _px_rect(layout.get("content") or {"x": 0, "y": 0, "w": 1, "h": 1}, sw, sh)
        fz = max(1.0, float(layout.get("fit_zoom", 1.0)))
        fy = float(layout.get("fit_y", 0.5))
        fw = int(W * fz) // 2 * 2
        lines.append(f"{head},crop={w}:{h}:{x}:{y},split=2[a{i}][b{i}]")
        if layout.get("bg", "blur") == "blur":
            qw, qh = W // 4 // 2 * 2, H // 4 // 2 * 2
            lines.append(f"[a{i}]scale={qw}:{qh}:force_original_aspect_ratio=increase,crop={qw}:{qh},"
                         f"boxblur=10:2,eq=brightness=-0.10:saturation=1.15,scale={W}:{H},setsar=1[bg{i}]")
        else:
            lines.append(f"[a{i}]scale={W}:{H},drawbox=c=black:t=fill,setsar=1[bg{i}]")
        lines.append(f"[b{i}]scale={fw}:-2:flags=lanczos,crop='min(iw,{W})':'min(ih,{H})',setsar=1[fg{i}]")
        lines.append(f"[bg{i}][fg{i}]overlay=x=(W-w)/2:y=(H-h)*{fy:.3f}{_zoom(zoom, W, H, dur)}{tail}")
    return lines


def _atempo(speed):
    parts, s = [], speed
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    if abs(s - 1.0) > 1e-3:
        parts.append(f"atempo={s:.4f}")
    return ("," + ",".join(parts)) if parts else ""


def source_meta(clip):
    sid = clip.get("source_id")
    meta = read_json(P("work", sid, "source.json"), None) if sid else None
    if not meta:
        info = ffprobe(resolve(clip["source"]))
        meta = dict(info, path=clip["source"])
    return meta


def build_render(clip, quality="final", out_path=None, hw=None):
    campaign = load_campaign()
    meta = source_meta(clip)
    src = resolve(meta.get("path") or clip["source"])
    if not src.exists():
        raise FileNotFoundError(f"Video sumber tidak ada: {src}")
    out_cfg = campaign.get("output", {})
    W, H = int(out_cfg.get("width", 1080)), int(out_cfg.get("height", 1920))
    if quality == "draft":
        W, H = W // 2 // 2 * 2, H // 2 // 2 * 2
    F = int(clip.get("fps") or out_cfg.get("fps", 30))
    if quality == "draft":
        F = min(F, 30)

    sid = clip.get("source_id") or ""
    transcript = read_json(P("work", sid, "transcript.json"), None) if sid else None
    segs, main_dur = build_segments(clip)
    if not segs:
        raise ValueError("Klip belum punya segmen.")
    timeline = build_timeline(clip, transcript)
    layout = clip["layout"]
    warnings = []

    args, lines = [], []
    n = len(segs)
    hw = has_cuda_decode() if hw is None else hw
    for i, sg in enumerate(segs):
        args += (["-hwaccel", "cuda"] if hw else []) + [
            "-ss", f"{sg['start']:.3f}", "-t", f"{sg['end'] - sg['start']:.3f}", "-i", str(src)]
    idx = n
    silent_idx = None
    if not meta.get("has_audio", True):
        args += ["-f", "lavfi", "-t", f"{main_dur + 1:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        silent_idx = idx
        idx += 1

    for i, sg in enumerate(segs):
        lines += layout_chain(i, layout, meta, W, H, sg, F)
        if silent_idx is None:
            lines.append(f"[{i}:a]asetpts=PTS-STARTPTS{_atempo(sg['speed'])},"
                         f"aformat=sample_rates=48000:channel_layouts=stereo[a{i}]")
    if silent_idx is not None:
        lines.append(f"[{silent_idx}:a]asplit={n}" + "".join(f"[sa{i}]" for i in range(n)))
        for i, sg in enumerate(segs):
            d = sg["out_end"] - sg["out_start"]
            lines.append(f"[sa{i}]atrim=0:{d:.3f},asetpts=PTS-STARTPTS[a{i}]")
    lines.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vcat][acat]")

    # captions / titles
    work_dir = P("work", "renders")
    work_dir.mkdir(parents=True, exist_ok=True)
    ass_name = f"{slugify(clip['id'])}-{quality}.ass"
    (work_dir / ass_name).write_text(build_ass(clip, timeline), encoding="utf-8")
    lines.append(f"[vcat]ass={ass_name}[vsub]")
    vlabel = "vsub"

    # image overlays on the clip part: banner (timed, animated) under the watermark (always on)
    for key, label in (("banner", "Banner"), ("watermark", "Watermark")):
        el = branding_for(clip, campaign, key)
        if not el.get("enabled"):
            continue
        if not el["exists"]:
            note = " (wajib menurut campaign)" if el.get("required") else ""
            warnings.append(f"{label} belum ada: {el.get('path') or '(belum dipilih)'}{note}")
            continue
        if el["kind"] != "image":
            warnings.append(f"{label} harus file gambar (.png/.jpg/.webp): {el['path']}")
            continue
        args += ["-loop", "1", "-t", f"{main_dur + 1:.3f}", "-i", el["abs"]]
        lines += overlay_chain(idx, vlabel, f"v{key}", el, W, H, main_dur, timed=(key == "banner"))
        vlabel = f"v{key}"
        idx += 1

    # audio: original sound + optional backsound (ducked under the original) + sound effects
    voice_vol = max(0.0, float(clip.get("voice_volume", 1.0)))
    music = clip.get("music") or {}
    music_path = resolve(music["path"]) if music.get("path") else None
    if music_path is not None and not music_path.exists():
        warnings.append(f"Backsound tidak ditemukan: {music['path']}")
        music_path = None
    sfx_items = []
    for s in clip.get("sfx") or []:
        p = resolve(s.get("path", "")) if s.get("path") else None
        if p is None or not p.exists():
            warnings.append(f"Sound effect tidak ditemukan: {s.get('path')}")
            continue
        at = float(s.get("at", 0))
        if 0 <= at < main_dur:
            sfx_items.append((p, at, max(0.0, float(s.get("volume", 1.0)))))

    duck = music_path is not None and music.get("duck", True)
    vol_f = f"volume={voice_vol:.3f}," if abs(voice_vol - 1) > 1e-3 else ""
    lines.append(f"[acat]{vol_f}" + ("asplit=2[voice][vkey]" if duck else "anull[voice]"))
    mix_inputs = ["[voice]"]
    if music_path is not None:
        off = max(0.0, float(music.get("start", 0)))
        fi = max(0.0, float(music.get("fade_in", 0.5)))
        fo = min(max(0.0, float(music.get("fade_out", 1.0))), main_dur)
        args += ["-stream_loop", "-1", "-i", str(music_path)]  # loops when the track is shorter than the clip
        chain = (f"[{idx}:a]atrim=start={off:.3f}:duration={main_dur:.3f},asetpts=PTS-STARTPTS,"
                 f"aformat=sample_rates=48000:channel_layouts=stereo,volume={float(music.get('volume', 0.15)):.3f}")
        if fi:
            chain += f",afade=t=in:st=0:d={fi:.2f}"
        if fo:
            chain += f",afade=t=out:st={max(0.0, main_dur - fo):.3f}:d={fo:.2f}"
        lines.append(chain + "[mus]")
        idx += 1
        if duck:
            lines.append("[mus][vkey]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400[musd]")
            mix_inputs.append("[musd]")
        else:
            mix_inputs.append("[mus]")
    for k, (p, at, vol) in enumerate(sfx_items):
        args += ["-i", str(p)]
        ms = int(round(at * 1000))
        lines.append(f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={vol:.3f},"
                     f"adelay={ms}|{ms}[sfx{k}]")
        mix_inputs.append(f"[sfx{k}]")
        idx += 1
    alabel = "voice"
    if len(mix_inputs) > 1:
        lines.append("".join(mix_inputs) +
                     f"amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=0:normalize=0[amix]")
        alabel = "amix"
    if clip.get("loudnorm", True):
        lines.append(f"[{alabel}]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,"
                     "aformat=sample_rates=48000:channel_layouts=stereo[anorm]")
        alabel = "anorm"

    # bumpers: separate videos/images glued before and after the clip, untouched apart from fitting the frame
    total = main_dur
    parts = []
    for key, label, tag in (("bumper_in", "Bumper in", "bi"), ("bumper_out", "Bumper out", "bo")):
        el = branding_for(clip, campaign, key)
        if not el.get("enabled"):
            continue
        if not el["exists"] or el["kind"] not in ("image", "video"):
            note = " (wajib menurut campaign)" if el.get("required") else ""
            warnings.append(f"{label} belum ada atau bukan video/gambar: {el.get('path') or '(belum dipilih)'}{note}")
            continue
        b_args, b_lines, b_dur, idx = bumper_chain(el, idx, tag, W, H, F)
        args += b_args
        lines += b_lines
        parts.append((key, tag))
        total += b_dur
    if parts:
        order = ([f"[v{t}][a{t}]" for k, t in parts if k == "bumper_in"] + [f"[{vlabel}][{alabel}]"] +
                 [f"[v{t}][a{t}]" for k, t in parts if k == "bumper_out"])
        lines.append("".join(order) + f"concat=n={len(order)}:v=1:a=1[vout][aout]")
        vlabel, alabel = "vout", "aout"

    graph_path = work_dir / f"{slugify(clip['id'])}-{quality}.filter.txt"
    graph_path.write_text(";\n".join(lines) + "\n", encoding="utf-8")

    if out_path is None:
        if quality == "draft":
            out_path = P("work", "drafts", f"{slugify(clip['id'])}.mp4")
        else:
            stamp = datetime.date.today().strftime("%Y%m%d")
            out_path = P("exports", f"{stamp}_{slugify(clip['id'])}.mp4")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    full = args + ["-/filter_complex", graph_path.name, "-map", f"[{vlabel}]", "-map", f"[{alabel}]"]
    full += video_encoder_args("draft" if quality == "draft" else "final")
    full += ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-movflags", "+faststart", str(out_path.resolve())]
    return {"args": full, "cwd": str(work_dir), "duration": total, "out": out_path,
            "warnings": warnings, "main_duration": main_dur}


def render_clip(clip, quality="final", on_progress=None, cancel_event=None, log=None):
    job = build_render(clip, quality)
    try:
        run_ffmpeg(job["args"], duration=job["duration"], on_progress=on_progress,
                   cancel_event=cancel_event, cwd=job["cwd"], log=log)
    except RuntimeError:
        if not has_cuda_decode():
            raise
        job = build_render(clip, quality, hw=False)  # retry with CPU decoding
        run_ffmpeg(job["args"], duration=job["duration"], on_progress=on_progress,
                   cancel_event=cancel_event, cwd=job["cwd"], log=log)
    if quality != "draft":
        campaign = load_campaign()
        caption = (clip.get("post_caption") or "").strip()
        tags = " ".join(campaign.get("hashtags", []))
        if tags and tags not in caption:
            caption = (caption + "\n\n" + tags).strip()
        job["out"].with_suffix(".txt").write_text(caption + "\n", encoding="utf-8")
    return job


def main():
    ap = argparse.ArgumentParser(description="Render clip JSON to MP4")
    ap.add_argument("clip")
    ap.add_argument("--draft", action="store_true")
    ap.add_argument("--project", default=None)
    a = ap.parse_args()
    if a.project:
        set_project(a.project)
    clip = read_json(resolve(a.clip))
    if not clip:
        sys.exit(f"Tidak bisa baca {a.clip}")
    job = render_clip(clip, "draft" if a.draft else "final",
                      on_progress=lambda p: print(f"\r{p * 100:5.1f}%", end="", flush=True))
    print()
    for w in job["warnings"]:
        print("PERINGATAN:", w)
    print("OK:", rel(job["out"]))


if __name__ == "__main__":
    main()
