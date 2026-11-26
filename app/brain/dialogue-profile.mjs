// Single-session dialogue profile sidecar.
// Pure config normalization + atomic per-session persistence.
// Does not touch Light request snapshots, SDK history, GeneralChat, native state or UI.

import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';

export const DIALOGUE_DEFAULTS_SCHEMA = 'asuka.dialogue-defaults/1';
export const DIALOGUE_STATE_SCHEMA = 'asuka.dialogue-state/1';

const PROFILE_KEYS = ['address', 'identity_intro', 'opening_relationship', 'tic_preference'];
const DEFAULTS_KEYS = new Set(['schema', ...PROFILE_KEYS]);
const STATE_KEYS = new Set([
  'schema', 'session_id', 'profile', 'profile_sha256', 'source', 'frozen_at',
]);

const fail = (code, message = code, cause = null) => {
  const error = Object.assign(new Error(message), {code});
  if (cause) error.cause = cause;
  throw error;
};

const storage = (operation, error) => {
  if (typeof error?.code === 'string' && error.code.startsWith('DIALOGUE_')) throw error;
  fail('DIALOGUE_STATE_STORAGE', `dialogue state ${operation} failed`, error);
};

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value, allowed) => {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

const validateSessionId = sessionId => {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || sessionId.includes('\0')) {
    fail('DIALOGUE_SESSION_ID', '会话 ID 无效');
  }
  return sessionId;
};

const resolveDirectory = directory => {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    fail('DIALOGUE_DIRECTORY', 'dialogue state 目录无效');
  }
  return path.resolve(directory);
};

const profileFileName = sessionId => {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return `profile-${digest}.json`;
};

export function dialogueStatePath(directory, sessionId) {
  return path.join(resolveDirectory(directory), profileFileName(validateSessionId(sessionId)));
}

const normalizeText = (value, {label, max, singleLine = false, required = false}) => {
  if (value === undefined) {
    if (required) fail('DIALOGUE_DEFAULTS_TYPE', `${label} 缺失`);
    return '';
  }
  if (typeof value !== 'string') fail('DIALOGUE_DEFAULTS_TYPE', `${label} 必须是字符串`);
  if (value.includes('\0')) fail('DIALOGUE_DEFAULTS_NUL', `${label} 含 NUL`);
  if (singleLine && /[\r\n\u2028\u2029]/.test(value)) {
    fail('DIALOGUE_DEFAULTS_ADDRESS', `${label} 必须单行`);
  }
  const normalized = value.trim();
  if ([...normalized].length > max) fail('DIALOGUE_DEFAULTS_LENGTH', `${label} 过长`);
  return normalized;
};

const normalizeTic = (value, {required = false} = {}) => {
  if (value === undefined || value === '') {
    if (required) fail('DIALOGUE_DEFAULTS_TIC', 'tic_preference 缺失');
    return 'natural';
  }
  if (value !== 'natural' && value !== 'reduced') {
    fail('DIALOGUE_DEFAULTS_TIC', 'tic_preference 必须是 natural 或 reduced');
  }
  return value;
};

const normalizeProfileValues = (source, {stored = false} = {}) => ({
  address: normalizeText(source.address, {
    label: 'address', max: 80, singleLine: true, required: stored,
  }),
  identity_intro: normalizeText(source.identity_intro, {
    label: 'identity_intro', max: 1200, required: stored,
  }),
  opening_relationship: normalizeText(source.opening_relationship, {
    label: 'opening_relationship', max: 1200, required: stored,
  }),
  tic_preference: normalizeTic(source.tic_preference, {required: stored}),
});

const emptyProfile = () => ({
  address: '', identity_intro: '', opening_relationship: '', tic_preference: 'natural',
});

const isLegacyEmpty = profile =>
  profile.address === '' &&
  profile.identity_intro === '' &&
  profile.opening_relationship === '' &&
  profile.tic_preference === 'natural';

const normalizeDefaults = raw => {
  if (raw === undefined) raw = {schema: DIALOGUE_DEFAULTS_SCHEMA};
  if (!plain(raw)) fail('DIALOGUE_DEFAULTS_TYPE', 'defaults 必须是对象');
  if (Object.keys(raw).some(key => !DEFAULTS_KEYS.has(key))) {
    fail('DIALOGUE_DEFAULTS_FIELDS', 'defaults 含未知字段');
  }
  if (raw.schema !== DIALOGUE_DEFAULTS_SCHEMA) {
    fail('DIALOGUE_DEFAULTS_SCHEMA', 'defaults schema 不匹配');
  }
  return normalizeProfileValues(raw);
};

export function normalizeDialogueDefaults(raw) {
  return {schema:DIALOGUE_DEFAULTS_SCHEMA,...normalizeDefaults(raw)};
}

const validateRecordProfile = profile => {
  if (!plain(profile) || !exactKeys(profile, PROFILE_KEYS)) {
    fail('DIALOGUE_STATE_INVALID', 'profile 字段不匹配');
  }
  const normalized = normalizeProfileValues(profile, {stored: true});
  // Do not silently normalize a stored profile; its hash must describe exact bytes.
  if (PROFILE_KEYS.some(key => normalized[key] !== profile[key])) {
    fail('DIALOGUE_STATE_INVALID', 'profile 未规范化');
  }
  return normalized;
};

