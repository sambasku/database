import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { createClient, type Client, type InArgs, type Row } from '@libsql/client';

import { PUBLIC_SCHEMA_DDL, PUBLIC_SCHEMA_VERSION } from './public-schema-v1.ts';
import { validatePublicDb } from './validate-public-db.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

loadEnv({ path: resolve(ROOT, '.env') });

export type ExportOptions = {
  source: Client;
  outDir: string;
  releaseVersion: number;
  channel?: string;
  minAppVersion?: string;
};

export type ExportArtifacts = {
  sqlitePath: string;
  gzipPath: string;
  manifestPath: string;
  sha256SumsPath: string;
  sha256: string;
  size: number;
  wordCount: number;
};

function log(msg: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[dataset:export] ${msg}`, extra);
  } else {
    console.log(`[dataset:export] ${msg}`);
  }
}

function warn(msg: string): void {
  console.warn(`[dataset:export] WARN ${msg}`);
}

function toUnix(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return toUnix(n);
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return Math.floor(d / 1000);
  }
  return null;
}

function toBoolInt(v: unknown): number {
  if (v === true || v === 1 || v === '1') return 1;
  return 0;
}

function toJsonText(v: unknown): string {
  if (v == null) return '[]';
  if (typeof v === 'string') {
    try {
      JSON.parse(v);
      return v;
    } catch {
      return JSON.stringify(v);
    }
  }
  return JSON.stringify(v);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

async function insertMany(client: Client, sqlText: string, rows: InArgs[]): Promise<void> {
  if (rows.length === 0) return;
  const statements = rows.map((args) => ({ sql: sqlText, args }));
  for (const part of chunk(statements, 200)) {
    await client.batch(part, 'write');
  }
}

async function selectAll(source: Client, sql: string, args: InArgs = []): Promise<Row[]> {
  const result = await source.execute({ sql, args });
  return result.rows;
}

async function selectInChunks(
  source: Client,
  buildSql: (ph: string) => string,
  ids: string[],
  chunkSize = 400,
): Promise<Row[]> {
  const all: Row[] = [];
  for (const part of chunk(ids, chunkSize)) {
    if (part.length === 0) continue;
    const rows = await selectAll(source, buildSql(placeholders(part.length)), part);
    all.push(...rows);
  }
  return all;
}

/**
 * Export korpus published → SQLite publik + FTS + gzip + manifest.
 */
export async function exportPublishedDataset(
  options: ExportOptions,
): Promise<ExportArtifacts> {
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });

  const sqlitePath = join(outDir, 'database.sqlite');
  const gzipPath = join(outDir, 'database.sqlite.gz');
  const manifestPath = join(outDir, 'manifest.json');
  const sha256SumsPath = join(outDir, 'SHA256SUMS');

  await rm(sqlitePath, { force: true });
  await rm(gzipPath, { force: true });

  const out = createClient({ url: `file:${sqlitePath}` });
  await out.executeMultiple(PUBLIC_SCHEMA_DDL);

  const { source } = options;

  const languageRows = await selectAll(
    source,
    `SELECT id, code, name, native_name, description, is_active
     FROM languages WHERE deleted_at IS NULL`,
  );
  await insertMany(
    out,
    `INSERT INTO languages (id, code, name, native_name, description, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    languageRows.map((r) => [
      r.id,
      r.code,
      r.name,
      r.native_name,
      r.description,
      toBoolInt(r.is_active),
    ]),
  );

  const dialectRows = await selectAll(
    source,
    `SELECT id, language_id, code, name, description, is_active, is_default
     FROM dialects WHERE deleted_at IS NULL`,
  );
  await insertMany(
    out,
    `INSERT INTO dialects (id, language_id, code, name, description, is_active, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    dialectRows.map((r) => [
      r.id,
      r.language_id,
      r.code,
      r.name,
      r.description,
      toBoolInt(r.is_active),
      toBoolInt(r.is_default),
    ]),
  );

  const wordClassRows = await selectAll(
    source,
    `SELECT id, parent_id, code, name, alias, description
     FROM word_classes WHERE deleted_at IS NULL`,
  );
  await insertMany(
    out,
    `INSERT INTO word_classes (id, parent_id, code, name, alias, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
    wordClassRows.map((r) => [r.id, r.parent_id, r.code, r.name, r.alias, r.description]),
  );

  const categoryRows = await selectAll(
    source,
    `SELECT id, parent_id, name, description FROM categories WHERE deleted_at IS NULL`,
  );
  await insertMany(
    out,
    `INSERT INTO categories (id, parent_id, name, description) VALUES (?, ?, ?, ?)`,
    categoryRows.map((r) => [r.id, r.parent_id, r.name, r.description]),
  );

  const wordRows = await selectAll(
    source,
    `SELECT id, language_id, lemma, notes, word_type, usage_labels, status,
            is_verified, verified_at, is_corrected, created_at, updated_at
     FROM words
     WHERE status = 'published' AND deleted_at IS NULL`,
  );
  const wordIds = wordRows.map((w) => String(w.id));

  await insertMany(
    out,
    `INSERT INTO words (
      id, language_id, lemma, notes, word_type, usage_labels, status,
      is_verified, verified_at, is_corrected, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    wordRows.map((r) => [
      r.id,
      r.language_id,
      r.lemma,
      r.notes,
      r.word_type,
      toJsonText(r.usage_labels),
      r.status,
      toBoolInt(r.is_verified),
      toUnix(r.verified_at),
      toBoolInt(r.is_corrected),
      toUnix(r.created_at) ?? 0,
      toUnix(r.updated_at),
    ]),
  );

  if (wordIds.length === 0) {
    warn('0 kata published - artifact tetap dibuat');
  }

  const meaningAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, word_id, word_class_id, inherited_from_meaning_id, definition,
              is_have_definition, is_have_translation, order_index, notes, status,
              is_verified, is_corrected
       FROM meanings
       WHERE word_id IN (${ph}) AND status = 'published' AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO meanings (
      id, word_id, word_class_id, inherited_from_meaning_id, definition,
      is_have_definition, is_have_translation, order_index, notes, status,
      is_verified, is_corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    meaningAll.map((r) => [
      r.id,
      r.word_id,
      r.word_class_id,
      r.inherited_from_meaning_id,
      r.definition,
      toBoolInt(r.is_have_definition),
      toBoolInt(r.is_have_translation),
      r.order_index,
      r.notes,
      r.status,
      toBoolInt(r.is_verified),
      toBoolInt(r.is_corrected),
    ]),
  );

  const meaningIds = meaningAll.map((m) => String(m.id));

  const translationAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, meaning_id, language_id, translation_text, translation_type, notes
       FROM meaning_translations
       WHERE meaning_id IN (${ph}) AND deleted_at IS NULL`,
    meaningIds,
  );

  await insertMany(
    out,
    `INSERT INTO meaning_translations (
      id, meaning_id, language_id, translation_text, translation_type, notes
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    translationAll.map((r) => [
      r.id,
      r.meaning_id,
      r.language_id,
      r.translation_text,
      r.translation_type,
      r.notes,
    ]),
  );

  const exampleAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, meaning_id, source_language_id, source_sentence, target_language_id,
              target_sentence, source_type, source_reference, notes, status,
              is_verified, is_corrected
       FROM examples
       WHERE meaning_id IN (${ph}) AND status = 'published' AND deleted_at IS NULL`,
    meaningIds,
  );

  await insertMany(
    out,
    `INSERT INTO examples (
      id, meaning_id, source_language_id, source_sentence, target_language_id,
      target_sentence, source_type, source_reference, notes, status,
      is_verified, is_corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    exampleAll.map((r) => [
      r.id,
      r.meaning_id,
      r.source_language_id,
      r.source_sentence,
      r.target_language_id,
      r.target_sentence,
      r.source_type,
      r.source_reference,
      r.notes,
      r.status,
      toBoolInt(r.is_verified),
      toBoolInt(r.is_corrected),
    ]),
  );

  const variantAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, word_id, form, variant_type, affix_type, affix_value, dialect_id, notes
       FROM word_variants
       WHERE word_id IN (${ph}) AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO word_variants (
      id, word_id, form, variant_type, affix_type, affix_value, dialect_id, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    variantAll.map((r) => [
      r.id,
      r.word_id,
      r.form,
      r.variant_type,
      r.affix_type,
      r.affix_value,
      r.dialect_id,
      r.notes,
    ]),
  );

  const wordCatAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT word_id, category_id FROM word_categories
       WHERE word_id IN (${ph}) AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO word_categories (word_id, category_id) VALUES (?, ?)`,
    wordCatAll.map((r) => [r.word_id, r.category_id]),
  );

  const wordIdSet = new Set(wordIds);
  const relationCandidates = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, source_word_id, target_word_id, relation_type, notes
       FROM lexical_relations
       WHERE source_word_id IN (${ph}) AND deleted_at IS NULL`,
    wordIds,
  );
  const relationAll = relationCandidates.filter((r) =>
    wordIdSet.has(String(r.target_word_id)),
  );

  await insertMany(
    out,
    `INSERT INTO lexical_relations (
      id, source_word_id, target_word_id, relation_type, notes
    ) VALUES (?, ?, ?, ?, ?)`,
    relationAll.map((r) => [
      r.id,
      r.source_word_id,
      r.target_word_id,
      r.relation_type,
      r.notes,
    ]),
  );

  const pronunciationAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, word_id, dialect_id, notation, value, audio_url, speaker_name,
              notes, status, is_verified, is_corrected
       FROM pronunciations
       WHERE word_id IN (${ph}) AND status = 'published' AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO pronunciations (
      id, word_id, dialect_id, notation, value, audio_url, speaker_name,
      notes, status, is_verified, is_corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pronunciationAll.map((r) => [
      r.id,
      r.word_id,
      r.dialect_id,
      r.notation,
      r.value,
      r.audio_url,
      r.speaker_name,
      r.notes,
      r.status,
      toBoolInt(r.is_verified),
      toBoolInt(r.is_corrected),
    ]),
  );

  const imageAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, word_id, url, alt_text, is_primary, content_warnings, status,
              is_verified, is_corrected
       FROM word_images
       WHERE word_id IN (${ph}) AND status = 'published' AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO word_images (
      id, word_id, url, alt_text, is_primary, content_warnings, status,
      is_verified, is_corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    imageAll.map((r) => [
      r.id,
      r.word_id,
      r.url,
      r.alt_text,
      toBoolInt(r.is_primary),
      toJsonText(r.content_warnings),
      r.status,
      toBoolInt(r.is_verified),
      toBoolInt(r.is_corrected),
    ]),
  );

  const audioAll = await selectInChunks(
    source,
    (ph) =>
      `SELECT id, word_id, example_id, dialect_id, url, mime_type, file_size,
              duration_ms, speaker_name, is_primary, status, is_verified, is_corrected
       FROM word_audios
       WHERE word_id IN (${ph}) AND status = 'published' AND deleted_at IS NULL`,
    wordIds,
  );

  await insertMany(
    out,
    `INSERT INTO word_audios (
      id, word_id, example_id, dialect_id, url, mime_type, file_size,
      duration_ms, speaker_name, is_primary, status, is_verified, is_corrected
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    audioAll.map((r) => [
      r.id,
      r.word_id,
      r.example_id,
      r.dialect_id,
      r.url,
      r.mime_type,
      r.file_size,
      r.duration_ms,
      r.speaker_name,
      toBoolInt(r.is_primary),
      r.status,
      toBoolInt(r.is_verified),
      toBoolInt(r.is_corrected),
    ]),
  );

  const variantsByWord = new Map<string, string[]>();
  for (const v of variantAll) {
    const wid = String(v.word_id);
    const list = variantsByWord.get(wid) ?? [];
    list.push(String(v.form));
    variantsByWord.set(wid, list);
  }

  const meaningIdsByWord = new Map<string, string[]>();
  for (const m of meaningAll) {
    const wid = String(m.word_id);
    const list = meaningIdsByWord.get(wid) ?? [];
    list.push(String(m.id));
    meaningIdsByWord.set(wid, list);
  }

  const translationsByMeaning = new Map<string, string[]>();
  for (const t of translationAll) {
    const mid = String(t.meaning_id);
    const list = translationsByMeaning.get(mid) ?? [];
    list.push(String(t.translation_text));
    translationsByMeaning.set(mid, list);
  }

  const ftsRows: InArgs[] = [];
  for (const w of wordRows) {
    const wid = String(w.id);
    const variantText = (variantsByWord.get(wid) ?? []).join(' ');
    const mIds = meaningIdsByWord.get(wid) ?? [];
    const translationParts: string[] = [];
    for (const mid of mIds) {
      translationParts.push(...(translationsByMeaning.get(mid) ?? []));
    }
    ftsRows.push([wid, String(w.lemma), variantText, translationParts.join(' ')]);
  }

  await insertMany(
    out,
    `INSERT INTO words_fts (word_id, lemma, variants, translations) VALUES (?, ?, ?, ?)`,
    ftsRows,
  );

  const releasedAt = new Date().toISOString();
  const metaBatch: Array<{ sql: string; args: InArgs }> = [
    {
      sql: `INSERT INTO release_meta (key, value) VALUES (?, ?)`,
      args: ['release_version', String(options.releaseVersion)],
    },
    {
      sql: `INSERT INTO release_meta (key, value) VALUES (?, ?)`,
      args: ['schema_version', String(PUBLIC_SCHEMA_VERSION)],
    },
    {
      sql: `INSERT INTO release_meta (key, value) VALUES (?, ?)`,
      args: ['released_at', releasedAt],
    },
  ];
  if (options.channel) {
    metaBatch.push({
      sql: `INSERT INTO release_meta (key, value) VALUES (?, ?)`,
      args: ['channel', options.channel],
    });
  }
  await out.batch(metaBatch, 'write');

  const validated = await validatePublicDb(out);
  out.close();

  if (!validated.ok) {
    throw new Error(`Validasi artifact gagal:\n${validated.errors.join('\n')}`);
  }

  await pipeline(
    createReadStream(sqlitePath),
    createGzip({ level: 9 }),
    createWriteStream(gzipPath),
  );

  const hash = createHash('sha256');
  await pipeline(createReadStream(gzipPath), hash);
  const sha256 = hash.digest('hex');
  const { size } = await stat(gzipPath);

  if (size > 12 * 1024 * 1024) {
    warn(`Gzip ${size} bytes (>12MB) - warning saja, lanjut`);
  }

  const manifest = {
    release_version: options.releaseVersion,
    schema_version: PUBLIC_SCHEMA_VERSION,
    min_app_version: options.minAppVersion ?? '0.1.0',
    channel: options.channel ?? 'staging',
    database: {
      file: 'database.sqlite.gz',
      size,
      sha256,
    },
    released_at: releasedAt,
    word_count: validated.wordCount,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(sha256SumsPath, `${sha256}  database.sqlite.gz\n`, 'utf8');

  // Salin ke out/ (folder lokal untuk cek / upload Release; di-gitignore)
  const publishDir = resolve(ROOT, 'out');
  await mkdir(publishDir, { recursive: true });
  await copyFile(gzipPath, join(publishDir, 'database.sqlite.gz'));
  await copyFile(manifestPath, join(publishDir, 'manifest.json'));
  await copyFile(sha256SumsPath, join(publishDir, 'SHA256SUMS'));

  log('selesai', {
    outDir,
    publishDir,
    wordCount: validated.wordCount,
    size,
    sha256,
  });

  return {
    sqlitePath,
    gzipPath,
    manifestPath,
    sha256SumsPath,
    sha256,
    size,
    wordCount: validated.wordCount,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL wajib (lihat .env.example)');
  }

  const source = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });

  const releaseVersion = Number(process.env.DATASET_RELEASE_VERSION ?? '1');
  const channel = process.env.DATASET_CHANNEL ?? 'staging';
  const outDir = process.env.DATASET_OUT_DIR ?? resolve(ROOT, 'tmp/dataset-export');

  try {
    await exportPublishedDataset({
      source,
      outDir,
      releaseVersion,
      channel,
      minAppVersion: process.env.DATASET_MIN_APP_VERSION ?? '0.1.0',
    });
  } finally {
    source.close();
  }
}

const isDirect =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  main().catch((err) => {
    console.error('[dataset:export] gagal', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
