import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const turnName = /^turn-\d{6,}$/;
const indexes = new Map();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');

function activeIndex(file) {
  const stat = fs.statSync(file);
  const stamp = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('/');
  if (indexes.get(file)?.stamp === stamp) return indexes.get(file);
  const data = read(file);
  if (data.schema !== 'asuka.compact-memory-index/1') return null;
  const byTurn = new Map(), byId = new Map();
  for (const entry of data.entries) {
    if (entry.origin !== 'interaction' || data.active[entry.id] !== entry.version ||
        entry.owner_id !== data.config.owner_id || !turnName.test(entry.event_group)) continue;
    const measured = {id:entry.id,version:entry.version,event_group:entry.event_group,source_refs:entry.source_refs,cue:entry.cue};
    byTurn.set(entry.event_group, measured);
    byId.set(entry.id, measured);
  }
  const index = {stamp, byTurn, byId};
  if (indexes.size >= 4) indexes.delete(indexes.keys().next().value);
  indexes.set(file, index);
  return index;
}

export function forgetGeneralInteractionCues(generalState,sessionId) {
  if (generalState && uuid.test(sessionId)) indexes.delete(path.join(generalState,'sessions',sessionId,'engine','memory','compact-index.json'));
}

// The native chat already admits and commits explicit re-mentions. Reuse
// its proof where available, including when the speaker rephrased the event.
function reinforcedSources(folder, marker, index, inputOf, input) {
  const file = path.join(folder, 'memory-reinforced.json');
  if (!fs.existsSync(file)) return [];
  const result = read(file), plan = read(path.join(folder, 'memory-reinforcement-plan.json'));
  if (plan.commit_sha256 !== marker.commit_sha256 || result.plan_sha256 !== fingerprint(plan)) return [];
  const accepted = new Set(result.results.filter(row => ['reinforced','reused'].includes(row.status))
    .map(row => JSON.stringify([row.id, row.version])));
  return plan.updates.flatMap(update => {
    const target = index.byId.get(update.id);
    if (!accepted.has(JSON.stringify([update.id, update.version])) || target?.version !== update.version ||
        update.event?.kind !== 'actual_recall' || update.event.effective !== true ||
        update.event.commit?.transaction_id !== marker.turn || !update.event.source_refs.includes(input.id)) return [];
    const original = inputOf(target.event_group);
    if (!original?.request_id || !update.event.source_refs.includes(original.id)) return [];
    return [{ref:original.request_id + ':user', text_hash:digest(original.text), witness_hash:digest(input.text)}];
  });
}

// A Light/degraded/pending turn has no measured cue. Native data contributes
// only its proven state and reinforcement, never a replacement public reply.
export function readInteractionCue(generalState, record) {
  const session = record?.session_id ?? record?.session, turn = record?.turn_id ?? record?.turn;
  const request = record?.client_request_id ?? record?.request_id;
  if (!generalState || !uuid.test(session) || !turnName.test(turn) || !request || record.degraded_continuity) return null;
  try {
    const base = path.join(generalState, 'sessions', session);
    const folder = path.join(base, 'turns', turn);
    const marker = read(path.join(folder, 'memory-encoded.json'));
    const inputOf = id => turnName.test(id) ? read(path.join(base, 'turns', id, 'input.json')) : null;
    const input = inputOf(turn);
    if (input.request_id !== request || marker.turn !== turn) return null;
    const index = activeIndex(path.join(base, 'engine', 'memory', 'compact-index.json'));
    const entry = index?.byTurn.get(turn), cue = entry?.cue;
    if (!entry || entry.id !== marker.id || entry.version !== marker.version || !entry.source_refs.includes(input.id) ||
        cue?.schema !== 'asuka.compact-cue/1' || cue.reality !== 'actual' || cue.owner_role !== 'shared' ||
        cue.frame_refs?.at(-1)?.id !== turn) return null;
    const inputs = cue.frame_refs.map(frame => inputOf(frame.id));
    if (inputs.some(item => !item?.request_id || typeof item.text !== 'string')) return null;
    const hashes = Object.fromEntries(inputs.map(item => [item.request_id + ':user',digest(item.text)]));
    let mentions = [];
    try { mentions = reinforcedSources(folder, marker, index, inputOf, input); }
    catch { /* Reinforcement can finish later than encoding. */ }
    return {...cue, interaction_sources:Object.keys(hashes), interaction_source_hashes:hashes, interaction_rementions:mentions};
  } catch { return null; }
}
