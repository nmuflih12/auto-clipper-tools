# Clipper — instruksi untuk AI agent

Baca [README.md](README.md) dulu untuk gambaran tool. File ini untuk agent (Claude, Codex, Cursor, Gemini, dll)
yang mengubah kode atau membuat klip lewat file/CLI.

## Konsep

- **Tool** = repo ini (kode, tanpa data campaign). **Campaign** = folder terpisah berisi `campaign.json`, `raw/`,
  `assets/`, `clips/`, `exports/`, `work/`. Semua path di klip/campaign relatif ke folder campaign.
- Server memegang satu campaign aktif (`common.set_project`). Semua path lewat `P()` / `resolve()` / `rel()`.
- Branding: `watermark`, `banner` (overlay gambar), `bumper_in`, `bumper_out` (video/gambar di luar klip).
  Nilai efektif per klip = `common.branding_for(clip, campaign, key)`; JS punya cermin di `brandFor()`.

## Format klip (`<campaign>/clips/<id>.json`)

Waktu potongan dalam **detik video sumber**; `overlays[].start/end` dan `sfx[].at` dalam **detik output** (tanpa
bumper in). Kotak layout dinormalisasi 0–1 terhadap frame sumber yang sudah dirotasi.

```json
{
  "id": "contoh-klip", "title": "Contoh", "source": "raw/video.mp4", "source_id": "video",
  "segments": [{"start": 12.0, "end": 24.5, "zoom": "punch", "speed": 1}],
  "layout": {"mode": "split", "split_ratio": 0.4, "cam_top": true,
             "cam": {"x": 0.71, "y": 0.70, "w": 0.19, "h": 0.30}, "game": {"x": 0.28, "y": 0, "w": 0.43, "h": 1},
             "crop": {"x": 0.37, "y": 0, "w": 0.26, "h": 1}, "content": {"x": 0.09, "y": 0, "w": 0.82, "h": 1},
             "fit_zoom": 1.0, "fit_y": 0.5, "bg": "blur"},
  "hook": {"text": "JUDUL *AKSEN*", "style": "box-white", "y": 0.4, "duration": 0},
  "captions": {"enabled": true, "style": "pop", "y": 0.63, "words_per_chunk": 3, "uppercase": true,
               "highlight": "#FFE600", "overrides": {"13.42": "ANJIR"}},
  "overlays": [{"text": "NGAKAK", "start": 6.0, "end": 8.0, "style": "pop", "x": 0.5, "y": 0.3}],
  "watermark": {"enabled": true, "x": 0.5, "y": 0.5},
  "banner": {"enabled": false},
  "bumper_in": true,
  "bumper_out": true,
  "voice_volume": 1.0,
  "music": {"path": "assets/music/lagu.mp3", "volume": 0.15, "start": 0, "fade_in": 0.5, "fade_out": 1.0, "duck": true},
  "sfx": [{"path": "assets/sfx/boom.wav", "at": 2.0, "volume": 1.0}],
  "loudnorm": true, "fps": 30,
  "post_caption": "caption postingan\n\n#tag1 #tag2"
}
```

- Branding per klip: kunci tidak ada = ikut campaign; `true/false` (bumper) atau `{"enabled": ...}` (overlay) untuk
  menimpa. Klip lama dengan `"outro": false` dibaca sebagai `bumper_out: false`.
- Gaya: hook `box-white | box-red | box-black | outline`; caption `pop | neon | clean | meme`;
  overlay `meme | pop | box | red` (lihat `captions.py`).

## Perintah

```powershell
.venv\Scripts\python render.py <campaign>\clips\<id>.json --project <campaign> [--draft]
.venv\Scripts\python app.py --project <campaign> --no-browser   # server di http://127.0.0.1:5170
```

API: `GET /api/state`, `GET|PUT /api/campaign`, `POST /api/assets/upload` (multipart `file`),
`GET /api/projects`, `POST /api/projects/switch {path}`, `POST /api/projects/new {name, parent?}`,
`GET /api/sources/<sid>`, `POST /api/sources/<sid>/prepare|transcribe|candidates`, `GET|PUT|DELETE /api/clips/<id>`,
`POST /api/clips {source_id, segments, title}`, `POST /api/clips/<id>/render {quality: draft|final}`,
`GET /api/jobs`, `POST /api/youtube/info|download|scan`, `GET /api/audio`.

## Aturan kerja

- Setelah mengubah Python, restart server; perubahan `static/` cukup reload browser.
- Cek hasil render dari frame asli (`ffmpeg -ss 3 -i out.mp4 -frames:v 1 cek.jpg`), bukan hanya dari kode.
- Urutan render jangan diubah tanpa alasan: teks (ASS) → banner → watermark di bagian klip; bumper di-concat utuh
  di luar klip; backsound/SFX hanya di bagian klip.
- Jangan commit data campaign (video, asset campaign, klip, export) ke repo ini; `local.json` dan `.venv` diabaikan.
- Jangan upload/posting ke platform atau submit form atas nama user.
- Windows: `python3` bawaan bisa jadi shortcut Microsoft Store; pakai `.venv\Scripts\python`.
