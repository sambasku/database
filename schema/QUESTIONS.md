# Pertanyaan matang sebelum export v1 (**Fase DS**)

Status: **dikunci 2026-09-26** (default plan DS; override hanya via PR).
**Fase B (Flutter SQLite) tidak dimulai** sampai gate DS hijau.



Legenda: `[x]` dikunci.

---

## A. Ruang lingkup & identitas artifact

1. [x] **Repo:** `sambasku/database` = satu-satunya sumber publik dataset
   (bukan monorepo, bukan backup).
2. [x] **Sumber export pertama:** **staging**. Production belakangan
   (channel sama / Release berikutnya setelah siap).
3. [x] **Lisensi:** MIT di root cukup untuk v1; notice data bisa menyusul
   di README bila legal minta.
4. [x] **Trigger Release DS:** maintainer CLI / `workflow_dispatch` saja.
   Console = Fase D.

---

## B. Tabel: boleh masuk / tidak

5. [x] Allowlist `v1.md` cukup untuk search + detail + list A-Z v1.
6. [x] Count sosial / vote / komentar: **tetap API** (bukan snapshot).
7. [x] `discussions` **permanen di luar** dataset (API + L1).
8. [x] Referensi (`languages`, `dialects`, `word_classes`, `categories`):
   export **semua baris aktif** (`deleted_at IS NULL`).

---

## C. Kolom & PII (termasuk users)

9. [x] **`users`:** **Tidak** diekspor (tabel penuh).
10. [x] Atribusi offline: **(A) kosong** di L2 (tanpa "dibuat oleh").
11. [x] N/A (karena A).
12. [x] Semua FK `*_by` **strip**.
13. [x] Metadata takedown / soft-delete **strip** (baris sudah di-filter).
14. [x] `notes` pada words/meanings/examples: **ikut** (anggap publik).
15. [x] `lemma_allows_comma` / `translation_allows_comma`: **tidak** masuk L2.
16. [x] Images/audios: **`url` + metadata tampilan**; `provider` /
    `provider_file_id` / `sha` **tidak** masuk.

---

## D. Filter baris & status anak

17. [x] Anak: `status = 'published'` + `deleted_at IS NULL` (jika kolom ada).
18. [x] Meaning placeholder (`-` / `is_have_definition = false`): **tetap masuk**.
19. [x] Relasi: kedua ujung published; lag takedown sampai release berikutnya = **OK**.
20. [x] Browse A-Z filter `kasar`/`diskriminatif`: di **query konsumen**
    (Fase B); export tetap full published.

---

## E. FTS & parity search

21. [x] Tokenizer FTS5: **`unicode61`**.
22. [x] Kolom FTS: **lemma + variant forms + translation text** (bukan
    definition/examples di v1).
23. [x] Search lokal v1: **FTS** (kontrak); hybrid LIKE boleh ditambah di B
    bila parity kurang.
24. [x] Ranking lokal boleh beda dari API di v1 (dokumentasikan).
25. [x] `matched_variant` / `matched_translation`: **wajib diusahakan**
    parity di konsumen B; export cukup data sumber (variants + translations).

---

## F. Evolusi schema

26. [x] Kolom non-breaking (nullable): tetap `schema_version = 1` + release data.
27. [x] Breaking (wajib/rename/hapus): naik `schema_version` + `min_app_version`.
28. [x] Tabel baru production: default **tidak masuk** sampai allowlist + tes.
29. [x] App lama tolak schema lebih tinggi: copy **"Perbarui aplikasi"** (Fase B);
    diam di DB lama sampai update.
30. [x] Device: **selalu full replace** (bukan ALTER).

---

## G. Rilis, ukuran, frekuensi

31. [x] Pointer: **`metadata/active.json`**.
32. [x] Gzip > ~12 MB: **warning saja**, boleh lanjut.
33. [x] SLA: **on-demand** (maintainer); sensitif takedown = release segera.
34. [x] Sha256 sama dengan aktif: **jangan** buat Release baru.
35. [x] Satu repo; field opsional `channel` di manifest nanti bila perlu
    (v1 = staging dulu).

---

## H. Keamanan & anti-pola

36. [x] Tes forbidden wajib. Assert minimal: tabel `users`,
   `auth_identities`, `refresh_tokens`, `contributions`, `audit_logs`,
   `votes`, `comments`, `bookmarks`, `discussions`; kolom
   `created_by`, `updated_by`, `deleted_by`, `verified_by`,
   `taken_down_by`, `takedown_reason_code`, `takedown_note`,
   `password_hash`, `email`.
37. [x] Larangan keras sudah di README; CODEOWNERS opsional menyusul.
38. [x] Search-miss analytics: hanya jalur remote (kontrak B).

---

## I. Hybrid A & konsumsi (kontrak B, dikunci di DS)

39. [x] Hybrid A tetap (search CTA; feed/deep-link remote-once + badge).
40. [x] Remote-once **tidak** ditulis ke file SQLite release.
41. [x] First-run B: URL dari
    `https://raw.githubusercontent.com/sambasku/database/main/metadata/active.json`

---

## Ringkas jawaban

| # | Jawaban |
| --- | --- |
| 1-4 | Repo `database`; staging dulu; MIT; CLI trigger |
| 5-8 | Allowlist v1; sosial/TH = API; ref = semua aktif |
| 9-16 | No users; atribusi kosong; strip `*_by`/takedown; no comma flags; media URL only |
| 17-20 | Child published; placeholder OK; browse filter di konsumen |
| 21-25 | unicode61; lemma+variant+translation; ranking beda OK |
| 26-30 | Non-breaking = v1; breaking naik schema; full replace |
| 31-35 | active.json; warning ukuran; on-demand; skip bila sha sama |
| 36-41 | Tes forbidden; Hybrid A kontrak; active.json raw URL |
