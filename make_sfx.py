"""Synthesize the built-in sound effects and sample beats (no samples, no copyright).

usage: python clipper/make_sfx.py [--out assets]   -> assets/sfx/*.wav, assets/music/*.wav
Files are only written when missing (use --force to rebuild).
"""
import argparse
import wave
from pathlib import Path

import numpy as np

SR = 48000
rng = np.random.default_rng(7)


def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def sweep(f0, f1, dur, curve="exp"):
    """Sine with a pitch glide; phase is integrated so the glide is smooth."""
    t = t_axis(dur)
    if curve == "exp":
        f = f0 * (f1 / f0) ** (t / dur)
    else:
        f = f0 + (f1 - f0) * t / dur
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def env_ad(n, attack, decay_rate):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t * decay_rate)


def one_pole_lp(x, cutoff):
    """Low-pass with a per-sample cutoff (array or float)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=np.float64), x.shape)
    a = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def hp(x, cutoff):
    return x - one_pole_lp(x, cutoff)


def soft_clip(x, drive=2.0):
    return np.tanh(drive * x) / np.tanh(drive)


def normalize(x, peak_db=-1.0):
    m = np.max(np.abs(x)) or 1.0
    return x / m * 10 ** (peak_db / 20)


def fade_tail(x, ms=15):
    n = int(SR * ms / 1000)
    if n and len(x) > n:
        x[-n:] *= np.linspace(1, 0, n)
    return x


def write_wav(path, mono_or_stereo):
    x = np.asarray(mono_or_stereo, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- sound effects

def sfx_boom():
    dur = 1.4
    t = t_axis(dur)
    f = 38 + 70 * np.exp(-t * 2.2)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(len(t), 0.004, 2.6)
    click = one_pole_lp(rng.standard_normal(len(t)), 2500) * env_ad(len(t), 0.0005, 90) * 0.6
    return fade_tail(normalize(soft_clip(body + click, 2.6)))


def sfx_whoosh():
    dur = 0.75
    t = t_axis(dur)
    shape = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    cutoff = 400 + 5000 * shape
    noise = rng.standard_normal(len(t))
    x = hp(one_pole_lp(noise, cutoff), 250) * shape
    pan = 0.5 + 0.45 * np.sin(np.pi * (t / dur - 0.5))  # moves left -> right
    st = np.stack([x * (1 - pan) * 1.4, x * pan * 1.4], axis=1)
    return normalize(st, -2)


def sfx_ding():
    dur = 1.8
    t = t_axis(dur)
    x = np.zeros_like(t)
    for f, a, d in ((1318.5, 1.0, 2.6), (2637.0, 0.35, 4.0), (3955.5, 0.12, 6.0), (1975.5, 0.18, 3.2)):
        x += a * np.sin(2 * np.pi * f * t) * env_ad(len(t), 0.002, d)
    return fade_tail(normalize(x, -2))


def sfx_pop():
    dur = 0.14
    x = sweep(950, 170, dur) * env_ad(int(SR * dur), 0.001, 38)
    x += one_pole_lp(rng.standard_normal(len(x)), 3000) * env_ad(len(x), 0.0005, 120) * 0.25
    return fade_tail(normalize(x, -2), 5)


def sfx_riser():
    dur = 2.2
    t = t_axis(dur)
    ramp = (t / dur) ** 2
    noise = one_pole_lp(rng.standard_normal(len(t)), 200 + 7000 * ramp)
    tone = sweep(180, 1400, dur) * 0.35 + sweep(181.5, 1404, dur) * 0.35
    x = (hp(noise, 150) * 0.9 + tone) * ramp
    return fade_tail(normalize(x, -2), 25)


def sfx_impact():
    dur = 1.0
    t = t_axis(dur)
    thump = np.sin(2 * np.pi * np.cumsum(45 + 90 * np.exp(-t * 18)) / SR) * env_ad(len(t), 0.002, 7)
    crash = one_pole_lp(rng.standard_normal(len(t)), 6000) * env_ad(len(t), 0.001, 5.5) * 0.7
    return fade_tail(normalize(soft_clip(thump + crash, 1.8), -1))


def sfx_glitch():
    dur = 0.5
    n = int(SR * dur)
    x = np.zeros(n)
    pos = 0
    while pos < n:
        seg = int(SR * rng.uniform(0.015, 0.05))
        kind = rng.integers(0, 3)
        tt = np.arange(seg) / SR
        if kind == 0:
            chunk = np.sign(np.sin(2 * np.pi * rng.uniform(200, 1800) * tt)) * 0.5
        elif kind == 1:
            chunk = rng.standard_normal(seg) * 0.4
        else:
            chunk = np.zeros(seg)
        x[pos:pos + seg] = chunk[: n - pos]
        pos += seg
    return fade_tail(normalize(one_pole_lp(x, 7000), -4), 10)


SFX = {
    "boom": sfx_boom, "whoosh": sfx_whoosh, "ding": sfx_ding, "pop": sfx_pop,
    "riser": sfx_riser, "impact": sfx_impact, "glitch": sfx_glitch,
}


# ---------------------------------------------------------------- sample beats

def kick(n_dur=0.45):
    t = t_axis(n_dur)
    return soft_clip(np.sin(2 * np.pi * np.cumsum(45 + 110 * np.exp(-t * 30)) / SR) * env_ad(len(t), 0.001, 9), 1.5)


def snare(n_dur=0.3):
    t = t_axis(n_dur)
    tone = np.sin(2 * np.pi * 185 * t) * env_ad(len(t), 0.001, 25) * 0.5
    noise = hp(one_pole_lp(rng.standard_normal(len(t)), 6000), 900) * env_ad(len(t), 0.001, 16)
    return tone + noise


def hat(n_dur=0.06, open_=False):
    t = t_axis(0.25 if open_ else n_dur)
    return hp(rng.standard_normal(len(t)), 7000) * env_ad(len(t), 0.0005, 12 if open_ else 70) * 0.35


def note(freq, dur, kind="sine", decay=3.0, attack=0.005):
    t = t_axis(dur)
    if kind == "saw":
        x = 2 * ((freq * t) % 1) - 1
        x = one_pole_lp(x, 900)
    elif kind == "pluck":
        x = np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * 2 * freq * t) + 0.2 * np.sin(2 * np.pi * 3 * freq * t)
    else:
        x = np.sin(2 * np.pi * freq * t)
    return x * env_ad(len(t), attack, decay)


def place(buf, sig, at_s, gain=1.0):
    i = int(at_s * SR)
    j = min(len(buf), i + len(sig))
    if j > i:
        buf[i:j] += sig[: j - i] * gain


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def beat(bpm, chords, bars_per_chord=1, swing=0.0, hats=8, bass_kind="sine", lead="pad", kick_pattern=(0, 2)):
    beat_s = 60 / bpm
    bar_s = beat_s * 4
    total = bar_s * bars_per_chord * len(chords)
    drums = np.zeros(int(total * SR) + SR)
    music = np.zeros_like(drums)
    for ci, chord in enumerate(chords):
        for b in range(bars_per_chord):
            bar0 = (ci * bars_per_chord + b) * bar_s
            for k in kick_pattern:
                place(drums, kick(), bar0 + k * beat_s, 0.9)
            for s in (1, 3):
                place(drums, snare(), bar0 + s * beat_s, 0.55)
            step = 4 / hats
            for h in range(hats):
                at = bar0 + h * step * beat_s
                if h % 2 == 1:
                    at += swing * step * beat_s
                place(drums, hat(open_=(h == hats - 1)), at, 0.5 if h % 2 else 0.35)
            root = midi(chord[0] - 24)
            for e in range(8):
                place(music, note(root, beat_s * 0.48, bass_kind, decay=4), bar0 + e * beat_s / 2, 0.45)
            if lead == "pad":
                for m in chord:
                    place(music, note(midi(m), bar_s, "sine", decay=0.6, attack=0.25), bar0, 0.12)
            else:
                arp = list(chord) + [chord[0] + 12]
                for e in range(8):
                    place(music, note(midi(arp[e % len(arp)] + 12), beat_s * 0.45, "pluck", decay=9), bar0 + e * beat_s / 2, 0.16)
    n = int(total * SR)
    mix = soft_clip(drums[:n] * 0.8 + music[:n], 1.2)
    # tiny crossfade so the loop point does not click
    xf = int(0.01 * SR)
    mix[:xf] *= np.linspace(0, 1, xf)
    mix[-xf:] *= np.linspace(1, 0, xf)
    return normalize(mix, -3)


MUSIC = {
    # Am F C G, relaxed with swing
    "contoh-beat-santai": lambda: beat(90, [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)],
                                       bars_per_chord=1, swing=0.18, hats=8, lead="pad"),
    # Dm Bb Gm A, driving 16th hats and plucked arpeggio
    "contoh-beat-tegang": lambda: beat(128, [(62, 65, 69), (58, 62, 65), (55, 58, 62), (57, 61, 64)],
                                       bars_per_chord=1, hats=16, bass_kind="saw", lead="pluck", kick_pattern=(0, 1, 2, 3)),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "assets"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    for name, fn in SFX.items():
        p = out / "sfx" / f"{name}.wav"
        if a.force or not p.exists():
            write_wav(p, fn())
            print("sfx  ", p)
    for name, fn in MUSIC.items():
        p = out / "music" / f"{name}.wav"
        if a.force or not p.exists():
            write_wav(p, fn())
            print("music", p)


if __name__ == "__main__":
    main()
