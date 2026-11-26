import {randomUUID} from 'node:crypto';
import {acceptedAppointment, conversationCues, reminderInstructions} from './initiative-language.mjs';

export {initiativePrompt, initiativeReply, requiredReminder} from './initiative-language.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const LEASE = 3 * MINUTE;
const ACTIVE = "('preparing','ready','published')";
const schema = `
  CREATE TABLE IF NOT EXISTS initiative_turns (
    relation TEXT NOT NULL, request_id TEXT NOT NULL, user_ref TEXT, assistant_ref TEXT, group_id TEXT,
    received_at INTEGER NOT NULL, at INTEGER NOT NULL, cues TEXT NOT NULL, engagement TEXT,
    next_check INTEGER NOT NULL, checks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(relation,request_id));
  CREATE INDEX IF NOT EXISTS initiative_recent ON initiative_turns(relation,received_at DESC);
  CREATE TABLE IF NOT EXISTS initiative_erased (
    relation TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(relation,source_id));
  CREATE TABLE IF NOT EXISTS initiative_cue_sources (
    relation TEXT NOT NULL, request_id TEXT NOT NULL, source_id TEXT NOT NULL,
    PRIMARY KEY(relation,request_id,source_id));
  CREATE INDEX IF NOT EXISTS initiative_cue_source ON initiative_cue_sources(relation,source_id);
  CREATE TABLE IF NOT EXISTS initiative_events (
    relation TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT, topic TEXT NOT NULL, language TEXT NOT NULL,
    due_at INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(relation,id));
  CREATE INDEX IF NOT EXISTS initiative_due ON initiative_events(relation,status,due_at);
  CREATE TABLE IF NOT EXISTS initiative_event_log (
    sequence INTEGER PRIMARY KEY, relation TEXT NOT NULL, event_id TEXT NOT NULL, source_id TEXT NOT NULL,
    operation TEXT NOT NULL, at INTEGER NOT NULL, due_at INTEGER, UNIQUE(relation,event_id,source_id,operation));
  CREATE INDEX IF NOT EXISTS initiative_source ON initiative_event_log(relation,source_id);
  CREATE TABLE IF NOT EXISTS initiative_dispatch (
    relation TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT,
    refs TEXT NOT NULL, events TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, draft TEXT, delivered_at INTEGER,
    PRIMARY KEY(relation,id));
  CREATE UNIQUE INDEX IF NOT EXISTS initiative_one_active ON initiative_dispatch(relation) WHERE status IN ${ACTIVE};
  CREATE INDEX IF NOT EXISTS initiative_delivered ON initiative_dispatch(relation,delivered_at);
`;

const members = values => [...new Set(values.filter(Boolean))];
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const ref = value => typeof value === 'string' && value.trim() ? value : null;
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
function engagementOf(cue) {
  const result = {};
  for (const key of ['observed_share_drive','observed_guard','observed_exposure_discomfort']) {
    const level = cue?.components?.[key];
    if (level?.known === true && Number.isFinite(level.value) && level.value >= 0 && level.value <= 1)
      result[key] = level.value;
  }
  return Object.keys(result).length ? result : null;
}

// A scheduler opportunity is distinct from the model's final social decision.
// Unknown personality measurements have no adjustment. The user's new message
// already has its own regular reply path.
export function opportunityProbability(kind, cues, engagement, unanswered, elapsed) {
  const base = {addition:0.15, new_topic:0.29, follow_up:0.21}[kind];
  let weight = base + (cues.expressedInterest ? 0.17 : 0) + (cues.openQuestion ? 0.06 : 0);
  if (Number.isFinite(engagement?.observed_share_drive)) weight += 0.32 * (engagement.observed_share_drive - 0.5);
  if (Number.isFinite(engagement?.observed_guard)) weight -= 0.08 * engagement.observed_guard;
  if (Number.isFinite(engagement?.observed_exposure_discomfort)) weight -= 0.05 * engagement.observed_exposure_discomfort;
  return Math.max(0, Math.min(0.9, weight)) / (1 + unanswered * 0.35 + elapsed / (7 * DAY));
}

const followUpDelay = count => Math.min(30 * DAY, 3 * HOUR * 2 ** Math.min(12, count - 1));
function staleOpportunity(row, now) {
  if (!row || row.kind === 'reminder' || row.status === 'published') return false;
  const window = row.kind === 'addition' ? 20 * MINUTE : 6 * HOUR;
  return now - row.created_at > window;
}

