// Read-only definitions are configuration, not observations, event occurrences
// or learned rewards. Labels are display text; matching is always explicit ID.
import {fingerprint} from './assembly-identity.mjs';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const clone=structuredClone;
function need(ok,code,path){if(!ok)throw Object.assign(new Error(`${code}: ${path}`),{code,path});}
function exact(value,keys,path){need(object(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'),'DEFINITION_FIELDS',path);}

export function validateIdentityCatalog(catalog,{namespace,subject}={}){
  exact(catalog,['schema','character_version','subject','actors','activities'],'identity_catalog');
  need(catalog.schema==='asuka.identity-definitions/1','DEFINITION_SCHEMA','identity_catalog.schema');
  need(text(catalog.character_version)&&text(catalog.subject)&&!['self','user'].includes(catalog.subject),'DEFINITION_IDENTITY','identity_catalog');
  if(namespace!==undefined)need(catalog.character_version===namespace.character_version,'DEFINITION_VERSION_MISMATCH','identity_catalog.character_version');
  if(subject!==undefined)need(catalog.subject===subject,'DEFINITION_SUBJECT_MISMATCH','identity_catalog.subject');
  for(const group of ['actors','activities']){
    need(Array.isArray(catalog[group]),'DEFINITION_ARRAY','identity_catalog.'+group);
    const seen=new Set();
    for(const [index,record]of catalog[group].entries()){
      const p=`identity_catalog.${group}[${index}]`;exact(record,['id','label'],p);
      need(text(record.id)&&text(record.label),'DEFINITION_ID',p);
      need(!seen.has(record.id),'DEFINITION_DUPLICATE',p+'.id');seen.add(record.id);
      if(group==='actors')need(record.id!==catalog.subject&&record.id!=='self','DEFINITION_SELF_RELATION',p+'.id');
    }
  }
  return clone(catalog);
}

/** Weights deliberately stay in the frozen model. Equal actor/activity strings
 * are separate definition kinds and never aliases of one another. */
export function buildIdentityCatalog(profile){
  need(object(profile)&&text(profile.version)&&text(profile.subject),'DEFINITION_PROFILE','profile');
  need(object(profile.relations)&&object(profile.interests),'DEFINITION_PROFILE_TABLES','profile');
  const actors=new Map(Object.keys(profile.relations).map(id=>[id,id]));
  if(Object.hasOwn(profile,'known_actors')){
    need(Array.isArray(profile.known_actors),'DEFINITION_KNOWN_ACTORS','profile.known_actors');
    const seen=new Set();
    for(const [index,row]of profile.known_actors.entries()){
      const p=`profile.known_actors[${index}]`;exact(row,['id','label'],p);
      need(text(row.id)&&text(row.label),'DEFINITION_ID',p);
      need(!seen.has(row.id),'DEFINITION_KNOWN_ACTOR_DUPLICATE',p+'.id');
      need(row.id!==profile.subject&&row.id!=='self'&&row.id!=='user','DEFINITION_KNOWN_ACTOR_RESERVED',p+'.id');
      seen.add(row.id);actors.set(row.id,row.label);
    }
  }
  return validateIdentityCatalog({schema:'asuka.identity-definitions/1',character_version:profile.version,subject:profile.subject,
    actors:[...actors.keys()].sort().map(id=>({id,label:actors.get(id)})),
    activities:Object.keys(profile.interests).sort().map(id=>({id,label:id}))});
}

export function assertIdentityCatalogMatchesProfile(catalog,profile){
  const checked=validateIdentityCatalog(catalog,{subject:profile.subject,namespace:{character_version:profile.version}});
  need(fingerprint(checked)===fingerprint(buildIdentityCatalog(profile)),'DEFINITION_PROFILE_MISMATCH','identity_catalog');
  return checked;
}
