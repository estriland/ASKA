import {createHash} from 'node:crypto';
import {sourceTerms} from './character-memory-v2.mjs';
import {compareCompactCues, compactFeatureVersions} from './personality/general-network/compact-memory-features.mjs';
export {readInteractionCue} from './interaction-memory-general.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const ROLES = ['user','assistant'];
const SCENE_GAP = HOUR;
const excerptSegmenter = new Intl.Segmenter('zh', {granularity:'sentence'});
const filler = new Set(('在 也 又 还 和 很 有 没有 一下 还是 然后 那个 这个 这样 之前 上次 说 说过 记住 以前 时候 ' +
  '了 吗 呢 好 嗯 我们 一起 想 可以 一个 今天 昨天 这件事 当时 事情 能 你们 现在 怎么样 ' +
  'i a the is it you me my and to are was said remember when what about です ます の は に を と').split(' '));
const hash = value => createHash('sha256').update(value).digest('hex');
const words = text => [...new Set(sourceTerms(text))];
const topicWords = text => words(text).filter(word => !filler.has(word));
const present = value => typeof value === 'string' && value.trim().length > 0;
const recallSignal = /上(?:一)?次|那(?:一)?次|当初|之前(?:说|提|讲)|以前(?:说|提|讲)|曾(?:经)?(?:说|提|讲)|还记得|之前的约定|前に(?:話|言)|前回|覚えて|あの時|\b(?:last time|you (?:said|told)|I (?:said|told)|remember when|we discussed)\b/iu;
const refusal = /(?:别|不要|不用|不必|无需|不需要)(?:再|特意|专门)?(?:记|保存)|忘(?:了|掉)这|do(?:n.t| not) (?:remember|save)|覚えなくて/iu;
const importance = /(?:^|[\s，,。.!！?？：:；;])(?:请(?:你)?|麻烦(?:你)?|帮我|你)?(?:一定(?:要)?|务必|要)?(?:记住(?!了?[吗么]|没有)|记牢|记下来|长期记得|别忘了)\s*[：:，,]?\s*[^，。！？!?\s]|(?:这(?:件)?事|这(?:个|条)(?:消息|约定)|对我)(?:对我(?:来说)?)?(?:非常|特别|真的很|至关|很)重要|\b(?:please remember|important to me|remember this)\b|覚えておいて/iu;
const speakerOf = role => role === 'user' ? '用户' : 'ASKA';

// The two half-lives are product settings in wall-clock days. This is the
// same fast/slow exponential mixture as General's native memory_strength,
// with a longer everyday time scale and an explicit, source-backed long tier.
export function interactionActivation(ageMs, longTerm = false) {
  const days = Math.max(0, ageMs / DAY);
  const short = .65 * 2 ** (-days / 2) + .35 * 2 ** (-days / 28);
  return longTerm ? .72 + .28 * short : short;
}

function normalizeTurn(turn) {
  if (!present(turn?.request_id) || !Number.isSafeInteger(turn.at) || turn.at < 0 || turn.at > 8.64e15 ||
      (turn.group_id != null && !present(turn.group_id)) || !['chat','call'].includes(turn.channel ?? 'chat'))
    throw new TypeError('Invalid interaction turn identity, timestamp, group or channel');
  for (const role of ROLES) {
    if (turn[role] != null && typeof turn[role] !== 'string') throw new TypeError('Invalid public message');
    if (turn[role + '_ref'] != null && turn[role + '_ref'] !== turn.request_id + ':' + role)
      throw new TypeError('Public message reference does not belong to this request');
  }
  return {...turn, group_id:turn.group_id ?? null, channel:turn.channel ?? 'chat',
    user:turn.user ?? '', assistant:turn.assistant ?? '', translation:typeof turn.translation === 'string' ? turn.translation : ''};
}

