// Source retrieval and character context are read-only projections. They never
// encode an archive as a new interaction or write a personality state.
import MiniSearch from 'minisearch';
import {applyRoleToView,encodeRoleData,roleData} from './role-settings.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const text=(s,n=4000)=>typeof s==='string'&&s.trim().length>0&&s.length<=n&&!s.includes('\0');
const jsonBytes=x=>Buffer.byteLength(JSON.stringify(x));
const clone=structuredClone;
export const SOURCE_BODY_BUDGET=18000;
export function loadV2Catalog(pack,{version,file,subject}){
 need(pack.schema==='asuka.character-memory-catalog/2'&&pack.subject===subject,'CHAT_MEMORY_PERIOD');
 need(/^[a-f0-9]{64}$/.test(pack.base_policy_sha256??''),'CHAT_MEMORY_POLICY_CHANGED');
 const c=pack.context;need(['asuka.character-context/1','asuka.character-context/2'].includes(c?.schema)&&c.subject===subject&&text(c.id,120)
  &&c.identity?.subject===subject&&text(c.identity.character_name,100)&&text(c.present)
  &&text(c.knowledge_boundary?.id,120)&&text(c.knowledge_boundary.meaning),'CHAT_CHARACTER_CONTEXT');
 for(const key of ['self_knowledge','persona_traits'])need(Array.isArray(c[key])&&c[key].length<=12&&c[key].every(x=>text(x)),'CHAT_CHARACTER_CONTEXT');
 need(c.biography===undefined||text(c.biography),'CHAT_CHARACTER_CONTEXT');
 if(c.presentation!==undefined)need(c.presentation==='feiniao.dialogue/1'&&c.schema==='asuka.character-context/2'&&text(c.biography),'CHAT_CHARACTER_CONTEXT');
 need(Array.isArray(c.source_attribution)&&c.source_attribution.length<=8,'CHAT_CHARACTER_CONTEXT');
 need((c.identity.origin_class===undefined||text(c.identity.origin_class,200))
  &&(c.identity.origin_label_ja===undefined||text(c.identity.origin_label_ja,200))
  &&(c.historical_context===undefined||text(c.historical_context)),'CHAT_CHARACTER_CONTEXT');
 need(c.source_attribution.every(r=>r&&text(r.subject,120)&&text(r.name,120)&&text(r.origin,120)&&text(r.role,80)&&text(r.meaning)), 'CHAT_CHARACTER_CONTEXT');
 const dialogueEdition=c.schema==='asuka.character-context/2';
 if(dialogueEdition)need(text(c.identity.origin_class,200)&&c.self_knowledge.length>0,'CHAT_CHARACTER_CONTEXT');
 need(jsonBytes(characterContextView(c))<=6000,'CHAT_CHARACTER_CONTEXT_BUDGET');
 need(pack.sources&&Object.keys(pack.sources).length<=128,'CHAT_MEMORY_SOURCES');
 const provenance=refs=>Array.isArray(refs)&&refs.length>0&&refs.every(r=>{
  const s=pack.sources[r.source];return s&&text(s.path,1024)&&/^[a-f0-9]{64}$/.test(s.sha256??'')&&text(r.json_pointer||r.locator,1200);
 });
 need(Array.isArray(pack.records)&&pack.records.length>0&&pack.records.length<=96,'CHAT_MEMORY_ROWS');
 const ids=new Set();const rows=pack.records.map((r,i)=>{
  need(text(r.id,100)&&/^[a-zA-Z0-9._-]+$/.test(r.id)&&!ids.has(r.id),'CHAT_MEMORY_ROW_ID');ids.add(r.id);
  need(text(r.label,120)&&text(r.canonical_id,180)&&text(r.period,120)&&text(r.event_group,180)
   &&['past','inner_recollection'].includes(r.stage)&&['fact','belief','uncertain'].includes(r.epistemic_status),'CHAT_MEMORY_ROW');
  need(r.subject===subject&&r.role==='personal_memory'||r.subject==='asuka.soryu'&&r.role==='reference_material','CHAT_MEMORY_ROW_OWNER');
  need(text(r.body?.summary)&&['context','observations'].every(k=>Array.isArray(r.body[k])&&r.body[k].length<=40&&r.body[k].every(x=>text(x)))
   &&jsonBytes(r.body)<SOURCE_BODY_BUDGET&&provenance(r.provenance),'CHAT_MEMORY_ROW_BODY');
  need(Array.isArray(r.keywords)&&r.keywords.length<=40&&r.keywords.every(x=>text(x,120)),'CHAT_MEMORY_ROW');
  need(Array.isArray(r.interpretation_index)&&r.interpretation_index.length<=32&&r.interpretation_index.every(x=>text(x)),'CHAT_MEMORY_ROW');
  need(r.uncertain_aspects===undefined||Array.isArray(r.uncertain_aspects)&&r.uncertain_aspects.length<=8&&r.uncertain_aspects.every(x=>text(x,1000)),'CHAT_MEMORY_ROW');
  if(dialogueEdition)need(r.recollection===null||(text(r.recollection?.text)&&text(r.recollection.period,100)&&text(r.recollection.title,120)),'CHAT_MEMORY_RECOLLECTION');
  return {...r,kind:'character_memory',data_schema:2,source:{path:file,sha256:version.slice(7),json_pointer:'/records/'+i}};
 });
 need(Array.isArray(pack.source_state_routes)&&pack.source_state_routes.length<=16,'CHAT_MEMORY_STATE_ROUTES');
 need(pack.search_aliases===undefined||Array.isArray(pack.search_aliases)&&pack.search_aliases.length<=64
  &&pack.search_aliases.every(p=>Array.isArray(p)&&p.length===2&&p.every(s=>text(s,100))),'CHAT_MEMORY_SEARCH_ALIASES');
 for(const r of pack.source_state_routes)need(text(r.id,120)&&r.subject===subject&&rows.some(x=>x.id===r.row_id&&x.role==='personal_memory'&&x.recollection!==null)
  &&Array.isArray(r.all_types)&&r.all_types.length>0&&r.all_types.length<=4&&r.all_types.every(t=>text(t,80))
  &&typeof r.same_other==='boolean'&&provenance([r.basis]),'CHAT_MEMORY_STATE_ROUTES');
 return {schema_version:2,version,subject,file,base_policy_sha256:pack.base_policy_sha256,rows,
  context:clone(c),state_routes:clone(pack.source_state_routes),search_aliases:clone(pack.search_aliases??[]),core:null,
  directory:rows.map(({id,label,subject})=>({id,label,subject}))};
}
function originalRelation(context,utterance){
 if(!context.role_overrides||context.role_overrides.origin?.mode==='replace'||
      !/原创体|原型|原本|克隆|オリジナル|クローン|(?:十三号机|13号机|十三号機|13号機).*(?:认出|见到|关系|遇到)|\b(?:original|clone)\b/iu.test(utterance??''))return null;
 const original=context.source_attribution.find(person=>person.role==='original_counterpart');
 return original?{original:original.name,clone:context.identity.character_name}:null;
}
export function characterContextView(context,stage='reply',utterance=''){
 if(context.schema==='asuka.character-context/2'||Object.keys(context.role_overrides??{}).length){
  const {subject,character_name,origin_class}=context.identity;
  const view={identity:{subject,character_name,...(origin_class&&!context.biography?{origin_class}:{})},
    ...(context.biography?{biography:context.biography}:{}),life_premise:context.present,self_knowledge:[...context.self_knowledge]};
  const relation=originalRelation(context,utterance);
  if(relation)view.current_relation=relation;
  if(stage==='analysis')view.known_people=context.source_attribution.map(({subject,name})=>({subject,name}));
  else view.dispositions=[...context.persona_traits];
  return applyRoleToView(view,context.role_overrides,stage);
 }
 return applyRoleToView({identity:clone(context.identity),current_life:context.present,self_knowledge:clone(context.self_knowledge),
  dispositions:clone(context.persona_traits),source_attribution:clone(context.source_attribution),
  ...(context.historical_context?{historical_context:context.historical_context}:{}),
  knowledge_boundary:clone(context.knowledge_boundary)},context.role_overrides,stage);
}
export function renderV2Persona(context){
 if(context.presentation==='feiniao.dialogue/1'){
  const fields=context.role_overrides??{},data=roleData(fields);
  delete data.current_life;
  const identity='你是'+context.identity.character_name;
  const origin=fields.origin?.mode==='replace'?identity+'。':identity+'，'+context.biography;
  const heading=[origin,'life_premise' in fields?'':context.present].filter(Boolean).join('\n');
  return [heading,'speaking_style' in fields?'':context.persona_traits.join(''),
    Object.keys(data).length?'<role_settings>'+encodeRoleData(data)+'</role_settings>':''].filter(Boolean).join('\n\n');
 }
 if(context.schema==='asuka.character-context/2'||Object.keys(context.role_overrides??{}).length){
  const fields=context.role_overrides;
  const name='你是'+context.identity.character_name;
  const background=context.biography?name+'。'+context.biography+context.self_knowledge.join(''):null;
  if(fields&&Object.keys(fields).some(key=>key!=='current_life')){
   const replacing=fields.origin?.mode==='replace';
   const data=roleData(fields);
   // Recent facts travel with the turn. The permanent frame contains stable character fields.
   delete data.current_life;
   const opening=replacing?name+'。':background??(name+'。'+(context.identity.origin_class?context.identity.origin_class+'。':'')+context.self_knowledge.join(''));
   return [opening,
    'life_premise'in fields?'':context.present,'speaking_style'in fields?'':context.persona_traits.join(''),
    Object.keys(data).length?'以下是当前角色资料，具体措辞随眼前的对话。\n<role_settings>'+encodeRoleData(data)+'</role_settings>':'',
    '按此刻的话题和心情开口。往事各归其主，近况沿用已知事实。'].filter(Boolean).join('\n\n');
  }
  return [background??(name+(context.identity.origin_class?'，'+context.identity.origin_class:'')+'。'+context.self_knowledge.join('')),
   context.present,context.persona_traits.join(''),
   '按此刻的话题和心情开口。聊近况时，按你们相处中已经说清的事接着聊，各自的生活归各自。记起的往事可以影响你的态度，想谈多少由你决定。'].join('\n\n');
 }
 const origin=context.identity.origin_class?'出身：'+context.identity.origin_class+'。'+(context.identity.origin_label_ja?'日语身份术语：'+context.identity.origin_label_ja+'。':''):'';
 const counterpart=context.source_attribution.find(r=>r.subject==='shikinami.original');
 return ['# 式波明日香','',`你是${context.identity.character_name}。${origin}${context.present}`,'',
  context.self_knowledge.join(''),'','## 性格与相处','',context.persona_traits.join(''),'','## 经历与对话','',
  '自己的过去以人物资料与取回的经历为依据，原作中的服役、身体变化、住处与任务按当时的阶段叙述。惣流是另一位明日香，她的经历有独立的人物归属。',
  ...(counterpart?['','关于'+counterpart.name+'：'+counterpart.meaning]:[]),'',
  '按眼前的话题、感受和自己的意愿决定说什么、说多少。日常短消息是常态，需要说明或愿意深入时自然展开。记忆可以参与理解、影响态度，也可以只谈愿意分享的一部分。','',
  '对话中的话归各自说话人；亲历、听说、内在回望和当时的观点按资料表达。speech写实际说给对方的话，空行用于连续发送的另一条消息。具体语言、翻译与JSON字段遵循客户端协议。'].join('\n');
}
export function sourceMemoryView(row){
 if(row.recollection!==undefined){
  need(row.recollection!==null,'CHAT_MEMORY_ARCHIVE_ONLY');
  const {title,period,text}=row.recollection;
  return {subject:row.subject,owner:row.role==='personal_memory'?'式波':'惣流',title,period,
   ...(row.stage==='inner_recollection'?{form:'内心的回望'}:{}),
   ...(row.epistemic_status==='belief'?{perspective:'当时的理解'}:{}),
   ...(row.epistemic_status==='uncertain'?{perspective:'只知当时的片段，后来的情形留白'}:{}),recollection:text};
 }
 return {kind:row.role==='reference_material'?'惣流的经历资料':'本人的经历与知识',subject:row.subject,
  period:row.period,title:row.label,source_form:row.stage==='inner_recollection'?'原作中的内在回望':'过去阶段的经历与见闻',
  ...(row.body.observations.length?{}:{account:{speaker:row.subject,text:row.body.summary}}),
  context:row.body.context,observations:row.body.observations,
  knowledge_status:{fact:'记录中的事件与事实',belief:'当时的观点或自我理解',uncertain:'资料中存在待核实部分'}[row.epistemic_status],
  ...(row.uncertain_aspects?{uncertain_aspects:row.uncertain_aspects}:{}),
  ...(row.recall_route==='state'?{association:'由相似的当下感受联想到的往事'}:{}),
  ...(row.recall_route==='interpreted_text'?{association:'根据本轮话意找到的相关资料'}:{})};
}

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set(['我','你','他','她','它','的','了','是','吗','呢','啊','吧','自己','什么','怎么','知道','记得','用户','询问','表示']);
export const sourceTerms=s=>[...segmenter.segment(String(s).normalize('NFKC').toLowerCase())]
 .filter(r=>r.isWordLike&&!stop.has(r.segment)).map(r=>r.segment);
