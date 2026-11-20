"""Clip timeline mapping + animated captions/titles as an ASS subtitle file (rendered by libass).

All text positions use a 1080x1920 canvas (PlayRes); libass scales it to the real output size.
"""
import re

PLAY_W, PLAY_H = 1080, 1920

CAPTION_STYLES = {
    # name: font, size, primary, outline colour, outline px, shadow px, highlight default
    "pop":   {"font": "Poppins Black", "size": 84, "color": "#FFFFFF", "outline": "#000000", "bord": 7, "shadow": 3, "highlight": "#FFE600"},
    "neon":  {"font": "Poppins Black", "size": 84, "color": "#FFFFFF", "outline": "#000000", "bord": 7, "shadow": 3, "highlight": "#39FF14"},
    "clean": {"font": "Poppins ExtraBold", "size": 70, "color": "#FFFFFF", "outline": "#000000", "bord": 5, "shadow": 2, "highlight": ""},
    "meme":  {"font": "Impact", "size": 92, "color": "#FFFFFF", "outline": "#000000", "bord": 6, "shadow": 0, "highlight": "#FFE600"},
}

HOOK_STYLES = {
    "box-white": {"font": "Poppins Black", "size": 68, "color": "#111111", "box": "#FFFFFF", "accent": "#E53935"},
    "box-red":   {"font": "Poppins Black", "size": 64, "color": "#FFFFFF", "box": "#E53935", "accent": "#FFE600"},
    "box-black": {"font": "Poppins Black", "size": 68, "color": "#FFFFFF", "box": "#111111", "accent": "#FFE600"},
    "outline":   {"font": "Poppins Black", "size": 76, "color": "#FFFFFF", "outline": "#000000", "accent": "#FFE600"},
}

OVERLAY_STYLES = {
    "meme":  {"font": "Impact", "size": 96, "color": "#FFFFFF", "outline": "#000000", "bord": 6},
    "pop":   {"font": "Poppins Black", "size": 84, "color": "#FFE600", "outline": "#000000", "bord": 7},
    "box":   {"font": "Poppins Black", "size": 60, "color": "#111111", "box": "#FFFFFF"},
    "red":   {"font": "Poppins Black", "size": 60, "color": "#FFFFFF", "box": "#E53935"},
}


# ---------------------------------------------------------------- timeline

def build_segments(clip):
    """Map source segments onto the output timeline."""
    out, t = [], 0.0
    for seg in clip.get("segments", []):
        s, e = float(seg["start"]), float(seg["end"])
        if e - s < 0.1:
            continue
        sp = float(seg.get("speed", 1.0) or 1.0)
        d = (e - s) / sp
        out.append({"start": s, "end": e, "speed": sp, "zoom": seg.get("zoom", "none"),
                    "out_start": round(t, 3), "out_end": round(t + d, 3)})
        t += d
    return out, round(t, 3)


def word_key(w):
    return f"{float(w['s']):.2f}"


def clip_words(clip, transcript, pad=0.0):
    """Source-time words inside the clip's segments, with the clip's text overrides applied."""
    if not transcript:
        return []
    overrides = (clip.get("captions") or {}).get("overrides") or {}
    segs, _ = build_segments(clip)
    result, seen = [], set()
    for seg in transcript.get("segments", []):
        for w in seg.get("words", []) or []:
            mid = (w["s"] + w["e"]) / 2
            if not any(sg["start"] - pad <= mid <= sg["end"] + pad for sg in segs):
                continue
            k = word_key(w)
            if k in seen:
                continue
            seen.add(k)
            text = overrides.get(k, w["w"])
            result.append({"key": k, "w": text, "orig": w["w"], "s": w["s"], "e": w["e"]})
    return result