function excerpt(text, terms = [], limit = 150) {
  let chosen = null, best = -Infinity;
  for (const {index, segment} of excerptSegmenter.segment(text)) {
    const body = segment.trim();
    if (!body) continue;
    const start = index + segment.indexOf(body), folded = body.normalize('NFKC').toLowerCase();
    const hits = terms.filter(term => folded.includes(term));
    const score = hits.length * 20 + Math.min(10, topicWords(body.slice(0, 600)).length);
    if (score <= best) continue;
    // The offsets always refer to UTF-16 positions in the exact SDK string.
    const hit = hits.map(term => body.toLowerCase().indexOf(term)).find(offset => offset >= 0) ?? 0;
    let left = start + Math.max(0, Math.min(body.length - limit, hit - Math.floor(limit / 3)));
    if (left > start && /[\uDC00-\uDFFF]/u.test(text[left])) left--;
    let end = Math.min(start + body.length, left + limit);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    chosen = {start:left, end}; best = score;
  }
  return chosen ?? {start:0, end:Math.min(text.length, limit)};
}

function mentionPhrases(text) {
  if (!recallSignal.test(text) || /(?:没(?:有)?|从未|不曾)(?:向[你我]|跟[你我])?(?:说|提|讲|告诉)|(?:never|didn['’]t) (?:say|tell|mention)|言ってない/iu.test(text)) return [];
  const quoted = Array.from(text.matchAll(/[“「『"‘]([^”」』"’\n]+)[”」』"’]/gu), m => m[1]);
  const fragments = text.split(/[，,。.!！?？：:；;\n]/u).map(s => s.trim());
  // An independently spoken, specific clause can confirm the memory.
  // Similarity, a topic noun or the material sent in the prompt cannot.
  return [...new Set([...quoted, ...fragments])].filter(s => s.length >= 6 && topicWords(s).length >= 2);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS interaction_turns (
    id INTEGER PRIMARY KEY, relation TEXT NOT NULL, request_id TEXT NOT NULL, group_id TEXT, origin_group_id TEXT,
    at INTEGER NOT NULL, channel TEXT NOT NULL, cue TEXT, cue_identity TEXT,
    UNIQUE(relation,request_id));
  CREATE INDEX IF NOT EXISTS interaction_group_time ON interaction_turns(relation,group_id,at,request_id);
  CREATE INDEX IF NOT EXISTS interaction_state ON interaction_turns(relation,cue_identity,at);
  CREATE TABLE IF NOT EXISTS interaction_lines (
    id INTEGER PRIMARY KEY, turn INTEGER NOT NULL REFERENCES interaction_turns(id) ON DELETE CASCADE,
    role TEXT NOT NULL, ref TEXT NOT NULL, text_hash TEXT NOT NULL, translation_hash TEXT NOT NULL,
    chars INTEGER NOT NULL, direct INTEGER NOT NULL, witness INTEGER NOT NULL, recorded_at INTEGER,
    excerpt_start INTEGER NOT NULL, excerpt_end INTEGER NOT NULL, UNIQUE(turn,role));
  CREATE INDEX IF NOT EXISTS interaction_ref ON interaction_lines(ref,turn);
  CREATE VIRTUAL TABLE IF NOT EXISTS interaction_terms USING fts5(terms,content='',contentless_delete=1,detail=none);
  CREATE TABLE IF NOT EXISTS interaction_mentions (
    target INTEGER NOT NULL REFERENCES interaction_lines(id) ON DELETE CASCADE,
    witness INTEGER NOT NULL REFERENCES interaction_lines(id) ON DELETE CASCADE,
    route TEXT NOT NULL, PRIMARY KEY(target,witness,route));
  CREATE INDEX IF NOT EXISTS interaction_witness ON interaction_mentions(witness);
  CREATE TABLE IF NOT EXISTS interaction_cue_sources (
    turn INTEGER NOT NULL REFERENCES interaction_turns(id) ON DELETE CASCADE, ref TEXT NOT NULL,
    PRIMARY KEY(turn,ref));
  CREATE INDEX IF NOT EXISTS interaction_cue_ref ON interaction_cue_sources(ref,turn);
  CREATE TABLE IF NOT EXISTS interaction_episodes (
    relation TEXT NOT NULL, first_request TEXT NOT NULL, group_id TEXT, started INTEGER NOT NULL,
    ended INTEGER NOT NULL, is_long INTEGER NOT NULL, members TEXT NOT NULL, PRIMARY KEY(relation,first_request));
  CREATE INDEX IF NOT EXISTS interaction_episode_start ON interaction_episodes(relation,started);
`;

const columns = 't.request_id,t.group_id,t.origin_group_id,t.at,t.channel,l.id,l.ref,l.role,l.recorded_at,l.text_hash,l.translation_hash,l.excerpt_start,l.excerpt_end';
const longTier = '(l.direct=1 OR EXISTS(SELECT 1 FROM interaction_mentions m WHERE m.target=l.id))';
const cueKey = cue => JSON.stringify([cue.representation_version,cue.engine_ref,cue.character_ref,cue.owner_id,cue.reality,cue.owner_role]);
function validCue(cue) {
  return cue?.schema === 'asuka.compact-cue/1' && compactFeatureVersions.includes(cue.representation_version) &&
    cue.reality === 'actual' && cue.owner_role === 'shared' && [cue.owner_id,cue.engine_ref,cue.character_ref].every(present) &&
    cue.components && Object.values(cue.components).every(v => typeof v?.known === 'boolean' && (!v.known || Number.isFinite(v.value)));
}
function ftsQuery(terms, requireAll = false) {
  const subset = terms.length <= 56 ? terms : [...terms.slice(0, 28), ...terms.slice(-28)];
  return subset.map(term => '"' + term.replaceAll('"','""') + '"').join(requireAll ? ' AND ' : ' OR ');
}

export class InteractionMemory {
  #db; #relation; #resolve; #recent = new Map(); #batch = null;

  constructor(db, relationshipId, {resolveTurn} = {}) {
    if (!present(relationshipId) || (resolveTurn != null && typeof resolveTurn !== 'function')) throw new TypeError('Invalid interaction relationship');
    this.#db = db; this.#relation = relationshipId; this.#resolve = resolveTurn;
    db.exec(SCHEMA);
    if (!db.prepare('PRAGMA table_info(interaction_turns)').all().some(c => c.name==='origin_group_id')) {
      db.exec('ALTER TABLE interaction_turns ADD COLUMN origin_group_id TEXT; UPDATE interaction_turns SET origin_group_id=group_id');
    }
    if (!db.prepare('PRAGMA table_info(interaction_lines)').all().some(c => c.name==='recorded_at'))
      db.exec('ALTER TABLE interaction_lines ADD COLUMN recorded_at INTEGER');
    if (db.prepare("SELECT v FROM interaction_terms_config WHERE k='secure-delete'").get()?.v !== 1)
      db.exec("INSERT INTO interaction_terms(interaction_terms,rank) VALUES('secure-delete',1)");
  }

  #transaction(work) {
    this.#db.exec('SAVEPOINT interaction_edit');
    try {
      let earliest = Infinity, removedTerms = false;
      const dirty = (at, removal = false) => {earliest = Math.min(at,earliest); removedTerms ||= removal;};
      const result = work(dirty);
      if (Number.isFinite(earliest)) {
        this.#updateMentions(earliest);
        this.#updateEpisodes(earliest);
      }
      // Contentless-delete uses tombstones. On the bundled SQLite the old
      // word bytes survive a checkpoint until the FTS segments are merged.
      if (removedTerms) this.#db.exec("INSERT INTO interaction_terms(interaction_terms) VALUES('optimize')");
      this.#db.exec('RELEASE interaction_edit');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK TO interaction_edit; RELEASE interaction_edit');
      this.#recent.clear();
      throw error;
    }
  }

  #body(requestId) {
    return this.#batch?.get(requestId) ?? this.#recent.get(requestId) ?? this.#resolve?.(requestId) ?? null;
  }

  #rememberBody(turn) {
    this.#recent.delete(turn.request_id);
    this.#recent.set(turn.request_id, turn);
    if (this.#recent.size > 96) this.#recent.delete(this.#recent.keys().next().value);
  }

  #source(ref) {
    return this.#db.prepare(`SELECT ${columns},t.id AS turn FROM interaction_lines l JOIN interaction_turns t ON t.id=l.turn
      WHERE t.relation=? AND l.ref=?`).get(this.#relation, ref);
  }

  #clearCue(id) {
    this.#db.prepare("DELETE FROM interaction_mentions WHERE route='native' AND witness IN (SELECT id FROM interaction_lines WHERE turn=?)").run(id);
    this.#db.prepare('UPDATE interaction_turns SET cue=NULL,cue_identity=NULL WHERE id=?').run(id);
    this.#db.prepare('DELETE FROM interaction_cue_sources WHERE turn=?').run(id);
  }

  #dropLine(line) {
    for (const row of this.#db.prepare(`SELECT cs.turn FROM interaction_cue_sources cs JOIN interaction_turns t ON t.id=cs.turn
        WHERE t.relation=? AND cs.ref=?`).all(this.#relation, line.ref)) this.#clearCue(row.turn);
    this.#db.prepare('DELETE FROM interaction_terms WHERE rowid=?').run(line.id);
    this.#db.prepare('DELETE FROM interaction_mentions WHERE target=? OR witness=?').run(line.id, line.id);
    this.#db.prepare('DELETE FROM interaction_lines WHERE id=?').run(line.id);
  }

  #writeCue(turn, id) {
    const cue = turn.cue;
    if (!validCue(cue)) return;
    const refs = new Set(cue.interaction_sources ?? [turn.request_id + ':user']);
    if (!refs.has(turn.request_id + ':user') || [...refs].some(ref => {
      const source = this.#source(ref);
      return !source || (cue.interaction_source_hashes && cue.interaction_source_hashes[ref] !== source.text_hash);
    })) return;
    const mentions = (cue.interaction_rementions ?? []).filter(proof => this.#source(proof.ref)?.text_hash === proof.text_hash);
    for (const proof of mentions) refs.add(proof.ref);
    const value = JSON.stringify(cue.interaction_rementions ? {...cue,interaction_rementions:mentions} : cue);
    if (this.#db.prepare('SELECT cue FROM interaction_turns WHERE id=?').get(id)?.cue === value) return;
    this.#clearCue(id);
    this.#db.prepare('UPDATE interaction_turns SET cue=?,cue_identity=? WHERE id=?').run(value, cueKey(cue), id);
    const add = this.#db.prepare('INSERT INTO interaction_cue_sources(turn,ref) VALUES(?,?)');
    for (const ref of refs) add.run(id, ref);
  }

  #put(turn, dirty) {
    const db = this.#db;
    const old = db.prepare('SELECT * FROM interaction_turns WHERE relation=? AND request_id=?').get(this.#relation, turn.request_id);
    if (!old && !ROLES.some(role => present(turn[role]))) return;
    const origin = Object.hasOwn(turn,'origin_group_id') ? turn.origin_group_id : old ? old.origin_group_id : turn.group_id;
    const moved = old && (old.at !== turn.at || old.group_id !== turn.group_id || old.channel !== turn.channel || old.origin_group_id!==origin);
    if (moved) dirty(old.at);
    if (!old || moved) {
      db.prepare(`INSERT INTO interaction_turns(relation,request_id,group_id,origin_group_id,at,channel) VALUES(?,?,?,?,?,?)
        ON CONFLICT(relation,request_id) DO UPDATE SET group_id=excluded.group_id,origin_group_id=excluded.origin_group_id,at=excluded.at,channel=excluded.channel`)
        .run(this.#relation, turn.request_id, turn.group_id, origin ?? null, turn.at, turn.channel);
      dirty(turn.at);
    }
    const id = old?.id ?? db.prepare('SELECT id FROM interaction_turns WHERE relation=? AND request_id=?').get(this.#relation, turn.request_id).id;
    for (const role of ROLES) {
      const previous = db.prepare('SELECT * FROM interaction_lines WHERE turn=? AND role=?').get(id, role);
      const text = turn[role], translated = role === 'assistant' ? turn.translation : '';
      const when = turn[role+'At'] ?? turn[role+'_at'];
      const recordedAt = Number.isSafeInteger(when) && when>=0 && when<=8.64e15 ? when : null;
      const direct = Number((turn.important === true && role === (present(turn.user) ? 'user' : 'assistant')) ||
        (role === 'user' && !refusal.test(text) && importance.test(text)));
      const textHash = hash(text), translationHash = hash(translated);
      if (previous?.text_hash === textHash && previous.translation_hash === translationHash) {
        if (previous.direct !== direct || previous.recorded_at !== recordedAt) {
          db.prepare('UPDATE interaction_lines SET direct=?,recorded_at=? WHERE id=?').run(direct,recordedAt,previous.id);
          if (previous.recorded_at !== recordedAt) dirty(turn.at);
        }
        continue;
      }
      if (previous) {
        this.#dropLine(previous);
        dirty(turn.at,true);
      }
      if (!present(text)) continue;
      const span = excerpt(text), ref = turn.request_id + ':' + role;
      const line = db.prepare(`INSERT INTO interaction_lines(turn,role,ref,text_hash,translation_hash,chars,direct,witness,recorded_at,excerpt_start,excerpt_end)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,role,ref,textHash,translationHash,text.length,direct,
          Number(role === 'user' && recallSignal.test(text)),recordedAt,span.start,span.end);
      db.prepare('INSERT INTO interaction_terms(rowid,terms) VALUES(?,?)').run(line.lastInsertRowid,words(text + '\n' + translated).join(' '));
      dirty(turn.at);
    }
    if (!db.prepare('SELECT 1 FROM interaction_lines WHERE turn=?').get(id)) {
      this.#clearCue(id);
      db.prepare('DELETE FROM interaction_turns WHERE id=?').run(id);
    } else {
      this.#writeCue(turn, id);
      if (turn.cue?.interaction_rementions?.length && JSON.stringify(turn.cue) !== old?.cue) dirty(turn.at);
    }
    this.#rememberBody(turn);
  }

  recordTurn(value) {
    const turn = normalizeTurn(value);
    this.#transaction(dirty => this.#put(turn, dirty));
  }

  syncTurns(values) {
    const ordered = values.map(normalizeTurn).sort((a,b) => a.at - b.at || a.request_id.localeCompare(b.request_id));
    const byId = new Map(ordered.map(turn => [turn.request_id,turn]));
    if (byId.size !== ordered.length) throw new TypeError('Duplicate public request in the relationship snapshot');
    this.#batch = byId;
    try {
      this.#transaction(dirty => {
        for (const row of this.#db.prepare('SELECT request_id FROM interaction_turns WHERE relation=?').all(this.#relation)) {
          if (!byId.has(row.request_id)) this.#remove([row.request_id + ':user',row.request_id + ':assistant'], dirty);
        }
        for (const turn of ordered) this.#put(turn, dirty);
      });
    } finally { this.#batch = null; }
  }

  #remove(refs, dirty) {
    for (const ref of new Set(refs)) {
      const line = this.#source(ref);
      if (!line) continue;
      this.#dropLine(line);
      const cached = this.#recent.get(line.request_id);
      if (cached) this.#recent.set(line.request_id,{...cached,[line.role]:'',
        ...(line.role === 'assistant' ? {translation:''} : {}),cue:null});
      if (!this.#db.prepare('SELECT 1 FROM interaction_lines WHERE turn=?').get(line.turn)) {
        this.#recent.delete(line.request_id);
        this.#clearCue(line.turn);
        this.#db.prepare('DELETE FROM interaction_turns WHERE id=?').run(line.turn);
      }
      dirty(line.at,true);
    }
  }

  removeSources(refs) { this.#transaction(dirty => this.#remove(refs, dirty)); }

  #updateMentions(from) {
    const db = this.#db;
    const witnesses = db.prepare(`SELECT ${columns},t.cue FROM interaction_turns t JOIN interaction_lines l ON l.turn=t.id
      WHERE t.relation=? AND t.at>=? AND l.role='user' AND (l.witness=1 OR json_array_length(t.cue,'$.interaction_rementions')>0)
      ORDER BY t.at,t.request_id`).all(this.#relation, from);
    const add = db.prepare('INSERT OR IGNORE INTO interaction_mentions(target,witness,route) VALUES(?,?,?)');
    for (const witness of witnesses) {
      db.prepare('DELETE FROM interaction_mentions WHERE witness=?').run(witness.id);
      const text = this.#body(witness.request_id)?.user;
      if (typeof text !== 'string' || hash(text) !== witness.text_hash) continue;
      const independent = old => old && old.request_id !== witness.request_id && old.at < witness.at &&
        (old.origin_group_id !== witness.origin_group_id || witness.at - old.at >= SCENE_GAP);
      for (const proof of (witness.cue ? JSON.parse(witness.cue).interaction_rementions : []) ?? []) {
        const old = this.#source(proof.ref);
        if (independent(old) && old.role === 'user' && old.text_hash === proof.text_hash && witness.text_hash === proof.witness_hash)
          add.run(old.id, witness.id, 'native');
      }
      const phrases = mentionPhrases(text);
      if (!phrases.length) continue;
      const namedSpeaker = /(?:[我你])(?:上(?:一)?次|那时|当时|之前|以前|曾经|还)?(?:跟[我你]|向[我你])?(?:说|提|讲|告诉)/gu;
      const speakers = new Set(Array.from(text.matchAll(namedSpeaker),m=>m[0][0]==='我'?'user':'assistant'));
      if (/\byou (?:said|told|mentioned)\b/iu.test(text)) speakers.add('assistant');
      if (/\bI (?:said|told|mentioned)\b/iu.test(text)) speakers.add('user');
      if (speakers.size>1) continue;
      const query = ftsQuery(topicWords(phrases.join(' ')));
      if (!query) continue;
      const candidates = db.prepare(`SELECT ${columns} FROM interaction_terms f JOIN interaction_lines l ON l.id=f.rowid
        JOIN interaction_turns t ON t.id=l.turn WHERE interaction_terms MATCH ? AND t.relation=? AND t.at<=? AND t.request_id<>?
        ORDER BY rank LIMIT 65`).all(query, this.#relation, witness.at, witness.request_id);
      if (candidates.length > 64) continue;
      for (const phrase of phrases) {
        const matches = candidates.filter(old => {
          if (!independent(old) || (speakers.size && !speakers.has(old.role))) return false;
          const body = this.#body(old.request_id)?.[old.role];
          return typeof body === 'string' && hash(body) === old.text_hash && body.includes(phrase);
        });
        if (matches.length === 1) add.run(matches[0].id, witness.id, 'quote');
      }
    }
  }

  #updateEpisodes(changedAt) {
    const db = this.#db;
    const start = db.prepare(`SELECT MAX(started) AS at FROM interaction_episodes
      WHERE relation=? AND started<?`).get(this.#relation,changedAt).at ?? changedAt;
    db.prepare('DELETE FROM interaction_episodes WHERE relation=? AND started>=?').run(this.#relation,start);
    const rows = db.prepare(`SELECT t.request_id,t.at,t.group_id,SUM(l.chars) AS chars,MAX(COALESCE(l.recorded_at,t.at)) AS ended FROM interaction_turns t JOIN interaction_lines l ON l.turn=t.id
      WHERE t.relation=? AND t.at>=? GROUP BY t.id ORDER BY t.at,t.request_id`).all(this.#relation,start);
    const save = db.prepare('INSERT INTO interaction_episodes(relation,first_request,group_id,started,ended,is_long,members) VALUES(?,?,?,?,?,?,?)');
    let members = [], chars = 0;
    const finish = () => {
      if (!members.length) return;
      const group = members.every(row => row.group_id===members[0].group_id) ? members[0].group_id : null;
      save.run(this.#relation,members[0].request_id,group,members[0].at,Math.max(...members.map(r => r.ended)),
        Number(members.length >= 6 || chars >= 2000),JSON.stringify(members.map(row => row.request_id)));
      members = []; chars = 0;
    };
    for (const row of rows) {
      if (members.length && (row.at - members.at(-1).ended > SCENE_GAP || members.length >= 10 || chars >= 8000)) finish();
      members.push(row); chars += row.chars;
    }
    finish();
  }

  latestCue({at = Date.now()} = {}) {
    const row = this.#db.prepare(`SELECT request_id,at,cue FROM interaction_turns WHERE relation=? AND at<=? AND cue IS NOT NULL
      ORDER BY at DESC,request_id DESC LIMIT 1`).get(this.#relation, at);
    return row ? {...row, cue:JSON.parse(row.cue)} : null;
  }

  #materialize(line, terms = [], summary = false) {
    const turn = this.#body(line.request_id), text = turn?.[line.role];
    if (typeof text !== 'string' || hash(text) !== line.text_hash) return null;
    const translated = line.role === 'assistant' && turn.translation;
    const span = summary ? {start:line.excerpt_start,end:line.excerpt_end} : excerpt(text, terms, 300);
    const result = {role:line.role, source_ref:line.ref, request_id:line.request_id, group_id:line.group_id,
      origin_group_id:line.origin_group_id, at:line.recorded_at ?? line.at, time_basis:line.recorded_at===null?'turn':'message',channel:line.channel,
      ...span, text:text.slice(span.start, span.end)};
    if (!summary && translated && translated !== text && hash(translated) === line.translation_hash) {
      const range = excerpt(translated, terms, 300);
      result.translation = translated.slice(range.start,range.end);
      result.translation_start = range.start; result.translation_end = range.end;
    }
    return result;
  }

  recall({text = '', cue = null, at = Date.now(), explicit = false, limit = 3, group_id = null} = {}) {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Invalid interaction query');
    if (!limit) return [];
    const terms = explicit ? words(text) : topicWords(text), query = ftsQuery(terms,explicit), hits = new Map();
    const groupFilter = group_id==null ? '' : ' AND t.group_id=?';
    const scope = group_id==null ? [this.#relation] : [this.#relation,group_id];
    const accept = (row, route, relevance) => {
      const activation = interactionActivation(at - row.at, Boolean(row.long_term));
      if (!explicit && activation < .08) return;
      const score = relevance * (explicit ? 1 : .4 + .6 * activation);
      const hit = hits.get(row.request_id) ?? {row, score:0, activation:0, routes:new Set(), matched:new Set(), long:false};
      hit.score = Math.max(hit.score, score); hit.activation = Math.max(hit.activation, activation);
      hit.long ||= Boolean(row.long_term); hit.routes.add(route); if (row.ref) hit.matched.add(row.ref);
      hits.set(row.request_id, hit);
    };
    if (query) {
      const lexical = this.#db.prepare(`SELECT ${columns},${longTier} AS long_term,rank FROM interaction_terms f
        JOIN interaction_lines l ON l.id=f.rowid JOIN interaction_turns t ON t.id=l.turn
        WHERE interaction_terms MATCH ? AND t.relation=?${groupFilter} AND t.at<=? AND COALESCE(l.recorded_at,t.at)<=? AND (? OR t.at>=? OR ${longTier})
        ORDER BY rank,t.at DESC LIMIT ?`)
        .all(query,...scope,at,at,Number(explicit),at-64*DAY,Math.max(96,Math.min(limit,50)*8));
      for (const row of lexical) accept(row,'keyword',.68 + .32 * (-row.rank / (1 - row.rank)));
    }
    if (validCue(cue)) {
      const states = this.#db.prepare(`SELECT t.request_id,t.group_id,t.at,t.channel,t.cue,
        MAX(${longTier}) AS long_term FROM interaction_turns t JOIN interaction_lines l ON l.turn=t.id
        WHERE t.relation=?${groupFilter} AND t.cue_identity=? AND t.at<=? AND (? OR t.at>=? OR ${longTier}) GROUP BY t.id`)
        .all(...scope,cueKey(cue),at,Number(explicit),at-64*DAY);
      for (const row of states) {
        if (!explicit && interactionActivation(at - row.at, Boolean(row.long_term)) < .08) continue;
        const match = compareCompactCues(cue,JSON.parse(row.cue),{minimum_components:3});
        if (match.matched && match.score >= .82) accept(row,'state',match.score * .86);
      }
    }
    const priority = hit => hit.score + (hit.routes.size > 1 ? .12 : 0);
    const result = [];
    for (const hit of [...hits.values()].sort((a,b) => priority(b)-priority(a) || b.row.at-a.row.at || a.row.request_id.localeCompare(b.row.request_id))) {
      const {request_id,group_id,at:when,channel} = hit.row;
      const lines = this.#db.prepare(`SELECT ${columns} FROM interaction_turns t JOIN interaction_lines l ON l.turn=t.id
        WHERE t.relation=? AND t.request_id=? AND COALESCE(l.recorded_at,t.at)<=? ORDER BY l.role DESC`).all(this.#relation, request_id,at);
      const messages = lines.map(line => this.#materialize(line,terms)).filter(Boolean);
      if (!messages.length || hit.matched.size && !messages.some(line => hit.matched.has(line.source_ref))) continue;
      result.push({request_id, group_id, at:when, channel, tier:hit.long?'long':'short', activation:hit.activation,
        routes:[...hit.routes], matched_source_refs:[...hit.matched], source_refs:messages.map(m => m.source_ref), messages});
      if (result.length >= Math.min(limit,50)) break;
    }
    return result;
  }

  summaries({group_id, request_ids, at = 8.64e15, limit = 12} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Invalid episode query');
    const filter = group_id === undefined ? '' : ` AND EXISTS(SELECT 1 FROM json_each(ep.members) m JOIN interaction_turns src
      ON src.request_id=m.value AND src.relation=ep.relation WHERE src.group_id IS ?)`;
    const args = group_id === undefined ? [this.#relation,at] : [this.#relation,at,group_id];
    let rows;
    if (request_ids) {
      const containing = this.#db.prepare(`SELECT ep.* FROM interaction_turns t JOIN interaction_episodes ep
        ON ep.relation=t.relation AND ep.started<=t.at AND ep.ended>=t.at
        WHERE t.relation=? AND ep.ended<=?${filter} AND t.request_id=? AND ep.is_long=1 AND EXISTS(SELECT 1 FROM json_each(ep.members) WHERE value=t.request_id)
        ORDER BY ep.started DESC LIMIT 1`);
      const lookup = new Map();
      for (const id of request_ids) {
        const ep = containing.get(...args,id);
        if (ep) lookup.set(ep.first_request,ep);
      }
      rows = [...lookup.values()].slice(0,Math.min(limit,50));
    } else {
      rows = this.#db.prepare(`SELECT * FROM interaction_episodes ep WHERE relation=? AND ended<=? AND is_long=1${filter}
        ORDER BY ended DESC,first_request LIMIT ?`).all(...args,Math.min(limit,50));
    }
    return rows.flatMap(row => {
      const ids = JSON.parse(row.members);
      const lines = this.#db.prepare(`SELECT ${columns} FROM interaction_turns t JOIN interaction_lines l ON l.turn=t.id
        WHERE t.relation=? AND t.request_id IN (SELECT value FROM json_each(?)) ORDER BY t.at,t.request_id,l.role DESC`)
        .all(this.#relation,row.members);
      const selected = new Set();
      for (const role of ROLES) {
        const side = lines.filter(line => line.role === role);
        if (side.length) for (const i of [0,Math.floor((side.length-1)/2),side.length-1]) selected.add(side[i].ref);
      }
      const excerpts = lines.filter(line => selected.has(line.ref)).map(line => this.#materialize(line, [], true)).filter(Boolean);
      if (!excerpts.length) return [];
      return [{id:row.first_request + ':episode', group_id:row.group_id, started_at:row.started, ended_at:row.ended,
        group_ids:[...new Set(lines.map(line => line.group_id))],
        channels:[...new Set(lines.map(line => line.channel))], speakers:[...new Set(lines.map(line => line.role))],
        request_ids:ids, source_refs:lines.map(line => line.ref), excerpts,
        summary:excerpts.map(line => speakerOf(line.role) + '「' + line.text + '」').join('；')}];
    });
  }
}
