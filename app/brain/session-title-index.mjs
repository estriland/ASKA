// Derived title metadata. Chats stay in their original Pi JSONL files.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

export const TITLE_INDEX = '.session-titles-v1.sqlite';
const require = createRequire(import.meta.url);
const artifacts = ['', '-journal', '-wal', '-shm'];
const createTable = 'CREATE TABLE IF NOT EXISTS titles (filename TEXT PRIMARY KEY, session_id TEXT NOT NULL, stamp TEXT NOT NULL, summary TEXT NOT NULL)';

function indexLocation(directory) {
  const file=path.join(directory,TITLE_INDEX);
  for (const suffix of artifacts) {
    const entry=fs.lstatSync(file+suffix,{throwIfNoEntry:false});
    if (entry && !entry.isFile()) return null;
  }
  return file;
}

function open(file,readOnly) {
  // Some development Node builds omit SQLite. Listing can use the in-memory
  // metadata and bounded legacy reads in that case.
  const {DatabaseSync}=require('node:sqlite');
  return new DatabaseSync(file,{readOnly});
}

function corrupt(error) {
  return error?.code==='TITLE_INDEX_SCHEMA' || [11,26].includes(error?.errcode & 255);
}

function discardDamaged(file) {
  // This namespace contains only rebuildable metadata. Propagate genuine
  // filesystem failures so erasure cannot claim that a readable title is gone.
  for (const suffix of artifacts) {
    const candidate=file+suffix, entry=fs.lstatSync(candidate,{throwIfNoEntry:false});
    if (entry?.isFile()) fs.unlinkSync(candidate);
  }
}

export function readTitleIndex(directory) {
  const file=indexLocation(directory);
  if (!file || !fs.existsSync(file)) return new Map();
  const db=open(file,true);
  try {
    db.exec('PRAGMA busy_timeout=100; PRAGMA trusted_schema=OFF');
    const rows=new Map();
    for (const item of db.prepare('SELECT filename,stamp,summary FROM titles').all()) {
      try { rows.set(item.filename,{stamp:item.stamp,summary:JSON.parse(item.summary)}); }
      catch { /* A damaged entry is re-derived from its own log. */ }
    }
    return rows;
  } finally {db.close();}
}

function write(file,edit) {
  const db=open(file,false);
  try {
    db.exec('PRAGMA busy_timeout=500; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON');
    const mode=db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
    if (mode!=='delete' || db.prepare('PRAGMA secure_delete').get().secure_delete!==1)
      throw Object.assign(new Error('Title index journal configuration unavailable'),{code:'TITLE_INDEX_JOURNAL'});
    db.exec('BEGIN IMMEDIATE');
    db.exec(createTable);
    const columns=db.prepare('PRAGMA table_info(titles)').all().map(column=>column.name);
    if (columns.join(',')!=='filename,session_id,stamp,summary')
      throw Object.assign(new Error('Unsupported title cache schema'),{code:'TITLE_INDEX_SCHEMA'});
    const save=db.prepare('INSERT OR REPLACE INTO titles(filename,session_id,stamp,summary) VALUES(?,?,?,?)');
    const drop=db.prepare('DELETE FROM titles WHERE filename=?');
    const forget=db.prepare('DELETE FROM titles WHERE session_id=? OR filename=?');
    edit({
      put(name,entry) { save.run(name,entry.summary.id,entry.stamp,JSON.stringify(entry.summary)); },
      drop(name) { drop.run(name); },
      forget(id,name) { forget.run(id,name??null); },
    });
    db.exec('COMMIT');
  } finally {
    // Closing also rolls back an unfinished transaction. The OS releases the
    // database lock if the process exits, including during the first write.
    db.close();
  }
}

export function editTitleIndex(directory,edit) {
  const file=indexLocation(directory);
  if (!file) return;
  try {write(file,edit);}
  catch (error) {
    if (!corrupt(error)) throw error;
    discardDamaged(file);
    write(file,edit);
  }
}

export function eraseIndexedTitle(directory,id,filename) {
  const file=indexLocation(directory);
  if (!file) {
    // Never follow a substituted directory or link. A genuine database next
    // to an unsafe journal still needs to be cleared for this erasure.
    discardDamaged(path.join(directory,TITLE_INDEX));
    return;
  }
  if (!fs.existsSync(file)) {discardDamaged(file);return;}
  try { write(file,writer=>writer.forget(id,filename)); }
  catch(error) {
    if ([5,6].includes(error?.errcode & 255)) throw error; // A live transaction owns the database.
    if (!corrupt(error) && !['ERR_SQLITE_ERROR','ERR_UNKNOWN_BUILTIN_MODULE','TITLE_INDEX_JOURNAL'].includes(error.code)) throw error;
    discardDamaged(file);
  }
}