const cache=new Map();
function indexFor(catalog){
 const key=catalog.file+'|'+catalog.version;
 if(cache.has(key))return cache.get(key);
 const aliases=(catalog.search_aliases??[]).map(p=>p.map(s=>s.normalize('NFKC').toLowerCase())).sort((a,b)=>b[0].length-a[0].length);
 const tokenize=value=>{let s=String(value).normalize('NFKC').toLowerCase();for(const [from,to]of aliases)s=s.replaceAll(from,to);return sourceTerms(s);};
 const index=new MiniSearch({fields:['label','keywords','body','interpretation'],storeFields:['subject','event_group'],tokenize,processTerm:t=>t});
 index.addAll(catalog.rows.filter(r=>r.recollection!==null).map(r=>({id:r.id,label:r.recollection?.title??r.label,keywords:r.keywords.join(' '),
  body:[r.recollection?.text??r.body.summary,...r.body.context,...r.body.observations].join('\n'),interpretation:r.interpretation_index.join('\n'),
  subject:r.subject,event_group:r.event_group})));
 if(cache.size>=4)cache.delete(cache.keys().next().value);cache.set(key,index);return index;
}
const referenceQuestion=s=>/惣流|(?:^|[^a-z])(?:soryu|sohryu|kyoko|tv)(?:$|[^a-z])|京子|恭子|キョウコ|テレビ|电视版|旧剧场版|旧劇場版/i.test(String(s).normalize('NFKC'));
const namesReferencePerson=/惣流|ソウリュウ|\b(?:soryu|sohryu)\b/iu;
const nameOrRelation=new Set('惣 流 惣流 ソウリュウ soryu sohryu 明日香 アスカ 经历 关系 当成 小'.split(' '));
// A word shared with a scene must carry a topic. Time and routine verbs alone match
// nearly every chapter. State associations use a separate route below.
const conversationalTerms=new Set(('在 也在 也 还 还是 已经 一直 又 当时 时候 那时候 那时 现在 如今 这几天 这段时间 近来 最近 今天 昨天 明天 目前 以前 后来 之前 刚才 '+
 '自己 什么 怎么样 如何 为什么 谁 哪 哪个 哪儿 哪里 怎么 一下 一些 事情 事 那个 这个 这样 一起 的时候 因为 知道 想 听 有 没有 很 最 第一次 '+
 '去 来 做 过 学 是 把 到 给 说 刚 正在 呢 嘛 啦 了 啊 喜欢 试着 试试 '+
 'の 何 に と て は も ます です いる して てる いま 今日 do you i the a are what where now today lately recently').split(/\s+/));
