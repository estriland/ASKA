import {initiativeDispatch} from './relationship-initiative.mjs';

export async function relationshipRoute(route,body,env){
  const {store,session}=env;
  // The server has already checked the native client's POST and origin.
  // Cancellation touches an existing ephemeral request only, even while the
  // public turn is still being saved. It never creates or reads a draft.
  if(route==='/relationship/followup/cancel')return env.followups.route('cancel',body,session);
  if(body.relationship_id&&body.relationship_id!==store.id)throw Error('关系资料已切换');
  store.sync(session);
  if(route==='/relationship')return store.list();
  if(route.endsWith('/groups')){
    if(body.action==='create')return {ok:true,group:store.createGroup(body.title),groups:store.groups()};
    if(body.action==='rename')store.renameGroup(body.group_id,body.title);
    else if(body.action==='remove'){
      store.removeGroup(body.group_id);
      if(env.followups?.current?.group===body.group_id)env.followups.cancel();
    }
    else throw Error('未知的分组操作');
    return {ok:true,groups:store.groups()};
  }
  if(route.endsWith('/history'))return store.history(body);
  if(route.endsWith('/search')){
    const text=String(body.text??'').trim();if(!text||text.length>2000)throw Error('请输入要查找的内容');
    if(body.group_id)store.validGroup(body.group_id);
    const memories=store.memory.recall({text,explicit:true,limit:30,...(body.group_id?{group_id:body.group_id}:{})})
      .filter(m=>!body.group_id||m.group_id===body.group_id);
    const summaries=store.memory.summaries({request_ids:memories.map(m=>m.request_id),limit:12});
    return {ok:true,memories,summaries};
  }
  if(route.endsWith('/journal')){
    if(body.group_id)store.validGroup(body.group_id);
    return {ok:true,events:store.scheduler.journal().filter(event=>!body.group_id||event.group_id===body.group_id),
      summaries:store.memory.summaries({...(body.group_id?{group_id:body.group_id}:{}),limit:50})};
  }
  if(route.endsWith('/call')){
    const result=store.callEvent(body);
    if(env.followups?.current?.call===body.call_id && ['ended','interrupted'].includes(body.kind))env.followups.cancel();
    return result;
  }
  if(route.endsWith('/replay-cleaned')){store.cleanReplay(body.ids);return {ok:true};}
  if(route.endsWith('/erase'))return env.erase(body.request_ids);
  if(route.startsWith('/relationship/followup/'))return env.followups.route(route.split('/').at(-1),body,session);
  if(route.startsWith('/relationship/initiative/')){
    const action=route.split('/').at(-1);
    if(store.indexRetry&&action!=='ack')return {ok:true,item:null,claim:null};
    if(body.call_id&&!store.db.prepare('SELECT 1 FROM call_log WHERE id=? AND ended IS NULL').get(body.call_id))
      return action==='ack'?initiativeDispatch({...env,scheduler:store.scheduler,body,action}):{ok:true,item:null,claim:null};
    return initiativeDispatch({...env,scheduler:store.scheduler,body,action});
  }
  throw Error('未知的关系资料操作');
}
