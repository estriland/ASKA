// A versioned, read-only character catalogue shared by desktop modes.
// Conversation learning and numeric state continue through the existing core.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {compactMemoryTerms} from './personality/general-network/compact-memory.mjs';
import {loadV2Catalog,sourceMemoryView,injectV2LightMemories} from './character-memory-v2.mjs';
const PROJECT=path.resolve(import.meta.dirname,'..');
export const CHARACTER_MEMORY_ROOT=path.resolve(process.env.ASUKA_CHARACTER_MEMORY_ROOT||path.join(PROJECT,'brain/personality/character-memory'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!v.includes('\0');
const LAYERED_PROFILE='layered_profile/1';
const referenceRows=refs=>refs.map(({subject,label,continuity,relation,aliases})=>({subject,label,continuity,relation,aliases,role:'reference_person'}));
export function validateMemoryVersion(version){
 if(typeof version!=='string'||!/^memory-[a-f0-9]{64}$/.test(version))fail('CHAT_MEMORY_VERSION_INVALID');return version;
}
export function defaultMemoryVersion(root=CHARACTER_MEMORY_ROOT){
 const newer=path.join(root,'default-v2.json'),file=fs.existsSync(newer)?newer:path.join(root,'default.json');let value;
 try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){throw Object.assign(new Error('角色记忆目录暂时无法读取'),{code:'CHAT_MEMORY_VERSION_MISSING',cause:error});}
 if(value.schema!=='asuka.character-memory-default/1')fail('CHAT_MEMORY_VERSION_INVALID');return validateMemoryVersion(value.version);
}
export function desktopMemoryVersion(settings,subject) {
 if (settings && Object.hasOwn(settings,'character_memory_version')) return settings.character_memory_version??undefined;
 return subject==='asuka.shikinami' ? defaultMemoryVersion(settings?.character_memory_root||CHARACTER_MEMORY_ROOT) : undefined;
}
export function loadCharacterMemory(version,{root=CHARACTER_MEMORY_ROOT,subject='asuka.shikinami',anchor}={}){
 validateMemoryVersion(version);const file=path.join(root,version,'catalog.json');let bytes;
 try{bytes=fs.readFileSync(file);}catch(error){throw Object.assign(new Error('已保存的角色记忆版本暂时无法读取'),{code:'CHAT_MEMORY_VERSION_MISSING',cause:error});}
 if(bytes.length>256*1024||digest(bytes)!==version.slice(7))fail('CHAT_MEMORY_VERSION_CHANGED');
 let pack;try{pack=JSON.parse(bytes);}catch{fail('CHAT_MEMORY_CATALOG');}
 if(pack.schema==='asuka.character-memory-catalog/2')return loadV2Catalog(pack,{version,file,subject});
 if(pack.schema!=='asuka.character-memory-catalog/1'||pack.subject!==subject||!text(pack.time_anchor_id,120)
   ||anchor&&pack.time_anchor_id!==anchor||!/^[a-f0-9]{64}$/.test(pack.base_policy_sha256??''))fail('CHAT_MEMORY_PERIOD');
 if(!Array.isArray(pack.records)||!pack.records.length||pack.records.length>96)fail('CHAT_MEMORY_ROWS');
 const ids=new Set(),rows=pack.records.map((r,i)=>{
  if(!r||!/^m[0-9]{3}$/.test(r.id??'')||ids.has(r.id))fail('CHAT_MEMORY_ROW_ID');ids.add(r.id);
  if(r.admitted_before_anchor!==true||r.subject!==subject||r.time_anchor_id!==pack.time_anchor_id)fail('CHAT_MEMORY_ROW_PERIOD');
  if(!text(r.label,80)||!text(r.content,800)||!text(r.period,80)||!['fact','belief','uncertain'].includes(r.epistemic_status)
    ||!['event_memory','self_narrative','established_knowledge'].includes(r.memory_kind)
    ||!Array.isArray(r.keywords)||r.keywords.length>40||r.keywords.some(x=>!text(x,60))
    ||!Array.isArray(r.provenance)||!r.provenance.length||r.provenance.some(p=>!text(p.path,1024)||!/^[a-f0-9]{64}$/.test(p.sha256??'')||!text(p.json_pointer||p.locator,1200)))fail('CHAT_MEMORY_ROW');
  return {...r,kind:'character_memory',source:{path:file,sha256:version.slice(7),json_pointer:'/records/'+i}};
 });
 const directory=rows.map(({id,label})=>({id,label}));
 if(Buffer.byteLength(JSON.stringify(directory))>6400)fail('CHAT_MEMORY_DIRECTORY_BUDGET');
 const core=pack.core??null;
 if(core){
  if(core.schema!=='asuka.character-core/1'||core.subject!==subject||core.time_anchor_id!==pack.time_anchor_id
    ||!Array.isArray(core.personal_facts)||core.personal_facts.length>8||!Array.isArray(core.name_attribution)||core.name_attribution.length>8)fail('CHAT_MEMORY_CORE');
  for(const fact of core.personal_facts)if(!text(fact.key,60)||!text(fact.text,450)||!Array.isArray(fact.memory_ids)
    ||!fact.memory_ids.length||fact.memory_ids.some(id=>!ids.has(id)))fail('CHAT_MEMORY_CORE_SOURCE');
  for(const ref of core.name_attribution)if(!text(ref.subject,120)||ref.subject===subject||!text(ref.label,100)||!text(ref.continuity,100)
    ||!text(ref.relation,450)||!Array.isArray(ref.aliases)||ref.aliases.length>12||ref.aliases.some(x=>!text(x,80)))fail('CHAT_MEMORY_CORE_REFERENCE');
  if(core.presentation!==undefined){
   if(core.presentation!==LAYERED_PROFILE)fail('CHAT_MEMORY_CORE_PRESENTATION');
   if(core.personal_facts.some(f=>!['identity','upbringing','current_state'].includes(f.category)))fail('CHAT_MEMORY_CORE_CATEGORY');
   if(core.name_attribution.some(r=>!Array.isArray(r.match_terms)||r.match_terms.length>24||r.match_terms.some(t=>!text(t,80))))fail('CHAT_MEMORY_CORE_REFERENCE_TERMS');
  }
  // Check the largest possible payload, even when no reference matches a topic.
  const maximum=core.presentation===LAYERED_PROFILE
   ?{core_profile:characterCoreView(core),source_attribution:referenceRows(core.name_attribution)}:characterCoreView(core);
  if(Buffer.byteLength(JSON.stringify(maximum))>2200)fail('CHAT_MEMORY_CORE_BUDGET');
 }
 return {version,subject:pack.subject,time_anchor_id:pack.time_anchor_id,base_policy_sha256:pack.base_policy_sha256,rows,directory,core,file};
}
export function characterCoreView(core){
 if(!core)return null;
 if(core.presentation===LAYERED_PROFILE){
  const layer=category=>core.personal_facts.filter(f=>f.category===category).map(f=>f.text);
  return {subject:core.subject,identity:layer('identity'),upbringing:layer('upbringing'),current_state:layer('current_state')};
 }
 // Frozen pre-layering catalogues keep their original model-visible projection.
 return {subject:core.subject,personal_facts:core.personal_facts.map(({key,text})=>({key,text})),
  name_attribution:referenceRows(core.name_attribution),
  reading:'按subject读取各自独立的人物档案。发言围绕本人经历和当前交流；对方问句中的姓名与关系，依据这份资料核对。'};
}
function mentions(currentText,term){
 const normalized=String(currentText??'').normalize('NFKC').toLowerCase(),needle=term.normalize('NFKC').toLowerCase();
 let start=normalized.indexOf(needle);
 while(start>=0){
  const end=start+needle.length;
  if(!(/^[a-z0-9_]/.test(needle)&&/[a-z0-9_]/.test(normalized[start-1]??''))
    &&!(/[a-z0-9_]$/.test(needle)&&/[a-z0-9_]/.test(normalized[end]??'')))return true;
  start=normalized.indexOf(needle,start+1);
 }
 return false;
}
export function characterReferenceView(core,{currentText=''}={}){
 if(core?.presentation!==LAYERED_PROFILE)return [];
 // Dialogue history already carries the preceding exchange. References are
 // selected afresh from this message, so an unrelated topic leaves them out.
 return referenceRows(core.name_attribution.filter(r=>[...r.aliases,...r.match_terms].some(t=>mentions(currentText,t))));
}
export function characterMemoryView(row){
 if(row?.kind!=='character_memory')fail('CHAT_MEMORY_VIEW_KIND');
 if(row.data_schema===2)return sourceMemoryView(row);
 return {kind:row.memory_kind==='self_narrative'?'当时自己的认识':row.memory_kind==='established_knowledge'?'熟悉的事实':'亲历与见闻',
  subject:row.subject,period:row.period,label:row.label,memory:row.content,
  ...(row.epistemic_status==='uncertain'?{certainty:'尚有不确定之处'}:{})};
}
export function selectLightMemories(catalog,currentText,historyText=''){
 const current=compactMemoryTerms(String(currentText).slice(-4000)),history=compactMemoryTerms(String(historyText).slice(-2400));
 const conversational=new Set(['喜欢','认识','知道','觉得','什么','怎样','怎么','你的','你是','记得','能说','说说','现在','已经','那个','这个']);
 for(const word of conversational){current.delete(word);history.delete(word);}
 const scored=catalog.rows.map(row=>{
  const terms=compactMemoryTerms([row.label,...row.keywords].join(' '));let now=0,prior=0;
  for(const t of terms){if(current.has(t))now++;if(history.has(t))prior++;}
  return {row,now,score:now*4+prior};
 });
 // Clear topic changes use the new input; short references can use recent dialogue.
 const followup=/^(那|后来|然后|这|还|怎么|为什么|是吗|继续|それ|あれ|その|どう)/.test(String(currentText).trim());
 const pool=scored.some(x=>x.now>0)?scored.filter(x=>x.now>0):followup?scored.filter(x=>x.score>0):[];
 pool.sort((a,b)=>b.score-a.score||(a.row.id<b.row.id?-1:1));
 return pool.slice(0,3).map(x=>x.row);
}
export function injectLightMemories(prompt,catalog,currentText,historyText='',previousReplies=[],late=false){
 if(catalog.schema_version===2)return injectV2LightMemories(prompt,catalog,currentText,historyText,previousReplies,late);
 const values=selectLightMemories(catalog,currentText,historyText).map(characterMemoryView);
 const encode=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e');
 const core=catalog.core?'<character_core>\n'+encode(characterCoreView(catalog.core))+'\n</character_core>\n\n':'';
 const references=characterReferenceView(catalog.core,{currentText});
 const attribution=references.length?'<source_attribution>\n'+encode(references)+'\n</source_attribution>\n\n':'';
 const block=core+attribution+'<available_memories>\n'+encode(values)+'\n</available_memories>';
 const pattern=/<available_memories>[\s\S]*?<\/available_memories>/g;
 if((prompt.match(pattern)||[]).length!==1)fail('CHAT_MEMORY_BLOCK');
 return {prompt:prompt.replace(pattern,()=>block),selected:values};
}