def map_words(clip, transcript):
    """Words placed on the output timeline (a source word can appear in several segments)."""
    segs, _ = build_segments(clip)
    words = [w for w in clip_words(clip, transcript) if w["w"].strip()]
    out = []
    for sg in segs:
        for w in words:
            s, e = max(w["s"], sg["start"]), min(w["e"], sg["end"])
            if e - s < 0.04:
                continue
            os_ = sg["out_start"] + (s - sg["start"]) / sg["speed"]
            oe = sg["out_start"] + (e - sg["start"]) / sg["speed"]
            out.append({"w": w["w"], "s": round(os_, 3), "e": round(oe, 3), "seg_end": sg["out_end"]})
    out.sort(key=lambda x: x["s"])
    return out


def chunk_words(words, max_words=3, max_chars=20, max_gap=0.6, max_dur=2.6, uppercase=True):
    chunks, cur = [], []

    def flush():
        if cur:
            chunks.append(cur.copy())
            cur.clear()

    for w in words:
        text = w["w"].strip()
        if uppercase:
            text = text.upper()
        w = dict(w, w=text)
        if cur:
            chars = sum(len(x["w"]) + 1 for x in cur) + len(text)
            if (len(cur) >= max_words or chars > max_chars or w["s"] - cur[-1]["e"] > max_gap
                    or w["e"] - cur[0]["s"] > max_dur or cur[-1]["seg_end"] != w["seg_end"]):
                flush()
        cur.append(w)
        if re.search(r"[.!?]$", text):
            flush()
    flush()
    result = []
    for i, c in enumerate(chunks):
        nxt = chunks[i + 1][0]["s"] if i + 1 < len(chunks) else None
        end = c[-1]["e"] + 0.35
        if nxt is not None:
            end = min(end, nxt)
        end = min(end, c[-1]["seg_end"])
        result.append({"s": c[0]["s"], "e": round(max(end, c[-1]["e"]), 3),
                       "words": [{"w": x["w"], "s": x["s"], "e": x["e"]} for x in c]})
    return result


def build_timeline(clip, transcript):
    segs, dur = build_segments(clip)
    cap = clip.get("captions") or {}
    chunks = []
    if cap.get("enabled", True) and transcript:
        chunks = chunk_words(map_words(clip, transcript), max_words=int(cap.get("words_per_chunk", 3)),
                             uppercase=cap.get("uppercase", True))
    return {"segments": segs, "duration": dur, "captions": chunks,
            "words": clip_words(clip, transcript)}


# ---------------------------------------------------------------- ASS

def ass_color(hex_str, alpha=0):
    h = (hex_str or "#FFFFFF").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(t):
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(text):
    text = text.replace("\\", "/").replace("{", "(").replace("}", ")")
    return text.replace("\r", "").replace("\n", r"\N")


def accent_markup(text, base_hex, accent_hex):
    """*word* -> accent colour."""
    base, acc = ass_color(base_hex), ass_color(accent_hex)
    parts = re.split(r"(\*[^*]+\*)", text)
    out = []
    for p in parts:
        if p.startswith("*") and p.endswith("*") and len(p) > 2:
            out.append("{\\c" + acc + "}" + ass_escape(p[1:-1]) + "{\\c" + base + "}")
        else:
            out.append(ass_escape(p))
    return "".join(out)


POP_IN = r"\fscx72\fscy72\t(0,120,\fscx108\fscy108)\t(120,210,\fscx100\fscy100)"


def _style_line(name, font, size, primary, outline_hex, bord, shadow, box_hex=None):
    if box_hex:
        # BorderStyle 3 = opaque box drawn in OutlineColour, Outline = padding
        return (f"Style: {name},{font},{size},{ass_color(primary)},&H000000FF,{ass_color(box_hex)},"
                f"&H00000000,0,0,0,0,100,100,0,0,3,{max(10, size // 4)},0,5,40,40,0,1")
    return (f"Style: {name},{font},{size},{ass_color(primary)},&H000000FF,{ass_color(outline_hex)},"
            f"&H96000000,0,0,0,0,100,100,0,0,1,{bord},{shadow},5,60,60,0,1")


