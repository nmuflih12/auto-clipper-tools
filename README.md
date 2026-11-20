# Clipper

Tool lokal (Windows) untuk bikin klip vertikal 9:16 dari stream/video panjang untuk campaign clipper: cari momen
seru otomatis, potong, layout facecam + gameplay, caption kata per kata, judul hook, backsound + sound effect, lalu
export lengkap dengan **watermark, banner, bumper in, dan bumper out** sesuai aturan tiap campaign.

Semua jalan di komputer sendiri: GUI di browser (`http://127.0.0.1:5170`), render pakai ffmpeg (GPU NVIDIA kalau
ada), transkrip pakai Whisper (faster-whisper).

## Fitur

- **Sumber video**: file lokal (rekaman layar, download) atau link YouTube (info + grafik *most replayed*, download
  rentang tertentu, atau *scan momen dari audio* untuk stream berjam-jam tanpa download videonya).
- **Deteksi momen**: lonjakan suara, keyword (mis. "anjir", "wkwk"), dan heatmap YouTube.
- **Editor**: timeline dengan waveform, IN/OUT, trim dengan tarik, beberapa potongan per klip, zoom punch/push,
  slow-mo, preview 9:16 live.
- **Layout**: split facecam/gameplay, fit + background blur, atau crop penuh; kotak diatur langsung di video.
- **Teks**: judul hook dengan kata aksen, caption otomatis kata per kata (bisa diedit), teks tambahan bertimer.
- **Audio**: volume suara asli, backsound dengan ducking, sound effect di detik tertentu (ada SFX bawaan).
- **Branding per campaign**: watermark (sepanjang klip), banner (muncul di detik tertentu dengan fade/slide),
  bumper in (sebelum klip), bumper out (sesudah klip). Bumper boleh video atau gambar. Tiap elemen bisa ditandai
  *wajib* supaya checklist export mengingatkan.
- **Multi-campaign**: tiap campaign punya folder sendiri; ganti atau buat campaign baru dari GUI.
- **Checklist export**: elemen wajib, urutan hashtag, checklist manual dari campaign.

## Kebutuhan

- Windows 10/11
- Python 3.11+ (dites di 3.14)
- ffmpeg di PATH (build lengkap dengan libass, mis. `winget install Gyan.FFmpeg`)
- Node.js 22+ (dipakai yt-dlp untuk YouTube)
- Opsional: GPU NVIDIA untuk encode NVENC dan Whisper di CUDA (otomatis fallback ke CPU)

## Mulai

1. Clone repo ini (private, perlu login GitHub):

   ```powershell
   git clone https://github.com/nmuflih12/auto-clipper-tools.git D:\auto-clipper-tools
   ```
2. Klik dua kali `start-clipper.bat`. Pertama kali akan membuat `.venv` dan meng-install dependency
   (`requirements.txt`, termasuk cuBLAS untuk Whisper GPU, ±1 GB).
3. Browser terbuka di http://127.0.0.1:5170. Kalau belum ada campaign, klik **Buat campaign baru**.
   Clipper membuat folder campaign di sebelah folder sebelumnya (atau di sebelah folder tool) berisi:

```
<campaign>/
  campaign.json     setelan campaign (lihat di bawah)
  raw/              taruh video sumber di sini
  downloads/        hasil download YouTube
  assets/           watermark, banner, bumper (upload lewat GUI juga bisa)
    music/          backsound
    sfx/            sound effect (bawaan: boom, whoosh, ding, pop, riser, impact, glitch)
  clips/            hasil edit (JSON per klip)
  exports/          hasil akhir .mp4 + .txt (caption + hashtag)
  work/             cache (proxy, transkrip, analisis) — aman dihapus
```

Buka campaign tertentu langsung: `start-clipper.bat --project "D:\motion-klip\nama-campaign"`.
Daftar campaign yang pernah dibuka disimpan di `local.json` (tidak masuk git).

## Pengaturan campaign

Klik **Pengaturan campaign** di bar atas: nama, hashtag wajib (urutan dipakai apa adanya), FPS, bahasa transkrip,
checklist, keyword momen, dan empat elemen branding. File bisa dipilih dari `assets/` atau di-upload.

| Elemen | Bentuk | Posisi | Catatan |
| --- | --- | --- | --- |
| Watermark | gambar (PNG transparan) | x, y, lebar, opasitas | tampil sepanjang klip, paling atas |
| Banner | gambar | x, y, lebar, opasitas | muncul di detik `start` selama `duration` (0 = sampai akhir), animasi `fade`/`slide`/`none` |
| Bumper in | video atau gambar | full frame | diputar sebelum klip; gambar tampil `image_duration` detik |
| Bumper out | video atau gambar | full frame | diputar sesudah klip; ditempel utuh, hanya disesuaikan ke 9:16 |