export class InitiativeScheduler {
  constructor(db, relationshipId, {clock = Date.now, random = Math.random} = {}) {
    if (!ref(relationshipId)) throw Error('需要明确的关系档');
    this.db = db;
    this.relation = relationshipId;
    this.clock = clock;
    this.random = random;
    db.exec(schema);
  }

  #write(work) {
    const outer = !this.db.isTransaction;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT initiative_write');
    try {
      const result = work();
      this.db.exec(outer ? 'COMMIT' : 'RELEASE initiative_write');
      return result;
    } catch (error) {
      this.db.exec(outer ? 'ROLLBACK' : 'ROLLBACK TO initiative_write; RELEASE initiative_write');
      throw error;
    }
  }

  #one(sql, ...args) { return this.db.prepare(sql).get(this.relation, ...args); }
  #all(sql, ...args) { return this.db.prepare(sql).all(this.relation, ...args); }
  #run(sql, ...args) { return this.db.prepare(sql).run(this.relation, ...args); }

  #eventSources(id) {
    return this.#all('SELECT DISTINCT source_id FROM initiative_event_log WHERE relation=? AND event_id=? ORDER BY source_id', id)
      .map(row => row.source_id);
  }

  #event(row) {
    return {id:row.id, topic:row.topic, dueAt:row.due_at, groupId:row.group_id, language:row.language, sourceIds:this.#eventSources(row.id)};
  }

  #active() {
    return this.#one(`SELECT * FROM initiative_dispatch WHERE relation=? AND status IN ${ACTIVE}`);
  }

  #output(row) {
    if (!row) return null;
    const events = JSON.parse(row.events)
      .map(id => this.#one('SELECT * FROM initiative_events WHERE relation=? AND id=?', id))
      .filter(Boolean).map(event => this.#event(event));
    return {id:row.id, token:row.token, kind:row.kind, groupId:row.group_id,
      sourceIds:JSON.parse(row.refs), events, context:JSON.parse(row.context),
      draft:row.draft ? JSON.parse(row.draft) : null, status:row.status};
  }

  #invalidate(row) {
    if (row && row.status !== 'published') this.#run("UPDATE initiative_dispatch SET status='superseded',draft=NULL WHERE relation=? AND id=?", row.id);
  }

  #log(eventId, sourceId, operation, at, dueAt) {
    this.#run('INSERT OR IGNORE INTO initiative_event_log(relation,event_id,source_id,operation,at,due_at) VALUES(?,?,?,?,?,?)',
      eventId, sourceId, operation, at, dueAt ?? null);
  }

  #erased(id) {
    return id && this.#one('SELECT 1 FROM initiative_erased WHERE relation=? AND source_id=?', id);
  }

  #bindCue(requestId, cue) {
    const value = engagementOf(cue);
    if (!value) return false;
    const sources = members([requestId + ':user', ...(cue.interaction_sources || [])]);
    if (sources.some(id => this.#erased(id))) return false;
    this.#run('DELETE FROM initiative_cue_sources WHERE relation=? AND request_id=?', requestId);
    for (const id of sources) this.#run('INSERT INTO initiative_cue_sources VALUES(?,?,?)',requestId,id);
    return Boolean(this.db.prepare('UPDATE initiative_turns SET engagement=? WHERE relation=? AND request_id=?')
      .run(JSON.stringify(value),this.relation,requestId).changes);
  }

  #targets(edit, pending) {
    if (edit.all) return pending;
    const text = normalize(edit.text.replace(edit.timeText || '\0', ''));
    const matches = pending.filter(event => event.topic && text.includes(normalize(event.topic)));
    if (matches.length) return matches.length === 1 ? matches : [];
    if (edit.targetTime) {
      const sameTime = pending.filter(event => event.due_at === edit.targetTime);
      if (sameTime.length === 1) return sameTime;
    }
    // A bare correction can resolve against a single outstanding appointment.
    // A different named subject cannot silently cancel that appointment.
    const remainder = text.replace(/(?:帮我|幫我|刚才的?|剛才的?|刚刚的?|那(?:个|個|条|條|项|項)?|这(?:个|条)?|之前的?|前面(?:的)?|原来(?:的)?|请|請|先|把|将|將|取消|不用|不要|不必|别再?|撤销|撤銷|提醒|闹钟|通知|叫醒|时间|時間|改成|改到|改在|改为|改為|推迟到?|挪到?|提前到?|延后到?|一下|了|吧|嘛|的|我|さっきの?|その|あの|先ほどの?|リマインダ[ーァ]?|リマインド|アラーム|を|は|に|へ|から|変更して|変えて|ずらして|キャンセルして|取り消して|ください|お願い)/gu, '');
    return !remainder && pending.length === 1 ? pending : [];
  }

  #applyEdits(turn) {
    const {userText, assistantText, userId, assistantId, groupId, at, userAt} = turn;
    const assistantEdits = assistantId ? reminderInstructions(assistantText, 'assistant', at) : [];
    const userEdits = userId ? reminderInstructions(userText, 'user', userAt).filter(edit =>
      !edit.joint || (assistantId && acceptedAppointment(assistantText)) || assistantEdits.some(other => other.joint)) : [];
    const created = [];
    for (const [role, edits, sourceId, origin] of [['user',userEdits,userId,userAt], ['assistant',assistantEdits,assistantId,at]]) {
      for (const edit of edits) {
        if (edit.action === 'create') {
          if (role === 'assistant' && userEdits.length) {
            // A restated relative time is anchored to the original request.
            // An independently explicit restatement can also support the fact.
            const match = created.find(e => e.topic && normalize(e.topic) === normalize(edit.topic) &&
              (e.dueAt === edit.dueAt || e.dueAt - userAt === edit.dueAt - at));
            if (match) { this.#log(match.id, sourceId, 'confirm', origin, match.dueAt); continue; }
            if (userEdits.some(item => item.action !== 'create') ||
                created.some(item => item.dueAt === edit.dueAt || item.dueAt - userAt === edit.dueAt - at)) continue;
          }
          const already = this.#one("SELECT id FROM initiative_events WHERE relation=? AND due_at=? AND topic=? AND language=? AND status='pending'",
            edit.dueAt,edit.topic,edit.language);
          if (already) {
            this.#log(already.id,sourceId,'confirm',origin,edit.dueAt);
            created.push({...edit,id:already.id});
            continue;
          }
          const id = randomUUID();
          this.#run("INSERT INTO initiative_events VALUES(?,?,?,?,?,?,'pending')", id,groupId,edit.topic,edit.language,edit.dueAt);
          const proposal = role === 'user' && edit.joint;
          this.#log(id, sourceId, proposal ? 'propose' : 'create', origin, edit.dueAt);
          if (proposal) this.#log(id,assistantId,'accept',at,edit.dueAt);
          created.push({...edit,id});
          continue;
        }
        const pending = this.#all("SELECT * FROM initiative_events WHERE relation=? AND status='pending' ORDER BY due_at,id");
        for (const candidate of this.#targets(edit, pending)) {
          let dueAt = edit.dueAt;
          if (edit.timeOnly) {
            const current = new Date(candidate.due_at), newClock = new Date(dueAt);
            current.setHours(newClock.getHours(),newClock.getMinutes(),0,0);
            if (+current < origin) continue;
            dueAt = +current;
          }
          this.#log(candidate.id, sourceId, edit.action, origin, dueAt);
          if (edit.action === 'cancel') this.#run("UPDATE initiative_events SET status='cancelled' WHERE relation=? AND id=?", candidate.id);
          else this.db.prepare('UPDATE initiative_events SET due_at=? WHERE relation=? AND id=?')
            .run(dueAt,this.relation,candidate.id);
          const active = this.#active();
          if (active && JSON.parse(active.events).includes(candidate.id)) this.#invalidate(active);
        }
      }
    }
  }

  recordTurn({requestId, groupId = null, userText = '', assistantText = '', userId = requestId + ':user',
    assistantId = requestId + ':assistant', at, userAt = at, engagement = null}) {
    if (!ref(requestId) || !safeTime(at) || !safeTime(userAt)) throw Error('主动联系需要真实话轮和时间');
    userId = ref(userId);
    assistantId = ref(assistantText) ? ref(assistantId) : null;
    if (!userId && !assistantId) return false;
    return this.#write(() => {
      if (this.#erased(userId)) { userId = null; userText = ''; }
      if (this.#erased(assistantId)) { assistantId = null; assistantText = ''; }
      if (!userId && !assistantId) return false;
      const cues = conversationCues(userText, assistantText);
      const insert = this.#run(`INSERT OR IGNORE INTO initiative_turns
        (relation,request_id,user_ref,assistant_ref,group_id,received_at,at,cues,engagement,next_check)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, requestId,userId,assistantId,groupId,userAt,at,
        JSON.stringify(cues),null,at + (cues.hasReply ? 3 * MINUTE : 4 * HOUR));
      if (!insert.changes) return false;
      this.#bindCue(requestId, engagement);
      const active = this.#active();
      if (active && active.kind !== 'reminder') this.#invalidate(active);
      this.#applyEdits({requestId,userText,assistantText,userId,assistantId,groupId,at,userAt});
      return true;
    });
  }

  updateEngagement(requestId, cue) {
    if (!cue || !this.#one('SELECT 1 FROM initiative_turns WHERE relation=? AND request_id=?',requestId)) return false;
    return this.#write(() => this.#bindCue(requestId, cue));
  }

  noteImmediatePublished(requestId) {
    // The same turn has already had its conversational afterthought. Leave
    // explicit reminders and the later new-topic/follow-up schedule in place.
    this.db.prepare('UPDATE initiative_turns SET next_check=max(next_check,at+?),checks=max(checks,1) WHERE relation=? AND request_id=?')
      .run(3*HOUR,this.relation,requestId);
    const active = this.#active();
    if (active?.kind === 'addition' && active.status !== 'published' && JSON.parse(active.context).requestId === requestId)
      this.#invalidate(active);
  }

  #receivedAfter(at) {
    const summary = this.#one("SELECT count(*) AS count,max(delivered_at) AS latest FROM initiative_dispatch WHERE relation=? AND status='delivered' AND delivered_at>?", at);
    return {lastDeliveredAt:summary.latest, unansweredCount:summary.count};
  }

  #newClaim(kind, groupId, refs, eventIds, context, now) {
    const id = randomUUID(), token = randomUUID();
    this.#run(`INSERT INTO initiative_dispatch(relation,id,token,kind,group_id,refs,events,context,status,created_at,lease_until)
      VALUES(?,?,?,?,?,?,?,?,'preparing',?,?)`, id,token,kind,groupId,JSON.stringify(refs),JSON.stringify(eventIds),JSON.stringify(context),now,now + LEASE);
    return this.#output(this.#active());
  }

  claim({now = this.clock(), busy = false, remindersOnly = false} = {}) {
    if (busy || !safeTime(now)) return null;
    return this.#write(() => {
      let active = this.#active();
      if (staleOpportunity(active,now)) { this.#invalidate(active); active = null; }
      const due = this.#all("SELECT * FROM initiative_events WHERE relation=? AND status='pending' AND due_at<=? ORDER BY due_at,id", now);
      const claimedEvents = new Set(active ? JSON.parse(active.events) : []);
      if (active && due.length && active.status !== 'published' &&
          (active.kind !== 'reminder' || due.some(event => !claimedEvents.has(event.id)))) {
        this.#invalidate(active);
        active = null;
      }
      if (active) {
        if (remindersOnly && active.kind !== 'reminder' && active.status !== 'published') return null;
        if (active.status === 'ready' || active.status === 'published') return this.#output(active);
        if (now < active.lease_until) return null;
        const token = randomUUID();
        this.db.prepare("UPDATE initiative_dispatch SET token=?,lease_until=? WHERE relation=? AND id=?")
          .run(token,now + LEASE,this.relation,active.id);
        return this.#output(this.#active());
      }
      const turn = this.#one('SELECT * FROM initiative_turns WHERE relation=? ORDER BY received_at DESC,rowid DESC LIMIT 1');
      const waiting = this.#receivedAfter(turn?.received_at ?? 0);
      const engagement = turn?.engagement ? JSON.parse(turn.engagement) : null;
      const context = {requestId:turn?.request_id ?? null, now, engagement, ...waiting};
      if (due.length) {
        const groups = new Set(due.map(row => row.group_id));
        return this.#newClaim('reminder', groups.size === 1 ? due[0].group_id : null,
          members(due.flatMap(row => this.#eventSources(row.id))),due.map(row => row.id),context,now);
      }
      if (remindersOnly || !turn || !turn.user_ref || now < turn.next_check) return null;
      const cues = JSON.parse(turn.cues), elapsed = Math.max(0, now - turn.at);
      if (cues.quiet || (cues.farewell && elapsed < 12 * HOUR)) return null;
      const {unansweredCount, lastDeliveredAt} = waiting;
      if (unansweredCount && now < lastDeliveredAt + followUpDelay(unansweredCount)) return null;
      const kind = unansweredCount ? 'follow_up' : elapsed <= 20 * MINUTE && !turn.checks && cues.hasReply ? 'addition' : 'new_topic';
      const interval = unansweredCount ? followUpDelay(unansweredCount) : kind === 'addition' ? 3 * HOUR
        : Math.min(14 * DAY, (4 + turn.checks * 3) * HOUR);
      this.db.prepare('UPDATE initiative_turns SET next_check=?,checks=checks+1 WHERE relation=? AND request_id=?')
        .run(now + interval,this.relation,turn.request_id);
      if (this.random() >= opportunityProbability(kind,cues,engagement,unansweredCount,elapsed)) return null;
      const cueSources = this.#all('SELECT source_id FROM initiative_cue_sources WHERE relation=? AND request_id=?',turn.request_id);
      return this.#newClaim(kind,turn.group_id,members([turn.user_ref,turn.assistant_ref,...cueSources.map(row => row.source_id)]),[],context,now);
    });
  }

  getClaim(id, token) {
    const row = this.#one(`SELECT * FROM initiative_dispatch WHERE relation=? AND id=? AND token=? AND status IN ${ACTIVE}`, id, token);
    return staleOpportunity(row,this.clock()) ? null : this.#output(row);
  }

  setDraft(id, token, behavior) {
    if (!ref(behavior?.speech)) throw Error('主动来信缺少正文');
    this.db.prepare("UPDATE initiative_dispatch SET draft=?,status='ready' WHERE relation=? AND id=? AND token=? AND status='preparing'")
      .run(JSON.stringify(behavior),this.relation,id,token);
    return this.getClaim(id,token);
  }

  releaseDraft(id, token) {
    return Boolean(this.db.prepare("UPDATE initiative_dispatch SET token=?,draft=NULL,lease_until=0,status='preparing' WHERE relation=? AND id=? AND token=? AND status='ready'")
      .run(randomUUID(),this.relation,id,token).changes);
  }

  markPublished(id, token) {
    return this.#write(() => {
      const row = this.#one("SELECT * FROM initiative_dispatch WHERE relation=? AND id=? AND token=? AND status IN ('ready','published')", id,token);
      if (!row) return null;
      this.#run("UPDATE initiative_dispatch SET status='published' WHERE relation=? AND id=?", id);
      for (const eventId of JSON.parse(row.events)) this.#run("UPDATE initiative_events SET status='published' WHERE relation=? AND id=?", eventId);
      return this.#output(this.#active());
    });
  }

  settle(id, {status, token, now = this.clock()}) {
    if (!safeTime(now)) return false;
    return this.#write(() => {
      const row = this.#one('SELECT * FROM initiative_dispatch WHERE relation=? AND id=? AND token=?', id,token);
      if (!row) return false;
      if (status === 'delivered') {
        if (row.status === 'delivered') return true;
        if (row.status !== 'published') return false;
        this.db.prepare("UPDATE initiative_dispatch SET status='delivered',delivered_at=?,draft=NULL WHERE relation=? AND id=?")
          .run(now,this.relation,id);
        for (const eventId of JSON.parse(row.events)) this.#run("UPDATE initiative_events SET status='delivered' WHERE relation=? AND id=?", eventId);
        return true;
      }
      if (status === 'quiet' && row.kind !== 'reminder' && ['preparing','ready','quiet'].includes(row.status)) {
        this.#run("UPDATE initiative_dispatch SET status='quiet',draft=NULL WHERE relation=? AND id=?", id);
        return true;
      }
      if (status === 'retry' && row.status === 'preparing') {
        const backoff = Math.min(6 * HOUR, Math.max(MINUTE, now - row.created_at));
        this.db.prepare('UPDATE initiative_dispatch SET lease_until=?,token=? WHERE relation=? AND id=?')
          .run(now + backoff,randomUUID(),this.relation,id);
        return true;
      }
      return false;
    });
  }

  removeGroup(groupId) {
    if (!ref(groupId)) return;
    this.#write(() => {
      for (const table of ['initiative_turns','initiative_events','initiative_dispatch'])
        this.#run(`UPDATE ${table} SET group_id=NULL WHERE relation=? AND group_id=?`, groupId);
    });
  }

  removeSources(ids) {
    const erased = new Set(ids.filter(value => ref(value)));
    if (!erased.size) return;
    this.#write(() => {
      for (const id of erased) {
        this.#run('INSERT OR IGNORE INTO initiative_erased VALUES(?,?)', id);
        const cues = this.#all('SELECT request_id FROM initiative_cue_sources WHERE relation=? AND source_id=?',id);
        for (const row of cues) {
          this.#run('UPDATE initiative_turns SET engagement=NULL WHERE relation=? AND request_id=?',row.request_id);
          this.#run('DELETE FROM initiative_cue_sources WHERE relation=? AND request_id=?',row.request_id);
        }
        this.#run('DELETE FROM initiative_cue_sources WHERE relation=? AND request_id IN (SELECT request_id FROM initiative_turns WHERE relation=? AND (user_ref=? OR assistant_ref=?))', this.relation,id,id);
        this.#run('DELETE FROM initiative_turns WHERE relation=? AND (user_ref=? OR assistant_ref=?)', id,id);
        const affected = this.#all('SELECT DISTINCT event_id FROM initiative_event_log WHERE relation=? AND source_id=?', id);
        this.#run('DELETE FROM initiative_event_log WHERE relation=? AND source_id=?', id);
        for (const {event_id} of affected) {
          const actions = this.#all('SELECT DISTINCT operation FROM initiative_event_log WHERE relation=? AND event_id=?',event_id).map(row => row.operation);
          const origin = actions.includes('create') || actions.includes('confirm') ||
            (actions.includes('propose') && actions.includes('accept'));
          if (!origin) {
            this.#run('DELETE FROM initiative_events WHERE relation=? AND id=?', event_id);
            this.#run('DELETE FROM initiative_event_log WHERE relation=? AND event_id=?', event_id);
          } else {
            const latest = this.#one("SELECT due_at FROM initiative_event_log WHERE relation=? AND event_id=? AND due_at IS NOT NULL ORDER BY sequence DESC LIMIT 1", event_id);
            if (latest) this.db.prepare("UPDATE initiative_events SET due_at=? WHERE relation=? AND id=? AND status='pending'")
              .run(latest.due_at,this.relation,event_id);
          }
        }
      }
      for (const row of this.#all('SELECT id,refs,events,kind,status FROM initiative_dispatch WHERE relation=?')) {
        const refs = JSON.parse(row.refs);
        const remaining = refs.filter(id => !erased.has(id));
        const outgoingErased = erased.has(row.id) || erased.has(row.id + ':assistant') || erased.has('initiative:' + row.id + ':assistant');
        if (!outgoingErased && remaining.length === refs.length) continue;
        const eventIds = JSON.parse(row.events);
        if (!outgoingErased && remaining.length && row.kind === 'reminder' && ['published','delivered'].includes(row.status) &&
            eventIds.every(id => this.#one('SELECT 1 FROM initiative_events WHERE relation=? AND id=?',id))) {
          this.db.prepare('UPDATE initiative_dispatch SET refs=? WHERE relation=? AND id=?').run(JSON.stringify(remaining),this.relation,row.id);
          continue;
        }
        this.#run('DELETE FROM initiative_dispatch WHERE relation=? AND id=?', row.id);
        // A previously published batch already exists in the public log.
        // Removing its source or its outgoing row must not ring again.
        if (row.status === 'published') for (const eventId of eventIds)
          this.#run("UPDATE initiative_events SET status='withdrawn' WHERE relation=? AND id=? AND status='published'",eventId);
      }
    });
  }

  journal() {
    return this.#all(`SELECT l.event_id,l.source_id,l.operation,l.at,l.due_at,e.topic,e.group_id,e.status
      FROM initiative_event_log l JOIN initiative_events e ON e.relation=l.relation AND e.id=l.event_id
      WHERE l.relation=? ORDER BY l.sequence`);
  }
}