const dailyActivityTerms=new Set('忙 在忙 工作 做事 活动 生活 日子 住 住在 住处 住所 住址 住的 地方 那里 这里 休息 一个人 過ごし 住ん 暮らし 仕事 busy doing live living work'.split(' '));
const presentCue=/最近|近来|近況|近日|这阵子|这几天|这段时间|眼下|如今|现在|今天|今日|いま|今は|今どこ|目前|住(?:在)?哪|\b(?:now|today|lately|recently|these days)\b/iu;
const pastCue=/以前|当时|那时|从前|小时候|曾经|过去|往事|あの時|昔|かつて|当時|\b(?:used to|back then|childhood)\b/iu;
export function recentLifeGuide(context,utterance,{hasDialogue=false}={}){
 if(context?.schema!=='asuka.character-context/2')return '';
 // Current life already travels with the turn. The new edition lets the
 // character interpret earlier experiences from her post-Instrumentality present.
 if(context.presentation==='feiniao.dialogue/1')return '';
 const s=String(utterance);
 if(/假如|假设|如果|想象|要是|倘若|もし|としたら|\b(?:if|imagine|suppose)\b/iu.test(s))return '';
 const currentQuestion=s.split(/[，,。！？!?；;\n]/u).some(part=>presentCue.test(part)&&!pastCue.test(part)
  &&/住|搬|房|上班|工作|职业|日程|打算|忙|做什么|干什么|过得|生活|过得怎样|近況|どこ|暮ら|何して|仕事|\b(?:live|living|work|doing|plans)\b/iu.test(part));
 if(!currentQuestion)return '';
 if(context.role_overrides?.current_life)return '直接回答对方问到的近况。具体地点、事情和进展以已给事实为限；个人感受可以照当下的心情表达。';
 const sources={fixed_recent_facts:[],prior_dialogue:hasDialogue?'本轮已有相处记录，分清说话人和说的是谁':'本轮没有带入先前的相处记录'};
 const continuation=/还住|仍(?:然)?|依旧|还是|还在|まだ|今も|\bstill\b/iu.test(s)
  ?'问一件旧事是否延续到今天时，当年的经历只回答当年那部分；确认它仍在继续或已经结束，都需要后来的事实。':'';
 return '<recent_life_sources>'+JSON.stringify(sources)+'</recent_life_sources>\n生活起点里没有预设今天的住所、居住条件、职业或行程。开场时明确约定的事可沿用；对方讲自己的事仍归对方，转述和打算仍按原意理解。'+continuation+'没有具体事实时，回应对方的好奇或关心就可以，把生活细节留白。';
}
function positiveReadout(row,rules,subject){
 if(row?.scope?.subject!==subject||row.coverage!=='provided')return false;
 const rule=rules?.[row.type];if(!rule||!Array.isArray(rule.labels)||!Array.isArray(rule.upper_bounds))return false;
 const n=rule.labels.indexOf(row.current_symbol);
 // A nonzero label must have an exclusive lower bound at or above zero.
 return n>0&&rule.labels.lastIndexOf(row.current_symbol)===n&&Number.isFinite(rule.upper_bounds[n-1])&&rule.upper_bounds[n-1]>=0;
}
export function stateSourceMatches(catalog,{readouts=[],symbolRules={},proof=null}={}){
 const matches=[],omitted=[];
 for(const rule of catalog.state_routes??[]){
  const groups=rule.all_types.map(type=>readouts.filter(r=>r.type===type&&positiveReadout(r,symbolRules,rule.subject)));
  let evidence=[];
  if(groups.every(g=>g.length)){
   if(rule.same_other){
    const others=[...new Set(groups[0].map(r=>r.scope.other).filter(Boolean))];
    const other=others.find(id=>groups.every(g=>g.some(r=>r.scope.other===id)));
    if(other)evidence=groups.map(g=>g.find(r=>r.scope.other===other));
   }else evidence=groups.map(g=>g[0]);
  }
  if(evidence.length)matches.push({id:rule.row_id,route:'state',rule:rule.id,proof,
   evidence:evidence.map(r=>({type:r.type,symbol:r.current_symbol,scope:clone(r.scope),source_refs:clone(r.cause_refs??[])}))});
  else omitted.push({rule:rule.id,reason:groups.every(g=>g.length)?'different_or_unknown_query_object':'no_positive_known_readout'});
 }
 return {matches,omitted};
}
export function sourceDialogueCue(messages=[],limit=2){
 const recent=[];
 for(let i=messages.length-1;i>=0&&recent.length<Math.max(4,limit);i--){
  const m=messages[i];
  if(!['user','assistant'].includes(m.role)||typeof m.text!=='string'||!m.text.trim()||
     /^【(?:工具资料|历史摘要|对话摘要)/u.test(m.text))continue;
  recent.unshift(m);
 }
 return {historyText:recent.slice(-limit).map(m=>m.text).join('\n').slice(-1600),
  previousReplies:recent.filter(m=>m.role==='assistant').slice(-2).map(m=>m.text.slice(-1600))};
}