const validateFrozenAt = value => {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('DIALOGUE_STATE_INVALID', 'frozen_at 无效');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('DIALOGUE_STATE_INVALID', 'frozen_at 不是规范 ISO 时间');
  }
};

const validateRecord = (record, sessionId) => {
  if (!plain(record) || !exactKeys(record, STATE_KEYS)) {
    fail('DIALOGUE_STATE_INVALID', 'dialogue state 字段不匹配');
  }
  if (record.schema !== DIALOGUE_STATE_SCHEMA) {
    fail('DIALOGUE_STATE_INVALID', 'dialogue state schema 不匹配');
  }
  if (record.session_id !== sessionId) {
    fail('DIALOGUE_STATE_SESSION', 'dialogue state 属于另一个会话');
  }
  const profile = validateRecordProfile(record.profile);
  if (typeof record.profile_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.profile_sha256)) {
    fail('DIALOGUE_STATE_INVALID', 'profile_sha256 无效');
  }
  if (fingerprint(profile) !== record.profile_sha256) {
    fail('DIALOGUE_STATE_HASH', 'profile hash 不匹配');
  }
  if (!['user_configured_setup', 'legacy_empty'].includes(record.source)) {
    fail('DIALOGUE_STATE_SOURCE', 'profile source 无效');
  }
  if (record.source === 'legacy_empty' && !isLegacyEmpty(profile)) {
    fail('DIALOGUE_STATE_SOURCE', 'legacy_empty 必须为空 profile');
  }
  validateFrozenAt(record.frozen_at);
  return record;
};

export function validateDialogueState(record, sessionId=record?.session_id) {
  return structuredClone(validateRecord(record,validateSessionId(sessionId)));
}

const readExisting = (file, sessionId) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    storage('read', error);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    fail('DIALOGUE_STATE_INVALID', 'dialogue state 不是有效 JSON', error);
  }
  return validateRecord(record, sessionId);
};

const writeTemp = (file, record) => {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } finally { fd = null; } }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return temp;
};

// Prefer hardlink: on NTFS it is an atomic, no-overwrite publish of the already
// fsynced temp file. Never use rename(), which can replace an existing winner.
// No copy fallback: it could expose a partial file or remove a concurrent
// writer's winning record. Unsupported storage fails before model dispatch.

const publishNoOverwrite = (temp, final) => {
  try {
    fs.linkSync(temp, final);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
};

// Shared only by host-owned dialogue records; callers validate their schema.
// Returns false when an existing record won, without ever replacing it.
export function publishImmutableDialogueJson(file, record) {
  let temp=null;
  try {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    temp=writeTemp(file,record);return publishNoOverwrite(temp,file);
  } catch(error) { storage('write',error); }
  finally { if(temp)try{fs.unlinkSync(temp);}catch{} }
}

/**
 * Bind the first profile for a Pi session.
 *
 * Existing sidecar wins and is returned without invoking `defaults`.
 * A session with prior conversation always gets an empty legacy profile and
 * never invokes `defaults`. A new session resolves `defaults`, which may be a
 * lazy synchronous function.
 *
 * @returns {{record: object, created: boolean}}
 */
export function bindSessionProfile({
  directory,
  sessionId,
  defaults,
  hasPriorConversation = false,
} = {}) {
  const dir = resolveDirectory(directory);
  const sid = validateSessionId(sessionId);
  if (typeof hasPriorConversation !== 'boolean') {
    fail('DIALOGUE_PRIOR_FLAG', 'hasPriorConversation 必须是布尔值');
  }

  try {
    fs.mkdirSync(dir, {recursive: true});
  } catch (error) {
    storage('directory', error);
  }

  const file = path.join(dir, profileFileName(sid));
  const existing = readExisting(file, sid);
  if (existing) return {record: existing, created: false};

  let profile;
  let source;
  if (hasPriorConversation) {
    profile = emptyProfile();
    source = 'legacy_empty';
  } else {
    let raw;
    try {
      raw = typeof defaults === 'function' ? defaults() : defaults;
    } catch (error) {
      // A concurrent writer may have won while defaults were evaluated.
      const raced = readExisting(file, sid);
      if (raced) return {record: raced, created: false};
      throw error;
    }
    if (raw && typeof raw.then === 'function') {
      fail('DIALOGUE_DEFAULTS_TYPE', 'defaults 必须是同步值或同步函数');
    }
    try {
      profile = normalizeDefaults(raw);
    } catch (error) {
      const raced = readExisting(file, sid);
      if (raced) return {record: raced, created: false};
      throw error;
    }
    source = 'user_configured_setup';
  }

  const record = {
    schema: DIALOGUE_STATE_SCHEMA,
    session_id: sid,
    profile,
    profile_sha256: fingerprint(profile),
    source,
    frozen_at: new Date().toISOString(),
  };
  validateRecord(record, sid);

  try {
    if (publishImmutableDialogueJson(file, record)) return {record, created: true};
    const raced = readExisting(file, sid);
    if (!raced) fail('DIALOGUE_STATE_STORAGE', '发布后未找到 dialogue state');
    return {record: raced, created: false};
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('DIALOGUE_')) throw error;
    storage('write', error);
  }
}
