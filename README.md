<p align="center">
  <img src="logo.png" alt="SambasKu" width="320" />
</p>

# SambasKu Database (public dataset)

Repositori **publik** untuk **artifact kamus offline** aplikasi
**SambasKu** (Kamus Digital Sambas-Indonesia).

Ini **bukan** production database Turso, **bukan** backup akun, dan
**bukan** tempat menyimpan token. Hanya salinan sanitasi korpus
`published` yang boleh diunduh klien (mobile / kelak web) lewat HTTPS.

## Apa isi repo ini?

| Ada di git | Tidak di git (Release assets) |
| --- | --- |
| README, LICENSE, logo | `database.sqlite.gz` |
| `schema/` (kontrak DDL / allowlist) | `manifest.json` |
| `metadata/active.json` (pointer rilis aktif) | `SHA256SUMS` |

```text
database/
├── README.md
├── LICENSE
├── logo.png
├── package.json
├── scripts/               # export + validate
├── schema/
│   ├── v1.md              # kontrak schema_version = 1
│   └── QUESTIONS.md       # pertanyaan yang harus dikunci sebelum export
├── metadata/
│   ├── active.example.json
│   └── active.json        # diisi saat Release v1 hidup
└── (GitHub Release tag vN)
    ├── database.sqlite.gz
    ├── manifest.json
    └── SHA256SUMS
```

## Source of truth

```text
Production DB (privat, Turso)
        │  export allowlist (`scripts/` + secrets / .env lokal)
        ▼
GitHub Release di repo ini (imutabel per vN)
        │  HTTPS
        ▼
SQLite di perangkat (replica lokal)
```

Arah panah **satu arah**. Repo ini tidak pernah mengisi production.

## URL stabil (setelah Release v1)

Pointer aktif (mudah rollback tanpa menghapus tag lama):

```text
https://raw.githubusercontent.com/sambasku/database/main/metadata/active.json
```

Asset per rilis (contoh):

```text
https://github.com/sambasku/database/releases/download/v1/manifest.json
https://github.com/sambasku/database/releases/download/v1/database.sqlite.gz
https://github.com/sambasku/database/releases/download/v1/SHA256SUMS
```

Klien memverifikasi **sha256** di manifest sebelum mengganti DB lokal.
Gagal verify = tetap pakai DB lama.

## Siapa yang menulis ke sini?

| Aktor | Cara |
| --- | --- |
| Pipeline export (**Fase DS**) | `scripts/` di repo ini → buat GitHub Release + update `active.json` |
| Manusia / admin (Fase D) | Console / CLI memicu pipeline yang sama |
| Mobile / web publik | **Hanya unduh** HTTPS - tanpa token DB |

Fine-grained PAT (Contents / Releases write) hanya di **CI monorepo
privat**, bukan di app klien.

## Yang tidak dilakukan di repo ini

- Tidak menyimpan tabel `users`, email, password, session, OTP, token
- Tidak menyimpan kontribusi pending, audit, vote, bookmark, inbox
- Tidak commit file `.sqlite` / `.gz` ke branch `main` (lihat `.gitignore`)
- Tidak menyamakan "Release dataset" dengan "Backup production"
- Tidak menerima koneksi Turso dari HP / browser publik

## Schema & evolusi

- Kontrak saat ini: [`schema/v1.md`](schema/v1.md)
- Pertanyaan yang harus dikunci: [`schema/QUESTIONS.md`](schema/QUESTIONS.md)
- Naik `schema_version` hanya jika breaking; app lama menolak artifact
  baru lewat `min_app_version` / cek schema, tetap di DB lama

## Status Fase DS (sebelum mobile SQLite)

| Langkah | Status |
| --- | --- |
| Repo publik + README | **Ada** |
| Schema v1 dikunci | **Ya** - `schema/v1.md` + `QUESTIONS.md` |
| Script export | **`scripts/` di repo ini** - `pnpm dataset:export` |
| Tes validate (forbidden cols) | **Ada** - `pnpm test` |
| Actions Release | **Ada** - `workflow_dispatch` `export-release.yml` |
| Release v1 + `active.json` | **Release v1 hidup**; push scripts + workflow ke `main`, lalu re-run export berisi data |
| **Fase B** Mobile consume | **Ditunda** sampai DS hijau |

### Menjalankan export (maintainer)

Dari folder root repo ini (butuh `DATABASE_URL` staging):

```bash
cp .env.example .env   # isi DATABASE_URL + DATABASE_AUTH_TOKEN
pnpm install
pnpm dataset:export
# output: tmp/dataset-export/
#   database.sqlite
#   database.sqlite.gz
#   manifest.json
#   SHA256SUMS
```

Env opsional: `DATASET_RELEASE_VERSION`, `DATASET_CHANNEL`, `DATASET_OUT_DIR`,
`DATASET_MIN_APP_VERSION`.

Secret Turso: lokal di `.env` (gitignored); CI di GitHub Actions
**secrets** repo ini. Jangan commit token.

### GitHub Actions (Release)

Workflow: [`.github/workflows/export-release.yml`](.github/workflows/export-release.yml)
(`workflow_dispatch`).

1. Set secrets di repo ini:
   - `DATABASE_URL` - `libsql://…` (staging dulu)
   - `DATABASE_AUTH_TOKEN`
2. Actions → **Export & Release Dataset** → Run workflow
3. Pilih `channel`, opsional `release_version` (kosong = active+1)
4. `dry_run=true` untuk test export tanpa Release/commit

Job akan: `pnpm test` → export → (skip jika sha sama) → GitHub Release
`vN` + update `metadata/active.json`.

Setelah artifact siap (CLI atau Actions), pointer aktif ada di
`metadata/active.json`.

## Lisensi

Lihat [LICENSE](LICENSE). Isi korpus bahasa (lemma, arti, contoh) mengikuti
kebijakan editorial SambasKu; artifact teknis di repo ini memakai lisensi
repo kecuali dinyatakan lain di Release notes.