export function retrieveSourceMemories(catalog,{text='',historyText='',previousReplies=[],state=null,limit=3,maxBytes=SOURCE_BODY_BUDGET}={}){
 if(catalog.role_replaced)return {selected:[],omitted:[],bytes:0,allow_reference:false};
 const byId=new Map(catalog.rows.map(r=>[r.id,r]));
 const followup=/^(?:那(?:后来)?呢|然后呢|后来呢|后来怎么样了|继续(?:说)?|再多说(?:一点)?|それで|それから|その後は)[。.!！?？~～]*$/.test(String(text).trim());
 const changedTopic=/换个话题|换个话说|换个问题|换一件事|話題を変|別の話/u.test(text);
 const refersBack=!changedTopic && /(?:你刚(?:才|刚)?(?:说|提|讲)(?:到|过)?的|刚才(?:那|这)?[两兩几幾]段|さっき(?:話した|言った|の話)|先ほどの話)/u.test(text);
 const cues=refersBack?previousReplies.slice(/[两兩几幾]段|二つの話/u.test(text)?-2:-1).reverse():[];
 const referenceTopic=referenceQuestion(text)||(followup&&referenceQuestion(historyText));
 const allowReference=referenceTopic||cues.some(referenceQuestion);
 let query=text;
 if((followup||!sourceTerms(text).length)&&historyText)query=String(historyText).slice(-1600)+'\n'+text;
 if(/^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|早安|晚安|谢谢|好的)[。.!！?？~～]*$/.test(String(text).trim()))query='';
 const search=t=>{
  const hits=indexFor(catalog).search(t,{prefix:false,fuzzy:false,filter:r=>allowReference||r.subject===catalog.subject});
  if(catalog.context?.schema!=='asuka.character-context/2')return hits;
  const present=presentCue.test(t)&&!pastCue.test(t);
  const carriesTopic=term=>!conversationalTerms.has(term)&&!(present&&dailyActivityTerms.has(term));
  const relevant=hits.filter(hit=>hit.terms.some(carriesTopic));
  if(namesReferencePerson.test(t)){
   // When the question identifies a particular subject, matching the name
   // shared by all of her scenes is insufficient to include a different scene.
   const topical=relevant.filter(hit=>hit.terms.some(term=>carriesTopic(term)&&!nameOrRelation.has(term)));
   if(topical.length)return topical;
  }
  return relevant;
 };
 const lexical=search(query);
 const stateResult=state&&!referenceTopic?stateSourceMatches(catalog,state):{matches:[],omitted:[]};
 const ordered=[];const add=(id,reason)=>{
  const row=byId.get(id);if(!row)return;
  let item=ordered.find(x=>x.row.id===id);if(!item){item={row,reasons:[]};ordered.push(item);}item.reasons.push(reason);
 };
 // Reserve one source-candidate opportunity for a grounded association.
 if(stateResult.matches[0])add(stateResult.matches[0].id,stateResult.matches[0]);
 if(cues.length){
  // Two facts can belong to the same scene (e.g. eating a bento and cooking
  // for someone). An explicit reference identifies which fact was discussed.
  const hits=cues.map(cue=>search(cue)[0]).filter(Boolean);
  const latest=hits.shift();
  if(latest)add(latest.id,{route:'previous_reply_lexical',score:latest.score,terms:latest.terms});
  if(lexical[0])add(lexical[0].id,{route:'lexical',score:lexical[0].score,terms:lexical[0].terms});
  for(const hit of hits)add(hit.id,{route:'previous_reply_lexical',score:hit.score,terms:hit.terms});
 }
 for(const hit of (cues.length?lexical.slice(1):lexical))add(hit.id,{route:'lexical',score:hit.score,terms:hit.terms});
 const omitted=[...stateResult.omitted];
 for(const hit of stateResult.matches.slice(1)){
  if(ordered.some(item=>item.row.id===hit.id))add(hit.id,hit);
  else omitted.push({id:hit.id,route:'state',reason:'state_candidate_budget'});
 }
 const selected=[],seenGroups=new Set();let bytes=0;
 for(const item of ordered){
  if(seenGroups.has(item.row.event_group)){omitted.push({id:item.row.id,reason:'same_event_group'});continue;}
  const row={...item.row,recall_route:item.reasons.some(r=>r.route==='state')?'state':'lexical'},size=jsonBytes(sourceMemoryView(row));
  if(selected.length>=limit||bytes+size>maxBytes){omitted.push({id:row.id,reason:'body_budget'});continue;}
  seenGroups.add(row.event_group);bytes+=size;selected.push({...row,retrieval_reasons:item.reasons});
 }
 return {selected,omitted,bytes,allow_reference:allowReference};
}
export function injectV2LightMemories(prompt,catalog,currentText,historyText='',previousReplies=[],late=false){
 const result=retrieveSourceMemories(catalog,{text:currentText,historyText,previousReplies});
 const selected=result.selected.map(sourceMemoryView),encoded=JSON.stringify(selected).replace(/</g,'\\u003c').replace(/>/g,'\\u003e');
 const pattern=/<available_memories>[\s\S]*?<\/available_memories>/g;
 need((prompt.match(pattern)||[]).length===1,'CHAT_MEMORY_BLOCK');
 const profile=/<character_profile>[\s\S]*?<\/character_profile>/g;
 need((prompt.match(profile)||[]).length===1,'CHAT_CHARACTER_PROFILE_BLOCK');
 const life=recentLifeGuide(catalog.context,currentText,{hasDialogue:Boolean(historyText.trim()||previousReplies.length)});
 const framed=prompt.replace(profile,()=>'<character_profile>\n'+renderV2Persona(catalog.context)+'\n</character_profile>');
 if(!late)return {prompt:framed.replace(pattern,()=>'<available_memories>\n'+encoded+'\n</available_memories>'+(life?'\n\n'+life:'')),selected};
 const facts=catalog.context.role_overrides?.current_life;
 const relation=originalRelation(catalog.context,currentText);
 const data={...(selected.length?{available_memories:selected}:{}),...(facts?{current_life:facts}:{}),
  ...(relation?{current_relation:relation}:{}),...(life?{recent_life_guidance:life}:{})};
 return {prompt:framed.replace(pattern,''),selected,tail:Object.keys(data).length?'<turn_reference>'+encodeRoleData(data)+'</turn_reference>':''};
}