def build_ass(clip, timeline):
    cap = clip.get("captions") or {}
    cstyle = dict(CAPTION_STYLES.get(cap.get("style", "pop"), CAPTION_STYLES["pop"]))
    if cap.get("font"):
        cstyle["font"] = cap["font"]
    size = int(cap.get("size") or cstyle["size"])
    highlight = cap.get("highlight", cstyle["highlight"])
    hook = clip.get("hook") or {}
    hstyle = HOOK_STYLES.get(hook.get("style", "box-white"), HOOK_STYLES["box-white"])

    styles = [
        _style_line("Caption", cstyle["font"], size, cstyle["color"], cstyle["outline"], cstyle["bord"], cstyle["shadow"]),
        _style_line("Hook", hstyle["font"], int(hook.get("size") or hstyle["size"]), hstyle["color"],
                    hstyle.get("outline", "#000000"), 6, 2, hstyle.get("box")),
    ]
    for name, st in OVERLAY_STYLES.items():
        styles.append(_style_line(f"Ov_{name}", st["font"], st["size"], st["color"], st.get("outline", "#000000"),
                                  st.get("bord", 6), 2, st.get("box")))

    events = []
    total = timeline["duration"]

    # hook title
    text = (hook.get("text") or "").strip()
    if text:
        hd = float(hook.get("duration") or 0) or total
        y = int(PLAY_H * float(hook.get("y", 0.4)))
        body = accent_markup(text, hstyle["color"], hstyle["accent"])
        events.append(("Hook", 0.0, min(hd, total),
                       f"{{\\an5\\pos({PLAY_W // 2},{y})\\fad(60,120){POP_IN}}}" + body, 5))

    # captions
    if cap.get("enabled", True):
        y = int(PLAY_H * float(cap.get("y", 0.62)))
        hl = ass_color(highlight) if highlight else None
        base = ass_color(cstyle["color"])
        for ch in timeline["captions"]:
            words = ch["words"]
            if not hl:
                body = ass_escape(" ".join(w["w"] for w in words))
                events.append(("Caption", ch["s"], ch["e"],
                               f"{{\\an5\\pos({PLAY_W // 2},{y})\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)}}" + body, 2))
                continue
            for k, w in enumerate(words):
                s = ch["s"] if k == 0 else w["s"]
                e = words[k + 1]["s"] if k + 1 < len(words) else ch["e"]
                if e - s < 0.02:
                    continue
                parts = []
                for j, x in enumerate(words):
                    t = ass_escape(x["w"])
                    if j == k:
                        parts.append("{\\c" + hl + "\\fscx112\\fscy112}" + t + "{\\c" + base + "\\fscx100\\fscy100}")
                    else:
                        parts.append(t)
                anim = "\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)" if k == 0 else ""
                events.append(("Caption", s, e, f"{{\\an5\\pos({PLAY_W // 2},{y}){anim}}}" + " ".join(parts), 2))

    # free text overlays (output time)
    for ov in clip.get("overlays", []) or []:
        t = (ov.get("text") or "").strip()
        if not t:
            continue
        st = ov.get("style", "meme")
        st = st if st in OVERLAY_STYLES else "meme"
        sdef = OVERLAY_STYLES[st]
        x = int(PLAY_W * float(ov.get("x", 0.5)))
        y = int(PLAY_H * float(ov.get("y", 0.3)))
        fs = int(ov.get("size") or sdef["size"])
        s, e = float(ov.get("start", 0)), float(ov.get("end", 0)) or total
        anim = POP_IN if ov.get("anim", "pop") == "pop" else ""
        body = accent_markup(t, sdef["color"], "#FFE600" if st != "pop" else "#FFFFFF")
        events.append((f"Ov_{st}", s, min(e, total),
                       f"{{\\an5\\pos({x},{y})\\fs{fs}\\fad(60,100){anim}}}" + body, 4))

    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {PLAY_W}", f"PlayResY: {PLAY_H}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        *styles, "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for style, s, e, text, layer in events:
        if e - s <= 0.01:
            continue
        lines.append(f"Dialogue: {layer},{ass_time(s)},{ass_time(e)},{style},,0,0,0,,{text}")
    return "\n".join(lines) + "\n"