Watermark dan banner hanya menimpa bagian klip, tidak menimpa bumper. Backsound juga berhenti sebelum bumper out.
Per klip, tiap elemen bisa dimatikan di tab **Export**, dan watermark bisa digeser khusus untuk klip itu.

Contoh `campaign.json`:

```json
{
  "name": "Nama Campaign",
  "hashtags": ["#tag1", "#tag2"],
  "watermark": {"enabled": true, "required": true, "path": "assets/watermark.png", "x": 0.5, "y": 0.5, "w": 1.0, "opacity": 1.0},
  "banner": {"enabled": true, "required": false, "path": "assets/banner.png", "x": 0.5, "y": 0.12, "w": 0.9,
             "opacity": 1.0, "start": 0, "duration": 5, "anim": "slide"},
  "bumper_in": {"enabled": false, "required": false, "path": "", "image_duration": 2.0},
  "bumper_out": {"enabled": true, "required": true, "path": "assets/outro.mp4", "image_duration": 3.0},
  "output": {"width": 1080, "height": 1920, "fps": 30},
  "language": "id",
  "whisper_prompt": "nama streamer, istilah game",
  "keywords": ["anjir", "wkwk", "gila"],
  "allowed_channels": ["@namachannel"],
  "checklist": ["Isi klip sesuai brief"]
}
```

Posisi `x`/`y` adalah titik tengah gambar (0–1 relatif ke frame 1080×1920), `w` lebar relatif. Template watermark
yang sudah full-frame 9:16 cukup `x 0.5, y 0.5, w 1.0`. File campaign lama dengan `outro` otomatis dibaca sebagai
`bumper_out`.

## Pemakaian singkat

1. Pilih video di panel kiri → **Siapkan video** → **Transkrip (Whisper)**.
2. Tab **Momen**: Putar → **Klip baru** / **+ ke klip**, atau `I`, `O`, `Enter`.
3. Panel kanan: tab Potongan, Layout, Teks, Audio, Export; **Putar klip** untuk preview urut termasuk bumper.
4. **Render draft** (540×960 cepat) lalu **Export final** (1080×1920) → `exports/`.

Shortcut: `Spasi` play/pause · `←/→` ±1 dtk (`Shift` ±0.1) · `J/L` ±5 dtk · `I/O` · `Enter` · `P` putar klip.

## CLI

```powershell
# render klip (dari folder tool), --project = folder campaign
.venv\Scripts\python render.py "D:\campaign\clips\<id>.json" --project "D:\campaign"
.venv\Scripts\python render.py "D:\campaign\clips\<id>.json" --project "D:\campaign" --draft
# transkrip manual
.venv\Scripts\python transcribe.py input.mp4 transcript.json --lang id
# bikin ulang SFX/beat bawaan ke folder assets campaign
.venv\Scripts\python make_sfx.py --out "D:\campaign\assets"
```

Format klip JSON dan API lengkap ada di [AGENTS.md](AGENTS.md).

## Struktur kode

| File | Isi |
| --- | --- |
| `app.py` | server Flask, API JSON, antrian job, pengaturan + pemilih campaign, upload asset |
| `common.py` | path campaign, `campaign.json` (+ migrasi format lama), `branding_for()`, ffprobe, runner ffmpeg |
| `analyze.py` | proxy preview, loudness, deteksi bar hitam, layout default, deteksi momen |
| `transcribe.py` | faster-whisper (proses terpisah, GPU/CPU) |
| `captions.py` | pemetaan waktu, chunk caption, file ASS (hook, caption, teks) |
| `render.py` | filtergraph ffmpeg: layout + zoom → teks → banner → watermark → audio → bumper |
| `youtube.py` | yt-dlp: info, heatmap, download rentang/penuh, download audio untuk scan |
| `make_sfx.py` | SFX dan contoh beat sintesis (bebas hak cipta) |
| `static/` | UI (HTML/CSS/JS tanpa build step) |

## Catatan

- Musik berhak cipta bisa membuat video di-mute/diklaim platform. Pakai bahan bebas royalti.
- Emoji di teks video dirender monokrom oleh libass.
- YouTube kadang minta login ("confirm you're not a bot"); yt-dlp perlu cookies, belum ada tombolnya di GUI.
- Server hanya mendengarkan `127.0.0.1` (tidak bisa diakses dari jaringan).
