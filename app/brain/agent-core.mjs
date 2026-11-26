// asuka-ai/brain/agent-core.mjs
// 明日香 AI 助手 - Agent 内核（Pi 统一大脑）
// 基于 Pi SDK (createAgentSession + ModelRuntime + subscribe)
// 模型源（本地35B / DeepSeek API）运行时可切换，默认 DeepSeek
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chatResourceOptions } from "./chat-resources.mjs";
import {desktopReferenceGuide,chatToolAvailability,desktopReplyFormat} from './desktop-prompt.mjs';
import {desktopMemoryVersion,loadCharacterMemory,injectLightMemories} from './character-memory.mjs';
import {loadRoleSettings,withRoleSettings,roleData,encodeRoleData,lightTransportContext} from './role-settings.mjs';
import {sourceDialogueCue,renderV2Persona} from './character-memory-v2.mjs';
import {loadSelection} from './personality/client-packages.mjs';
import {publicMessages, textContent} from './personality/shin-dev/history.mjs';
import {messagePlaybackId} from './playback-identity.mjs';
import {deletionReceipt,prepareRemoval,eraseSessionRecords,catalogRemovalFilter} from './conversation-erasure.mjs';
import {SessionCatalog,storedSessionId,callMessageEntries} from './session-catalog.mjs';
import {Relationship} from './relationship.mjs';
import {relationshipRoute} from './relationship-api.mjs';
import {ImmediateFollowups,followupCompletionFor} from './immediate-followup.mjs';
import {eraseRelationshipTurns,pendingRelationshipErasure} from './relationship-erasure.mjs';
import {registerModelService,modelTarget} from './model-service.mjs';
import {readPiContextUsage} from './context-usage.mjs';
import { randomUUID,createHash } from "node:crypto";
import {LOCAL_AGENT_GUIDE} from './local-agent.mjs';
import {SECURITY_TOOL_NAMES,securityTools,loadSecurity,toolNames,refreshSecurity,securityGuide,saveSecurity} from './tool-security.mjs';
import {FILE_GUIDE,visibleFileMessage} from './file-attachments.mjs';
import {loadInference,registerDeepSeekModels,selectStageModel,inferenceOptions,inferenceNote,DEEPSEEK_MODELS} from './inference-settings.mjs';
import {createIndependentGeneration,independentHandler} from './independent-generation.mjs';
import {spokenLine} from './voice/spoken-line.mjs';
import {bindDialogueForSession,bindDialogueStateForSession,dialogueStateDirectory} from './dialogue-session.mjs';
import {dialogueExpressionGuide,dialogueLocalizationStyle,makeDialogueContext} from './dialogue-context.mjs';
import {LIGHT_FORMAT,LEGACY_LIGHT_FORMAT,SELECTED_VOICE_FORMAT,singleVoiceFormat,needsLightLanguageRepair,finalizeLightBehavior,cachedLightBehavior,textOnlyLanguageFallback} from './light-reply-format.mjs';
import {chineseCaption,detectedSpeechLanguage,explicitSpokenLanguage,lightSpokenLanguage} from './utterance-language.mjs';
import {SINGLE_VOICE,voiceTurnGuide,publishedVoice,callSpeechLanguage,callLineGuide} from './voice-turn.mjs';
import {readLightRequestSnapshot,bindLightRequestSnapshot} from './light-request-snapshot.mjs';
import {projectDesktopDialogue,publishedSessionMessages,recentPublicDialogue} from './desktop-dialogue.mjs';
import {referenceVisibleSpeech} from './relationship-reading.mjs';
import {applyRequestPayload,validateRequestTarget} from './request-options.mjs';
import {awaitAgentTurn} from './queued-turn.mjs';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';
import {assertSessionDirectoryWritable,assertSessionWritable,isStorageFailure,storageFailure} from './session-storage.mjs';

const PROJECT_ROOT = resolve(
  process.env.ASUKA_PROJECT_ROOT || dirname(dirname(fileURLToPath(import.meta.url))),
);
const PORT = Number(process.env.ASUKA_BRAIN_PORT || 18836);
const HOST = "127.0.0.1";
const BRAIN_PROTOCOL_VERSION = 37;
const isLight = body => !body.personality_mode || body.personality_mode === 'light';
const hasFormatContract = value => value===LIGHT_FORMAT || value===LEGACY_LIGHT_FORMAT || singleVoiceFormat(value);
const boundLanguage = record => record?.spoken_language ?? (record?.japanese_default===true?'ja':null);
const CUSTOM_API_PROVIDER = "custom-api";
const SUPPORTED_API_TYPES = new Set([
  "openai-completions", "openai-responses",
  "anthropic-messages", "google-generative-ai",
]);
const CLIENT_EVENT_CONTENT = Object.freeze({
  microphone_muted: [
    "<client_event type=\"microphone_muted\">",
    "用户刚刚关闭了当前语音通话的麦克风。这是客户端状态变化，不是用户输入的台词。",
    "请结合当前语境作出一句简短、自然且符合角色的回应；不要武断猜测关闭原因，也不要提到系统消息或客户端事件。",
    "</client_event>",
  ].join("\n"),
  microphone_unmuted: [
    "<client_event type=\"microphone_unmuted\">",
    "用户的麦克风已经重新加载完成并恢复监听。这是客户端状态变化，不是用户输入的台词。",
    "请结合当前语境作出一句简短、自然且符合角色的回应；不要提到系统消息、加载过程或客户端事件。",
    "</client_event>",
  ].join("\n"),
});
// 会话存储目录（持久化多会话，仿 Claude Code）
const AGENT_DIR = resolve(process.env.PI_AGENT_DIR || join(PROJECT_ROOT,"user-data","pi-agent"));
process.env.PI_AGENT_DIR ??= AGENT_DIR;
process.env.PI_CODING_AGENT_DIR ??= AGENT_DIR;
const SESSION_DIR = resolve(
  process.env.ASUKA_SESSION_DIR
    || join(PROJECT_ROOT,"user-data","sessions"),
);
const CWD = PROJECT_ROOT;
const BRAIN_ERROR_LOG = process.env.ASUKA_BRAIN_ERROR_LOG||join(PROJECT_ROOT, "data", "logs", "brain-errors.log");
const privateErrorValues=new Set([process.env.DEEPSEEK_API_KEY].filter(Boolean));
function errorText(error){
  let value=String(error);
  for(const secret of privateErrorValues)value=value.split(secret).join('[REDACTED]');
  return value.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
    .replace(/(["']?api[_-]?key["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,'$1[REDACTED]');

}

function logBrainError(stage, error) {
  try {
    mkdirSync(dirname(BRAIN_ERROR_LOG), { recursive: true });
    // Budget diagnosis needs counts and the failed phase, never prompt/image contents.
    const budgetDetails=error?.code==='LAYOUT_INPUT_BUDGET'?{
      code:error.code,phase:['analysis','reply'].includes(error.phase)?error.phase:null,
      ...Object.fromEntries(['estimate','budget','text_estimate','image_estimate','image_count','message_count']
        .filter(k=>Number.isFinite(error[k])).map(k=>[k,error[k]])),
    }:null;
    appendFileSync(
      BRAIN_ERROR_LOG,
      `${new Date().toISOString()} stage=${stage} error=${errorText(error)}${budgetDetails?' diagnostic='+JSON.stringify(budgetDetails):''}\n`,
      "utf8",
    );
  } catch { /* 诊断日志不能阻断主链路 */ }
}

// 默认模型源（DeepSeek v4 pro）

// 可选人格：从人格板块的单一文件读取，再追加 Pi 的行为对象输出协议。
// JSON 结构保持统一；角色模式与中性后备模式各自追加独立语言策略，避免互相污染。
const PERSONA_FILE = new URL("./personality/default-light-prompt.md", import.meta.url);
const PI_PROTOCOL_BASE = `

只返回一个最终 JSON 行为对象。speech 写本人此刻愿意说给对方的台词；简单回应可收住，在意的话题可以讲到自然停顿。translation 写中文译文，language 取 ja、zh 或 en。
emotion 选 angry、happy、sad、shy、calm、excited、lost；action 选 cross_arms、smirk、pout、wave、tilt_head；tone 选 tsundere、gentle、excited、teasing、calm。
有明显停顿时可附 pauses 数组，如 [{"idx":0,"level":"medium"}]。idx 是从 0 起的小句序号，level 取 strong、medium、weak。`;

const ASUKA_LANGUAGE_POLICY = `

## 当前角色语言策略
- 默认用自然日语说话，用户明确指定中文或英文时使用指定语言。speech 里的每一句都按所选语言的语法写成完整台词，引用原话、专名和编号保留原文。
- 角色资料和历史译文供理解事实与人物归属。先写 speech，再把同一句话的中文意思放进 translation。中文台词的 translation 留空。
- language 填台词实际使用的语言代码，取 ja、zh 或 en。`;

const NEUTRAL_LANGUAGE_POLICY = `

## 中性后备语言策略
- speech: 使用用户当前使用或明确要求的语言，保持中性、友好、简洁。
- translation: 只有需要中文翻译时填写，否则使用空字符串。
- language: 填写 speech 的实际语言代码（ja/zh/en）。`;

// Freeze the selected files at Brain startup, including the lazy native runtime.
const loadedPersonality = loadSelection(PROJECT_ROOT);
let ASUKA_SYSTEM_PROMPT;
let signedPersonaTemplate;
let sharedLightDefault=false;
function isSharedLightText(persona){
  try{const expected=JSON.parse(readFileSync(new URL('./personality/default-character-source.json',import.meta.url),'utf8'));
    return createHash('sha256').update(persona.replace(/\r\n/g,'\n')).digest('hex')===expected.derived_sha256;
  }catch{return false;}
}
try {
  const persona = loadedPersonality.light?.prompt ?? readFileSync(PERSONA_FILE, "utf-8");
  sharedLightDefault=!loadedPersonality.light&&isSharedLightText(persona);
  if(sharedLightDefault)signedPersonaTemplate=persona.replace(/\r\n/g,'\n');
  ASUKA_SYSTEM_PROMPT = persona + PI_PROTOCOL_BASE + ASUKA_LANGUAGE_POLICY;
  console.log("📖 已加载 Light 人格启动快照");
} catch {
  ASUKA_SYSTEM_PROMPT = `你是一个可配置的本地桌面语音助手。当前没有安装自定义人格文件。`
    + PI_PROTOCOL_BASE + NEUTRAL_LANGUAGE_POLICY;
  console.warn("⚠️ 未找到默认人物提示，已使用中性后备人格");
}

const BEHAVIOR_DEFAULTS = {
  emotion: "calm", action: "", tone: "gentle",
  speech: "", translation: "", language: "ja", pauses: [],
};

function sanitizeSpeech(value) {
  let speech = String(value || "").replace(/```(?:json)?|```/gi, "").trim();
  // 模型偶尔在格式漂移时以 --- 分隔两个近似草稿。行为协议不允许
  // Markdown 分段，因此出现多个长段时把最后一段视为最终版本。
  const drafts = speech.split(/^\s*-{3,}\s*$/m).map(s => s.trim()).filter(Boolean);
  if (drafts.length > 1 && drafts[drafts.length - 1].length >= 80) {
    speech = drafts[drafts.length - 1];
  } else {
    speech = drafts.join("\n");
  }
  return speech.trim();
}

function normalizeBehavior(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const speech = typeof value.speech === "string" ? sanitizeSpeech(value.speech) : "";
  if (!speech && value.silence === true && (value.speech == null || value.speech === ''))
    return {speech:'',translation:'',pauses:[],silence:true};
  if (!speech) return null;
  return {
    ...BEHAVIOR_DEFAULTS,
    emotion: typeof value.emotion === "string" ? value.emotion : "calm",
    action: typeof value.action === "string" ? value.action : "",
    tone: typeof value.tone === "string" ? value.tone : "gentle",
    speech,
    translation: typeof value.translation === "string" ? value.translation.trim() : "",
    language: typeof value.language === "string" ? value.language : "ja",
    pauses: Array.isArray(value.pauses) ? value.pauses : [],
  };
}

function decodeLooseString(value) {
  return String(value)
    // 宽容恢复面对的是无效 JSON。LaTeX 的 \nu、\nabla、\theta、\rho
    // 也以 JSON 转义字母开头，不能把它们误解成换行/制表符。
    .replace(/\\n(?![A-Za-z])/g, "\n")
    .replace(/\\r(?![A-Za-z])/g, "\r")
    .replace(/\\t(?![A-Za-z])/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

function extractLooseString(text, key, nextKeys) {
  const boundary = nextKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(
    `"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"(?:${boundary})"\\s*:`, "i");
  const match = text.match(pattern);
  return match ? decodeLooseString(match[1]) : "";
}

function recoverMalformedBehavior(cleaned) {
  // 模型偶尔会在字段值里直接写未转义双引号，例如：
  // "translation":"啊，是"起床"啊","language":"ja"
  // 以相邻字段名作为边界提取，避免把整个 JSON 当作 speech。
  const speech = extractLooseString(cleaned, "speech", ["translation", "language", "pauses"]);
  if (!speech) return null;
  const translation = extractLooseString(cleaned, "translation", ["language", "pauses"]);
  const readSimple = (key, fallback) => {
    const match = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]*)"`, "i"));
    return match ? decodeLooseString(match[1]) : fallback;
  };
  let pauses = [];
  const pausesMatch = cleaned.match(/"pauses"\s*:\s*(\[[\s\S]*?\])\s*[,}]/i);
  if (pausesMatch) {
    try { pauses = JSON.parse(pausesMatch[1]); } catch { pauses = []; }
  }
  return normalizeBehavior({
    emotion: readSimple("emotion", "calm"),
    action: readSimple("action", ""),
    tone: readSimple("tone", "gentle"),
    speech,
    translation,
    language: readSimple("language", "ja"),
    pauses,
  });
}

// 提取文本中的第一个完整 JSON 对象；严格解析失败时再做受控字段恢复。
export function extractBehavior(text, requestedLanguage=null) {
  // 去掉可能的 ```json 代码块围栏
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) {
    const plain = cleaned.trim();
    if(!plain)return {error:'模型返回为空'};
    // Some providers return just the requested Mandarin utterance. Retain its
    // exact wording and paragraphs with the language bound before dispatch.
    const chinese=requestedLanguage==='zh' && chineseCaption(plain) && detectedSpeechLanguage(plain)==='zh';
    return normalizeBehavior(chinese?{speech:plain,language:'zh',translation:''}:{speech:plain});
  }
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = normalizeBehavior(JSON.parse(cleaned.slice(start, i + 1)));
            if (parsed) return parsed;
          } catch { /* 转入宽容字段恢复 */ }
          break;
        }
      }
    }
  }
  const recovered = recoverMalformedBehavior(cleaned);
  return recovered || { error: "模型行为对象格式错误" };
}

export function resolveSessionPath(sessionDir, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error("未提供会话路径");
  }
  const root = resolve(sessionDir);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)
      || !target.toLowerCase().endsWith(".jsonl")) {
    throw new Error("会话路径超出允许目录");
  }
  return target;
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return value;
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp",
]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function normalizeImages(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("images 必须是数组");
  if (value.length > 16) throw new Error("每条消息最多16张图片或PDF页面");
  if(value.reduce((n,image)=>n+(typeof image?.data==='string'?image.data.length:0),0)>24*1024*1024)throw new Error('附件图像总量过大，请分次发送');
  return value.map((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error("图片数据格式错误");
    }
    const mimeType = String(image.mimeType || "").toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new Error("只支持 JPEG、PNG 和 WebP 图片");
    }
    const data = typeof image.data === "string"
      ? image.data.replace(/\s+/g, "") : "";
    if (!data || data.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error("图片 Base64 数据无效");
    }
    const decoded = Buffer.from(data, "base64");
    const canonical = decoded.toString("base64").replace(/=+$/, "");
    if (canonical !== data.replace(/=+$/, "")) {
      throw new Error("图片 Base64 数据无效");
    }
    if (!decoded.length || decoded.length > MAX_IMAGE_BYTES) {
      throw new Error("图片不得超过 4 MB");
    }
    return { type: "image", data, mimeType };
  });
}

export function normalizeApiProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("API 配置必须是对象");
  }
  const baseUrl = String(value.base_url || "").trim().replace(/\/+$/u, "");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("API 地址无效"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("API 地址只支持 HTTP/HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('API 地址不应包含凭据或查询串');
  const modelId = String(value.model_id || "").trim();
  if (!modelId || modelId.length > 200) throw new Error("模型 ID 无效");
  const api = String(value.api_type || "openai-completions").trim();
  if (!SUPPORTED_API_TYPES.has(api)) throw new Error("不支持的 API 协议");
  const contextWindow = Number(value.context_window ?? 128000);
  const maxTokens = Number(value.max_tokens ?? 8192);
  if (!Number.isInteger(contextWindow)
      || contextWindow < 4096 || contextWindow > 2_000_000) {
    throw new Error("上下文长度无效");
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 256
      || maxTokens > Math.min(contextWindow, 262144)) {
    throw new Error("最大输出长度无效");
  }
  if ((value.connection_id!==undefined || value.connection_revision!==undefined) &&
      (!/^[a-f0-9]{32}$/u.test(value.connection_id??'') || !/^[a-f0-9]{64}$/u.test(value.connection_revision??'')))
    throw new Error('已保存连接的标识无效');
  return {
    provider: CUSTOM_API_PROVIDER,
    name: String(value.name || "自定义 API").trim().slice(0, 80) || "自定义 API",
    baseUrl,
    apiKey: String(value.api_key || "").trim(),
    modelId,
    ...(value.connection_id ? {connectionId:value.connection_id,connectionRevision:value.connection_revision} : {}),
    api,
    vision: Boolean(value.supports_vision),
    reasoning: value.supports_reasoning===undefined ? parsed.origin==='https://api.deepseek.com' : Boolean(value.supports_reasoning),
    contextWindow,
    maxTokens,
  };
}

export function normalizeClientEvent(value) {
  const eventType = typeof value === "string" ? value : value?.type;
  if (typeof eventType !== "string" || !(eventType in CLIENT_EVENT_CONTENT)) {
    throw new Error("不支持的客户端事件");
  }
  return {
    type: eventType,
    content: CLIENT_EVENT_CONTENT[eventType],
  };
}

export async function main({modelRuntime:providedRuntime,testRuntime=false}={}) {
  console.log("加载明日香 Agent...");
  assertSessionDirectoryWritable(SESSION_DIR);

  const modelRuntime = providedRuntime || await ModelRuntime.create();
  registerDeepSeekModels(modelRuntime);
  let currentSession = null;   // 当前 agent session
  const relationship=process.env.ASUKA_RELATIONSHIP_DIR?new Relationship(resolve(process.env.ASUKA_RELATIONSHIP_DIR),
    {onProjectionError:error=>logBrainError('relationship-projection',error)}):null;
  const followups=relationship?new ImmediateFollowups(relationship,{onFailure:reason=>logBrainError(
    'followup-generation',Error([reason.outcome,reason.http_status,reason.provider_code].filter(Boolean).join(' ')))}):null;
  const catalog = new SessionCatalog(SESSION_DIR,CWD,()=>catalogRemovalFilter(SESSION_DIR));
  let currentModel = null;     // 当前模型（切会话时复用）
  let activeModelTurns = 0;
  const knownModelRoutes = new Map();
  const stageModels = {getModel:(provider,id)=>{
    const registered=modelRuntime.getModel(provider,id);
    return registered&&(knownModelRoutes.get(provider+'/'+id)||registered);
  }};
  let customApiProfile = null;
  // Old transcripts can still refer to this directory for reading or erasure.
  const generalHistory = relationship ? join(relationship.directory,'general') : undefined;
  const activeRequests = new Map();
  const requestProgress = new Map();
  const completedRequests = new Map();
  const activeTarget = model => {
    const target=modelTarget(model);
    if(model.provider===CUSTOM_API_PROVIDER && customApiProfile?.connectionId){
      target.connection_id=customApiProfile.connectionId;
      target.connection_revision=customApiProfile.connectionRevision;
    }
    return target;
  };
  function callSurface(body){
    const source=relationship?.source(body.request_id);
    return {...(callSpeechLanguage(body.call_language)||source?.call_id?{surface:'call'}:{}),
      ...(source?{group_id:source.origin_group_id,group_title:source.group_title,...(source.call_id?{call_id:source.call_id}:{})}:{})};
  }
  const requestKey=(body,sessionId)=>fingerprint({session:sessionId,
    payload:Object.fromEntries(Object.entries(body).filter(([k])=>!['request_id','session_id','manual_retry','immediate_followup'].includes(k)))});
  const dialogueDirectory=dialogueStateDirectory(SESSION_DIR,PROJECT_ROOT);
  const lightFormatDirectory=(sessionId,requestId)=>join(dialogueDirectory,'format-reports',fingerprint(sessionId),fingerprint(requestId));
  const awaitingSelectedTranslation=(start,behavior,sessionId)=>start?.publication_contract===SELECTED_VOICE_FORMAT &&
    Boolean(behavior?.voice_error) && !existsSync(join(lightFormatDirectory(sessionId,start.id),'selected-reading.json'));
  const visibleMessages=(manager,entryIds)=>publishedSessionMessages(manager,(text,start)=>{
    if(!hasFormatContract(start.publication_contract))return null;
    const raw=extractBehavior(text,boundLanguage(start));
    if(!needsLightLanguageRepair(raw,start.publication_contract,boundLanguage(start)))return null;
    const restored=textOnlyLanguageFallback(cachedLightBehavior(raw,lightFormatDirectory(manager.getSessionId(),start.id),
      start.publication_contract,boundLanguage(start)),start.publication_contract,boundLanguage(start));
    return awaitingSelectedTranslation(start,restored,manager.getSessionId())?false:restored;
  },entryIds);
  function sessionDialogue(session,body){
    const profile=bindDialogueForSession({session,project:PROJECT_ROOT,sessionDirectory:SESSION_DIR,generalDirectory:generalHistory});
    const ctx=relationship&&body?relationship.context(body):null;
    return ctx?{...profile,relationship_context:ctx}:profile;
  }
  const lightSnapshot=(session,body)=>{
    if(!body.request_id)return null;
    const record=readLightRequestSnapshot({directory:dialogueDirectory,
      sessionId:session.sessionId,requestId:body.request_id,requestKey:requestKey(body,session.sessionId)});
    const start=session.sessionManager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='asuka.request.start.v1'&&e.data?.id===body.request_id);
    if(record&&start?.data.dialogue_snapshot_sha256&&record.record_sha256!==start.data.dialogue_snapshot_sha256)
      throw Object.assign(new Error('请求记录与冻结设定不一致，未重复派发。'),{code:'DIALOGUE_REQUEST_HASH',retryable:false});
    return record;
  };
  const assertLightTarget=(record,model)=>{
    if(fingerprint(record.configuration.model)!==fingerprint(model)||record.selected_light!==loadedPersonality.selected.light
      ||record.security_sha256!==fingerprint(loadSecurity(PROJECT_ROOT)))throw Object.assign(new Error('这次请求需要原模型、人格和工具权限，请恢复设置后重试。'),{code:'REQUEST_CHANGED',retryable:false});
  };
  const lightConfiguration=(session,body)=>{
    const config=loadInference(PROJECT_ROOT),base={model:activeTarget(currentModel||session.model),light:config.light,request_policy:config.request};
    const saved=body&&lightSnapshot(session,body);if(saved){assertLightTarget(saved,base.model);return saved.configuration;}return base;
  };
  const safeUnstartedLightResume=(session,saved)=>{
    const branch=session.sessionManager.getBranch(),index=branch.findIndex(e=>e.id===saved.parent_id);
    // Cold opening may append model metadata; it must not have added another
    // input, tool action, compaction, or request since this snapshot was taken.
    if(saved.parent_id!==null&&index<0&&saved.had_messages)return false;
    return branch.slice(index+1).every(e=>['model_change','thinking_level_change','session_info','label'].includes(e.type));
  };
  function lightRetryState(session,id){
    const branch=session.sessionManager.getBranch(),index=branch.findLastIndex(e=>e.type==='custom'&&e.customType==='asuka.request.start.v1'&&e.data?.id===id);
    if(index<0)return null;
    const start=branch[index],tail=branch.slice(index+1),calls=new Map();let safe=true,uninterrupted=true;
    for(const entry of tail){
      if(['custom','custom_message','compaction','branch_summary'].includes(entry.type))uninterrupted=false;
      const message=entry.message;
      if(message?.role==='custom')uninterrupted=false;
      for(const item of Array.isArray(message?.content)?message.content:[])if(item.type==='toolCall'){
        calls.set(item.id,item.name);if(!['read','list_directory'].includes(item.name))safe=false;
      }
      if(message?.role==='toolResult'&&(!calls.has(message.toolCallId)||!['read','list_directory'].includes(message.toolName)))safe=false;
    }
    if(tail.filter(e=>e.message?.role==='user').length>1)uninterrupted=false;
    return {start,tail,safe:safe&&uninterrupted,uninterrupted};
  }
  function rememberedReply(body,session){
    if(body.session_id&&body.session_id!==session.sessionId)throw Object.assign(new Error('当前对话已切换'),{code:'SESSION_CHANGED'});
    if(!body.request_id)return null;
    const key=requestKey(body,session.sessionId),cached=completedRequests.get(body.request_id);
    if(cached){if(cached.key!==key)throw Object.assign(new Error('请求内容已改变'),{code:'REQUEST_CHANGED'});return cached.response;}
    if(body.personality_mode && !isLight(body)){
      const saved=session.sessionManager.getBranch().findLast(e=>e.message?.role==='assistant'&&e.message?.asukaNative?.record?.client_request_id===body.request_id);
      if(saved){
        const record=saved.message.asukaNative.record;
        const behavior=JSON.parse(textContent(saved.message.content));
        behavior.quality_mode=true;behavior.analysis_complete=record.analysis_complete===true;
        behavior.reply_saved=true;
        if(record.degraded_continuity===true)behavior.degraded_continuity=true;
        behavior.playback_id=behavior.playback_id||session.sessionId+':'+saved.id;
        return {behavior,personality:{mode:body.personality_mode,session_id:record.session_id,turn_id:record.turn_id,revision:record.revision,degraded_continuity:record.degraded_continuity===true}};
      }
    }
    if(isLight(body)){
      const saved=session.sessionManager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='asuka.request.result.v1'&&e.data?.id===body.request_id);
      if(saved){if(saved.data.key!==key)throw Object.assign(new Error('请求内容已改变'),{code:'REQUEST_CHANGED'});
        return {...saved.data.response,behavior:{...saved.data.response.behavior,reply_saved:true}};}
      const retry=lightRetryState(session,body.request_id);
      if(retry&&!activeRequests.has(body.request_id)){
        if(retry.start.data.key!==key)throw Object.assign(new Error('请求内容已改变'),{code:'REQUEST_CHANGED',retryable:false});
        const terminalEntry=retry.tail.findLast(e=>e.message?.role==='assistant'),terminal=terminalEntry?.message;
        if(retry.uninterrupted&&terminal?.stopReason==='stop'){
          const raw=extractBehavior(textContent(terminal.content),boundLanguage(retry.start.data));
          const contract=retry.start.data.publication_contract;
          const behavior=hasFormatContract(contract)
            ?cachedLightBehavior(raw,lightFormatDirectory(session.sessionId,body.request_id),contract,boundLanguage(retry.start.data)):textOnlyLanguageFallback(raw,LEGACY_LIGHT_FORMAT);
          if(behavior?.speech||behavior?.silence){behavior.playback_id=behavior.playback_id||session.sessionId+':'+terminalEntry.id;behavior.reply_saved=true;return {behavior,personality:{actualMode:'light',requestedMode:'light'}};}
        }
        if(!lightSnapshot(session,body))throw Object.assign(new Error('这轮缺少可验证的人物与权限快照，未按新设置重发。'),
          {code:retry.start.data.dialogue_snapshot_sha256?'DIALOGUE_REQUEST_MISSING':'DIALOGUE_LEGACY_PROMPT_UNKNOWN',retryable:false});
        const sameConfig=retry.start.data.configuration_sha256===fingerprint(lightConfiguration(session,body));
        if(!body.manual_retry||!retry.safe||!sameConfig)throw Object.assign(new Error('上次请求尚未完成，未重复操作'),
          {code:sameConfig?'REQUEST_UNCERTAIN':'REQUEST_CHANGED',retryable:retry.safe&&sameConfig});
        if(!session.isIdle||activeModelTurns)throw Object.assign(new Error('仍有请求在处理'),{code:'REQUEST_ACTIVE'});
        // Read-only preflight. Rewind only inside the queued, configured turn.
      }
      const savedInvocation=lightSnapshot(session,body);
      if(savedInvocation&&!retry&&!activeRequests.has(body.request_id)){
        assertLightTarget(savedInvocation,activeTarget(currentModel||session.model));
        const safe=safeUnstartedLightResume(session,savedInvocation);
        if(!body.manual_retry||!safe)throw Object.assign(new Error('上次请求的设定已保存，等待明确重试。'),{code:'REQUEST_UNCERTAIN',retryable:safe});
        if(!session.isIdle||activeModelTurns)throw Object.assign(new Error('仍有请求在处理'),{code:'REQUEST_ACTIVE'});
      }
    }
    return null;
  }
  function rewindLightRetry(session,body,configuration){
    const retry=body.request_id&&lightRetryState(session,body.request_id);
    if(!retry)return;
    const sameConfig=retry.start.data.configuration_sha256===fingerprint(configuration);
    if(retry.start.data.key!==requestKey(body,session.sessionId)||!sameConfig)
      throw Object.assign(new Error('请求内容已改变'),{code:'REQUEST_CHANGED',retryable:false});
    if(!body.manual_retry||!retry.safe)
      throw Object.assign(new Error('上次请求尚未完成，未重复操作'),{code:'REQUEST_UNCERTAIN',retryable:retry.safe});
    if(retry.start.parentId===null)session.sessionManager.resetLeaf();else session.sessionManager.branch(retry.start.parentId);
    session.agent.state.messages=publicMessages(visibleMessages(session.sessionManager));
  }
  function lightPreparation(session,body){
    const saved=lightSnapshot(session,body),retry=body.request_id&&lightRetryState(session,body.request_id);
    if(saved)return {saved};
    if(retry){
      if(retry.start.data.dialogue_snapshot_sha256)throw Object.assign(new Error('冻结人物设定缺失'),{code:'DIALOGUE_REQUEST_MISSING',retryable:false});
      throw Object.assign(new Error('旧请求没有可验证的人物与权限快照，未替换人物重发。'),{code:'DIALOGUE_LEGACY_PROMPT_UNKNOWN',retryable:false});
    }
    return {profile:sessionDialogue(session,body)};
  }
  function planLightInvocation(session,body,preparation,base,historyIds){
    const saved=lightSnapshot(session,body)||preparation.saved;
    if(saved){
      assertLightTarget(saved,base.model);
      if(!lightRetryState(session,body.request_id)&&(!body.manual_retry||!safeUnstartedLightResume(session,saved)))
        throw Object.assign(new Error('保存设定后对话已有变化，未重复操作。'),{code:'REQUEST_UNCERTAIN',retryable:false});
      return {configuration:saved.configuration,systemPrompt:saved.system_prompt,record:saved};
    }
    let prompt=session.systemPrompt,characterMemoryVersion,turnReference='';
    const policy=loadSecurity(PROJECT_ROOT);
    const roleSettings=preparation.profile?.role_settings;
    const fields=roleSettings?.overrides??{};
    const compact=preparation.profile?.schema==='asuka.dialogue-context/2';
    const approved=sharedLightDefault && compact && typeof preparation.profile.expression.language_switch==='string';
    if(approved){
      prompt=policy.mode==='chat'?signedPersonaTemplate:prompt.replace(PI_PROTOCOL_BASE,'').replace(ASUKA_LANGUAGE_POLICY,'').replace(FILE_GUIDE,'');
    }else if(compact&&policy.mode==='chat'){
      const guide='\n'+LOCAL_AGENT_GUIDE,at=prompt.lastIndexOf(guide);
      if(at>=0)prompt=prompt.slice(0,at)+prompt.slice(at+guide.length);
      prompt=prompt.replace(/\nCurrent working directory: [^\n]*\s*$/u,'');
    }
    const single=body.voice_turn===SINGLE_VOICE;
    const callLanguage=single?callSpeechLanguage(body.call_language):null;
    if(callLanguage)prompt=prompt.replace(PI_PROTOCOL_BASE,'').replace(ASUKA_LANGUAGE_POLICY,'').replace(NEUTRAL_LANGUAGE_POLICY,'');
    const targetLanguage=callLanguage??(sharedLightDefault?lightSpokenLanguage(body.message,session.state.messages):
      explicitSpokenLanguage(body.message,session.state.messages));
    if(sharedLightDefault){
      characterMemoryVersion=desktopMemoryVersion(null,'asuka.shikinami');
      if(characterMemoryVersion){
        const catalog=withRoleSettings(loadCharacterMemory(characterMemoryVersion,{root:undefined}),roleSettings);
        const cue=sourceDialogueCue(recentPublicDialogue(session.state.messages,4),catalog.schema_version===2?2:4);
        const useTail=compact&&catalog.context&&(catalog.context.schema==='asuka.character-context/2'||Object.keys(fields).length>0);
        const assembled=injectLightMemories(prompt,catalog,body.message,cue.historyText,cue.previousReplies,useTail);
        prompt=assembled.prompt;turnReference=assembled.tail??'';
        if(Object.keys(fields).length&&!catalog.context){
          if(catalog.role_replaced)prompt=prompt.replace(/<character_profile>[\s\S]*?<\/character_profile>/u,
            '<character_profile>以本轮设定的身世参与当前交流。</character_profile>');
          prompt+='\n本轮角色资料以当前设置为准。\n<role_settings>'+encodeRoleData(roleData(fields))+'</role_settings>';
        }
      }
      prompt=prompt.trimEnd()+'\n\n'+dialogueExpressionGuide(preparation.profile,{language:targetLanguage??'auto'});
    }
    if((!sharedLightDefault||!characterMemoryVersion)&&Object.keys(fields).length){
      if(Object.hasOwn(fields,'speaking_style'))
        prompt=prompt.replace(NEUTRAL_LANGUAGE_POLICY,NEUTRAL_LANGUAGE_POLICY.replace('保持中性、友好、简洁','采用当前角色的措辞偏好'));
      prompt+='\n以下字段是本机设定的角色资料。对应内容以本轮设定为准，历史发言保留当时的含义，输出仍遵循系统协议。\n<role_settings>'+encodeRoleData(roleData(fields))+'</role_settings>';
    }
    const search=base.request_policy.web_search?'\n模型服务的内置web_search已单独启用，可检索公开网页；这不授予本地文件、终端或其他工具权限。':'';
    if(approved){
      const tools=policy.mode==='chat'?chatToolAvailability:securityGuide(policy);
      prompt+='\n\n'+desktopReferenceGuide+tools+search+'\n\n'+desktopReplyFormat;
    }
    if(targetLanguage&&(sharedLightDefault||callLanguage)&&(!approved||targetLanguage!=='ja')){
      const names={ja:'日语',zh:'中文',en:'英语'};
      prompt+='\n本轮 speech 使用自然'+names[targetLanguage]+'，日常物品用该语言的惯称，编号保留原样。之前消息的 language 和译文记录的是当时的发言。';
    }
    if(single)prompt+='\n'+(callLanguage?callLineGuide(callLanguage):voiceTurnGuide);
    if(!approved){
      prompt+='\n本人此刻选择沉默时，返回 {"silence":true}。';
      prompt+=(compact&&policy.mode==='chat'?'\n本轮无本地工具。':securityGuide(policy))+search;
    }
    if(preparation.profile?.relationship_context){
      const context=preparation.profile.relationship_context;
      const visible=compact && policy.mode==='chat' && body.request_id && !body.images?.length;
      turnReference+=(turnReference?'\n':'')+'<relationship_context>'+encodeRoleData(
        visible?referenceVisibleSpeech(context,session.state.messages,historyIds,id=>relationship.source(id)):context)+'</relationship_context>';
    }
    if(compact&&(sharedLightDefault||turnReference)){
      if(!approved){
        prompt+='\n当前用户消息若带有 turn_reference，其中是本轮参考资料；随后的内容是用户原话。按当前设定理解身份与近况，过去的发言归于当时。';
        if(relationship)prompt+='\nrelationship_context 记录话题、发言时间与打断位置。earlier_by 从本条用户原话向前数公开消息，1 是上一条。';
      }
      // Attachments, hidden events and tool loops retain their original message layout.
      if(turnReference&&(policy.mode!=='chat'||body.images?.length||!body.request_id)){
        prompt+='\n'+turnReference;turnReference='';
      }
    }
    const configuration={...base,dialogue_binding:{version:1,prompt_sha256:fingerprint(prompt),
      profile_sha256:fingerprint(preparation.profile),selected_light:loadedPersonality.selected.light,shared_character_profile:sharedLightDefault,
      publication_contract:single?SELECTED_VOICE_FORMAT:LIGHT_FORMAT,spoken_language:targetLanguage,
      ...(callLanguage?{call_line_format:'aligned-single/1'}:{}),
      ...(characterMemoryVersion?{character_memory_version:characterMemoryVersion}:{})},
      ...(turnReference?{light_turn_reference:turnReference}:{})};
    if(!body.request_id)return {configuration,systemPrompt:prompt};
    const retry=body.request_id&&lightRetryState(session,body.request_id);
    if(retry&&(retry.start.data.configuration_sha256!==fingerprint(configuration)||!body.manual_retry||!retry.safe))
      throw Object.assign(new Error('旧请求不能按改变后的配置重复执行。'),{code:'REQUEST_CHANGED',retryable:false});
    return {configuration,systemPrompt:prompt,commit:()=>{
      const {record}=bindLightRequestSnapshot({directory:dialogueDirectory,sessionId:session.sessionId,requestId:body.request_id,
        requestKey:requestKey(body,session.sessionId),parentId:retry?retry.start.parentId:session.sessionManager.getLeafId(),
        hadMessages:(retry?(retry.start.parentId?session.sessionManager.getBranch(retry.start.parentId):[]):session.sessionManager.getBranch()).some(e=>e.type==='message'||e.type==='custom_message'),
        configuration,systemPrompt:prompt,dialogueProfile:preparation.profile??null,selectedLight:loadedPersonality.selected.light,
        legacy:false,securityHash:fingerprint(loadSecurity(PROJECT_ROOT))});
      if(fingerprint(record.configuration)!==fingerprint(configuration))throw Object.assign(new Error('同一请求已有另一份冻结配置'),{code:'REQUEST_CHANGED',retryable:false});
      return record;
    }};
  }
  function rememberReply(body,session,response){
    if(!body.request_id||!response.behavior||response.behavior.error)return;
    const entry={id:body.request_id,session_id:session.sessionId,key:requestKey(body,session.sessionId),response,...callSurface(body)};
    if(isLight(body)){
      session.sessionManager.appendCustomEntry('asuka.request.result.v1',entry);
      response.behavior.reply_saved=true;
    }
    completedRequests.set(body.request_id,entry);
    while(completedRequests.size>64)completedRequests.delete(completedRequests.keys().next().value);
    catalog.remember(session.sessionManager);
  }
  const publishedLightReply=(session,id)=>completedRequests.has(id)||session.sessionManager.getBranch().some(e=>
    e.type==='custom'&&e.customType==='asuka.request.result.v1'&&e.data?.id===id);

  // Saved result receipts are authoritative, including ones from older versions.
  // Only an unpublished SDK completion can require format recovery.
  function unpublishedFormat(body,session){
    if (!isLight(body) || publishedLightReply(session,body.request_id)) return null;
    return lightRetryState(session,body.request_id)?.start.data ?? {};
  }
  async function restorePublicReply(body,session,stored,getSignal){
    const start=unpublishedFormat(body,session);
    if (!start) return stored;
    const contract=start.publication_contract??LEGACY_LIGHT_FORMAT;
    let response=stored;
    if (needsLightLanguageRepair(stored.behavior,contract,boundLanguage(start))) {
      response=getSignal && hasFormatContract(contract)
        ? await finalizeLightResponse(body,session,stored,getSignal(body),start)
        : {...stored,behavior:textOnlyLanguageFallback(stored.behavior,contract,boundLanguage(start))};
    }
    if (getSignal) {
      response={...response,behavior:spokenLine(response.behavior,body,session.sessionId)};
      rememberReply(body,session,response);
    }
    return response;
  }
  async function registerCustomApi(rawProfile) {
    for(const key of ['apiKey','api_key'])if(typeof rawProfile?.[key]==='string'&&rawProfile[key])privateErrorValues.add(rawProfile[key]);
    if(activeModelTurns||activeRequests.size||currentSession?.isStreaming)
      throw new Error('当前回复尚未结束，模型连接将在下一轮应用');
    const profile = await registerModelService(modelRuntime,normalizeApiProfile(rawProfile));
    // 即使 provider/model id 没变，端点或协议也可能已修改；强制下一次
    // applyModel 把新模型对象写入 session，不能被同 ID 的 no-op 吞掉。
    if (currentModel?.provider === CUSTOM_API_PROVIDER) currentModel = null;
    for(const key of knownModelRoutes.keys())if(key.startsWith(CUSTOM_API_PROVIDER+'/'))knownModelRoutes.delete(key);
    customApiProfile = profile;
    return profile;
  }

  if (process.env.ASUKA_CUSTOM_API_CONFIG) {
    try {
      await registerCustomApi(JSON.parse(process.env.ASUKA_CUSTOM_API_CONFIG));
      console.log("✅ 已加载自定义 API 配置");
    } catch (error) {
      console.error(`⚠️ 自定义 API 配置无效: ${error.message}`);
    }
  }
  let loader = new DefaultResourceLoader(chatResourceOptions({
    cwd: PROJECT_ROOT,
    agentDir: AGENT_DIR,
    systemPrompt: ASUKA_SYSTEM_PROMPT+'\n'+LOCAL_AGENT_GUIDE,
  }));
  // 关键：手动加载 resource loader，否则 systemPrompt 不生效（createAgentSession
  // 只在未传 resourceLoader 时才自动 reload；我们传了就必须自己 reload）
  await loader.reload();

  // ===== 多会话管理 =====
  async function buildSession(sessionManager, resourceLoader=loader) {
    assertSessionWritable(sessionManager);
    const { session } = await createAgentSession({
      cwd: PROJECT_ROOT,
      agentDir: AGENT_DIR,
      sessionManager,
      modelRuntime,
      resourceLoader,
      tools: [...SECURITY_TOOL_NAMES],
      customTools: securityTools(PROJECT_ROOT),
    });
    session.agent.toolExecution='sequential';
    refreshSecurity(session,PROJECT_ROOT);
    if (currentModel && (!session.model || fingerprint(session.model)!==fingerprint(currentModel))) {
      await session.setModel(currentModel);
    }
    session.agent.state.messages = publicMessages(visibleMessages(sessionManager));
    return session;
  }

  // 新建会话（持久化）
  async function createSession(options) {
    if(options?.id && deletionReceipt(SESSION_DIR,options.id))throw Object.assign(Error('对话已删除'),{code:'SESSION_DELETED'});
    const sm = SessionManager.create(CWD, SESSION_DIR,options);
    const session = await buildSession(sm);
    currentSession = session;
    catalog.remember(sm);
    return session;
  }

  // 打开指定会话文件
  async function openSession(file, expectedId) {
    const sm = SessionManager.open(file, SESSION_DIR, CWD);
    if (expectedId && sm.getSessionId() !== expectedId) {
      catalog.remember(sm);
      throw Object.assign(new Error('对话文件与所选对话不一致'),{code:'SESSION_CHANGED'});
    }
    if(deletionReceipt(SESSION_DIR,sm.getSessionId()))throw Object.assign(Error('对话正在删除'),{code:'SESSION_DELETED'});
    const session = await buildSession(sm);
    currentSession = session;
    catalog.remember(sm);
    return session;
  }

  function safeSessionPath(candidate) {
    return resolveSessionPath(SESSION_DIR, candidate);
  }

  // 重启后恢复最近会话；没有历史时才创建空会话。
  const startupSessions = await catalog.list();
  let recent = relationship?(startupSessions.find(row=>row.id===relationship.id)??{id:relationship.id}):startupSessions[0];
  // A first send may still live only in the desktop outbox. Restore that
  // identity directly when it is the newest conversation.
  if (!relationship&&process.env.ASUKA_PENDING_SESSION_HINT) {
    try {
      const hint = JSON.parse(process.env.ASUKA_PENDING_SESSION_HINT);
      if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(hint.id) && Number.isFinite(hint.updated_ms)
          && (!recent || hint.updated_ms >= Date.parse(recent.modified)) && !deletionReceipt(SESSION_DIR,hint.id)) {
        const saved = startupSessions.find(row=>row.id===hint.id);
        if (saved) recent = saved;
        else if (!existsSync(SESSION_DIR) || !readdirSync(SESSION_DIR).some(name=>name.endsWith('_'+hint.id+'.jsonl'))) recent = {id:hint.id};
      }
    } catch { /* The durable session list remains sufficient without a hint. */ }
  }
  if (recent?.path) {
    try {
      await openSession(safeSessionPath(recent.path),recent.id);
      console.log("✅ 已恢复最近 Agent 会话");
    } catch(error) {
      logBrainError('session_restore',error);
      if(relationship)throw error;
      await createSession();
    }
  } else {
    await createSession(recent ? {id:recent.id} : undefined);
    console.log("✅ Agent 会话已创建");
  }
  if(relationship){
    const pendingErase=pendingRelationshipErasure({sessionDirectory:SESSION_DIR,sessionId:relationship.id});
    const outstanding=relationship.eraseJob()??pendingErase?.request_ids;
    if(outstanding){
      try{await finishRelationshipErasure(outstanding);}
      catch(error){if(!error.unwrittenIntentCancelled)throw error;logBrainError('relationship-erasure-preserved',error);}
    }
    relationship.attach(currentSession,generalHistory);
    relationship.recoverCalls();
  }

  // 设置默认模型（DeepSeek pro）
  async function applyModel(provider, id, capabilities = {}) {
    // 取完整模型对象（含 baseUrl/api/reasoning），避免 setModel 存裸对象导致 baseUrl undefined
    const fullModel = await modelRuntime.getModel(provider, id);
    if (!fullModel) throw new Error(`模型 ${provider}/${id} 不存在`);
    let selectedModel = fullModel;
    // 本地 llama-server 的 mmproj 是否加载由 Python 进程掌握；把该事实
    // 显式同步给 Pi，避免 SDK 把图片降级成文本占位符。
    if (provider === "local" || provider === CUSTOM_API_PROVIDER) {
      selectedModel = { ...fullModel };
      if (typeof capabilities.vision === "boolean") {
        selectedModel.input = capabilities.vision
          ? ["text", "image"] : ["text"];
      }
      const contextWindow = Number(capabilities.contextWindow);
      if (Number.isInteger(contextWindow) && contextWindow >= 4096) {
        selectedModel.contextWindow = contextWindow;
      }
    }
    const sameModel = currentModel && currentSession.model
      && fingerprint(currentModel)===fingerprint(selectedModel)
      && fingerprint(currentSession.model)===fingerprint(selectedModel);
    if (sameModel) return currentModel;
    if(!currentSession.model||fingerprint(currentSession.model)!==fingerprint(selectedModel)){
      assertSessionWritable(currentSession.sessionManager);
      await currentSession.setModel(selectedModel);
      catalog.remember(currentSession.sessionManager);
    }
    currentModel = selectedModel;
    knownModelRoutes.set(provider+'/'+id,selectedModel);
    return selectedModel;
  }
  try {
    if(process.env.ASUKA_START_API_MODEL && process.env.DEEPSEEK_API_KEY)
      await applyModel('deepseek',process.env.ASUKA_START_API_MODEL);
    else if(customApiProfile)await applyModel(CUSTOM_API_PROVIDER,customApiProfile.modelId);
  } catch (e) {
    if(isStorageFailure(e))throw storageFailure(e);
    console.error(`⚠️ 设置默认模型失败: ${e.message}`);
  }

  // 串行化普通输入与隐藏客户端事件：Pi session 是串行的，避免并发冲突。
  let askQueue = Promise.resolve();
  function turnStart(session,body){
    return body.request_id && session.sessionManager.getBranch().findLast(e=>
      e.type==='custom' && e.customType==='asuka.request.start.v1' && e.data?.id===body.request_id)?.data;
  }
  async function finalizeLightResponse(body,session,response,signal,start){
    if(!isLight(body))return response;
    start??=turnStart(session,body);
    const contract=start?.publication_contract??LEGACY_LIGHT_FORMAT, targetLanguage=boundLanguage(start);
    if(!needsLightLanguageRepair(response.behavior,contract,targetLanguage))
      return singleVoiceFormat(contract)?{...response,behavior:publishedVoice(response.behavior)}:response;
    const model=currentModel||session.model;activeModelTurns++;
    const result=askQueue.then(async()=>{
      signal?.throwIfAborted();let voiceStyle='';
      try{
        const frozen=lightSnapshot(session,body);
        if(frozen?.configuration.dialogue_binding?.shared_character_profile||Object.hasOwn(frozen?.dialogue_profile?.role_settings?.overrides??{},'speaking_style'))
          voiceStyle=dialogueLocalizationStyle(frozen.dialogue_profile);
      }catch(error){logBrainError('light_format_style',error);}
      const behavior=await finalizeLightBehavior({behavior:response.behavior,model,signal,voiceStyle,contract,targetLanguage,
        complete:(m,request,options)=>modelRuntime.completeSimple(m,request,options),
        reportDir:lightFormatDirectory(session.sessionId,body.request_id)});
      signal?.throwIfAborted();return {...response,behavior};
    });
    askQueue=result.catch(()=>{});return result.finally(()=>{activeModelTurns--;});
  }
  async function runQueuedTurn(startTurn, configure=true,{signal,onProgress,prepareLight=null,voiceTurn=null,callLanguage=null}={}) {
    const session = currentSession;
    const requestedModel = currentModel || session.model;
    const queuedConfig=loadInference(PROJECT_ROOT);
    activeModelTurns++;
    const result = askQueue.then(async () => {
      refreshSecurity(session,PROJECT_ROOT);
      const config=structuredClone(queuedConfig);let setting=config.light;
      const previousModel=session.model,stream=session.agent.streamFunction;
      let invocation,primaryFailure=false;
      try{
      signal?.throwIfAborted();
      const historyIds=relationship && prepareLight ? [] : null;
      if(configure)session.agent.state.messages=publicMessages(visibleMessages(session.sessionManager,historyIds));
      if(prepareLight){
        invocation=prepareLight(session,{model:activeTarget(requestedModel),light:setting,request_policy:config.request},historyIds);
        setting=invocation.configuration.light;config.request=invocation.configuration.request_policy;
      }
      if(configure){
        const selected=requestedModel;
        const model=setting.context_window?{...selected,contextWindow:Math.min(selected.contextWindow,setting.context_window)}:selected;
        const custom=inferenceOptions(setting,model,{defaultReasoning:session.thinkingLevel});
        validateRequestTarget(model,config.request);
        const phasePayload=custom.onPayload;
        custom.onPayload=payload=>applyRequestPayload(phasePayload?phasePayload(payload):payload,model,
          {options:config.request,jsonCompatible:true,allowSearch:true});
        await session.setModel(model);
        signal?.throwIfAborted();
        if(invocation?.commit)invocation.record=invocation.commit();
        const searchGuide=config.request.web_search?'\n模型服务的内置web_search已单独启用，可检索公开网页；这不授予本地文件、终端或其他工具权限。':'';
        session.agent.streamFunction=(m,c,o)=>{
          const prompt=(invocation?.systemPrompt??c.systemPrompt+securityGuide(loadSecurity(PROJECT_ROOT))+searchGuide)+(voiceTurn===SINGLE_VOICE?'\n'+(callLanguage?callLineGuide(callLanguage):voiceTurnGuide):'');
          return stream(m,lightTransportContext(c,prompt,invocation?.configuration.light_turn_reference),{...o,...custom,signal:o?.signal});
        };
      }
      return await awaitAgentTurn({session,startTurn:s=>startTurn(s,invocation?.configuration??{model:activeTarget(requestedModel),light:setting,request_policy:config.request},invocation?.record?.record_sha256),signal,onProgress,
        timeoutMs:configure?setting.timeout_seconds*1000:90000});}
      catch(error){primaryFailure=true;throw error;}
      finally{if(configure){
        session.agent.streamFunction=stream;
        try{await session.setModel(previousModel);}
        catch(error){logBrainError('light_model_restore',error);if(!primaryFailure)throw error;}
      }}
    });
    // 更新队列（吞掉错误避免阻断后续），但把结果抛给当前调用者
    askQueue = result.catch(() => {});
    return result.finally(()=>{activeModelTurns--;});
  }

  async function runLightTurn(startTurn, options) {
    const text = await runQueuedTurn(startTurn,true,options);
    return {text,personality:{actualMode:'light',requestedMode:'light'}};
  }
  async function ask(message, images = [], rawPersonality = {}, signal) {
    assertSessionWritable(currentSession.sessionManager);
    const options = images.length ? { images } : undefined;
    const startTurn = (session,configuration,dialogueSnapshotHash) => {
      rewindLightRetry(session,rawPersonality,configuration);
      if(rawPersonality.request_id&&configuration)session.sessionManager.appendCustomEntry('asuka.request.start.v1',
        {id:rawPersonality.request_id,key:requestKey(rawPersonality,session.sessionId),configuration_sha256:fingerprint(configuration),...callSurface(rawPersonality),
          publication_contract:configuration.dialogue_binding?.publication_contract??LEGACY_LIGHT_FORMAT,
          spoken_language:boundLanguage(configuration.dialogue_binding),
          ...(dialogueSnapshotHash?{dialogue_snapshot_sha256:dialogueSnapshotHash}:{})});
      return session.prompt(message, options);
    };
    const preparation=lightPreparation(currentSession,rawPersonality);
    return runLightTurn(startTurn,{signal,prepareLight:(session,base,ids)=>planLightInvocation(session,rawPersonality,preparation,base,ids),onProgress:progress=>{
      if(rawPersonality.request_id)requestProgress.set(rawPersonality.request_id,{...progress,request_id:rawPersonality.request_id});}});
  }

  async function askClientEvent(rawEvent, rawPersonality = {}, signal) {
    const event = normalizeClientEvent(rawEvent);
    const startTurn = (session,configuration) => {
      if(rawPersonality.request_id&&configuration)session.sessionManager.appendCustomEntry('asuka.request.start.v1',
        {id:rawPersonality.request_id,key:requestKey(rawPersonality,session.sessionId),configuration_sha256:fingerprint(configuration),...callSurface(rawPersonality),
          publication_contract:rawPersonality.voice_turn===SINGLE_VOICE?SELECTED_VOICE_FORMAT:LIGHT_FORMAT,
          spoken_language:(rawPersonality.voice_turn===SINGLE_VOICE?callSpeechLanguage(rawPersonality.call_language):null)??(sharedLightDefault?lightSpokenLanguage('',session.state.messages):
              rawPersonality.voice_turn===SINGLE_VOICE?explicitSpokenLanguage('',session.state.messages):null)});
      return session.sendCustomMessage({
      customType: "asuka.client_event.v1",
      content: event.content,
      display: false,
      details: { type: event.type, source: "desktop-client", version: 1 },
      }, { triggerTurn: true });
    };
    const profile=sessionDialogue(currentSession);
    const eventBody={...rawPersonality,request_id:undefined,message:event.content};
    return runLightTurn(startTurn,{signal,prepareLight:(session,base)=>planLightInvocation(session,eventBody,{profile},base)});
  }

  let activeMutations=0,deletingConversation=false,initiativeController=null;
  async function finishRelationshipErasure(requestIds){
    const options={sessionManager:currentSession.sessionManager,requestIds,sessionDirectory:SESSION_DIR,
      dialogueDirectory,generalRoot:generalHistory,journalRoot:process.env.ASUKA_AGENT_JOURNAL_DIR};
    let result;
    try{result=eraseRelationshipTurns(options);}
    catch(error){
      if(error.code==='RELATIONSHIP_ERASURE_UNKNOWN_ENTRY'&&error.sdk_unchanged===true&&
         !pendingRelationshipErasure({sessionDirectory:SESSION_DIR,sessionId:relationship.id})){
        relationship.cancelUnwrittenErase(requestIds);
        error.unwrittenIntentCancelled=!relationship.eraseJob();
      }
      throw error;
    }
    if(result.notFound.some(id=>{const row=relationship.source(id);return row?.assistant_entry||row?.user_entry;}))
      throw Error('存档与选中的消息不符，请重新加载后重试');
    result.requestIds=[...new Set([...result.requestIds,...result.notFound])];
    completedRequests.clear();requestProgress.clear();
    if(result.sdkFile&&existsSync(result.sdkFile)){
      const old=currentSession;
      await openSession(result.sdkFile,relationship.id);
      old.dispose();
    }
    relationship.finishErase(result);
    return result;
  }
  async function erasePublicTurns(ids){
    if(!relationship||activeModelTurns||activeRequests.size||deletingConversation)
      throw Error('请等待当前回复和维护结束再删除消息');
    deletingConversation=true;initiativeController?.abort();followups?.cancel();
    try{
      const requestIds=relationship.beginErase(ids);
      const result=await finishRelationshipErasure(requestIds);
      relationship.attach(currentSession,generalHistory);
      return {ok:true,request_ids:result.requestIds,replay_ids:result.replayIds};
    }finally{deletingConversation=false;}
  }
  const initiativeBusy=()=>Boolean(activeModelTurns||activeRequests.size||currentSession?.isStreaming||
    deletingConversation);
  function initiativePersona(){
    const profile=sessionDialogue(currentSession);
    let persona=loadedPersonality.light?.prompt??'按当前角色的身份和口吻参与交流。';
    const version=sharedLightDefault&&desktopMemoryVersion(null,'asuka.shikinami');
    if(version){
      const catalog=withRoleSettings(loadCharacterMemory(version,{root:undefined}),profile.role_settings);
      if(catalog.context)persona=renderV2Persona(catalog.context);
    }
    if(Object.keys(profile.role_settings.overrides).length)persona+='\n角色本轮设定 '+encodeRoleData(roleData(profile.role_settings.overrides));
    return persona+'\n'+dialogueExpressionGuide(profile);
  }
  const handleIndependent=independentHandler(createIndependentGeneration({
    modelRuntime,
    resolveSelection:()=>{
      const light=loadInference(PROJECT_ROOT).light;
      const setting=process.env.ASUKA_INDEPENDENT_MODEL?{...light,model:process.env.ASUKA_INDEPENDENT_MODEL}:light;
      return {model:selectStageModel(setting,currentModel||currentSession?.model,stageModels),
        setting,defaultReasoning:currentSession?.thinkingLevel};
    },
  }),readJsonBody);
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if((deletingConversation||relationship?.eraseJob()&&req.url!=='/relationship/erase')&&req.url!=='/health'){
      res.end(JSON.stringify({ok:false,code:'CHAT_BUSY',error:'正在处理会话删除，请稍后重试'}));return;
    }
    const mutation=req.method==='POST';if(mutation)activeMutations++;
    try{
    if(relationship&&(req.url==='/relationship'||req.url?.startsWith('/relationship/'))){
      try{
        if(req.headers.origin||((req.url!=='/relationship'||req.method!=='GET')&&
           (req.method!=='POST'||req.headers['x-asuka-settings']!=='1')))throw Error('关系资料仅接受本机客户端请求');
        const body=req.method==='POST'?await readJsonBody(req):{};
        const poll=req.url==='/relationship/initiative/poll';
        if(poll&&initiativeController){res.end(JSON.stringify({ok:true,claim:null}));return;}
        const controller=poll?new AbortController():null;
        if(controller){
          initiativeController=controller;
          res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        }
        try{
          const result=await relationshipRoute(req.url,body,{store:relationship,session:currentSession,erase:erasePublicTurns,busy:initiativeBusy,followups,
            complete:currentModel?(context,signal)=>modelRuntime.completeSimple(currentModel,context,
              {...inferenceOptions(loadInference(PROJECT_ROOT).light,currentModel,{defaultReasoning:currentSession.thinkingLevel}),
               signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)}):null,
            persona:initiativePersona,history:()=>recentPublicDialogue(visibleMessages(currentSession.sessionManager),12,{includeLanguage:true}),signal:controller?.signal});
          if(result.item)currentSession.agent.state.messages=publicMessages(visibleMessages(currentSession.sessionManager));
          res.end(JSON.stringify(result));
        }finally{if(controller&&initiativeController===controller)initiativeController=null;}
      }catch(e){logBrainError('relationship',e);res.end(JSON.stringify({ok:false,code:e.code||'RELATIONSHIP_ERROR',error:errorText(e)}));}
      return;
    }
    if(relationship&&req.method==='POST'&&['/sessions','/sessions/switch','/sessions/delete'].includes(req.url)){
      if(req.url==='/sessions/switch'){
        const b=await readJsonBody(req);
        if(b.id===relationship.id){res.end(JSON.stringify({ok:true,id:relationship.id,path:currentSession.sessionManager.getSessionFile()}));return;}
      }
      res.end(JSON.stringify({ok:false,code:'RELATIONSHIP_VIEW',error:'请使用话题分组操作'}));return;
    }
    if(relationship&&req.method==='POST'&&['/ask','/clientEvent','/configureApi','/setModel','/personality/selection'].includes(req.url)){
      initiativeController?.abort();followups.cancel();
    }
    if(await handleIndependent(req,res))return;
    if(req.url==='/security'||req.url==='/security/capabilities'){
      try{
        if(req.method==='POST'){
          if(req.headers.origin||req.headers['x-asuka-settings']!=='1'||!req.headers['content-type']?.startsWith('application/json'))throw Error('安全设置仅允许原生客户端配置');
          const requested=await readJsonBody(req);
          if(activeModelTurns||currentSession?.isStreaming)throw Error('请先等待当前回复结束再修改权限');
          const value=saveSecurity(PROJECT_ROOT,requested,{capabilities:req.url==='/security/capabilities'});refreshSecurity(currentSession,PROJECT_ROOT);
          res.end(JSON.stringify({ok:true,policy:value,tools:toolNames(value)}));
        }else if(req.method==='GET'){
          const policy=loadSecurity(PROJECT_ROOT);res.end(JSON.stringify({ok:true,policy,tools:toolNames(policy)}));
        }else throw Error('不支持的安全设置请求');
      }catch(e){res.end(JSON.stringify({ok:false,error:String(e.message||e)}))}return;
    }
    if(req.method==='GET'&&req.url?.startsWith('/contextUsage?')){
      try{
        const query=new URL(req.url,'http://localhost').searchParams,session=currentSession;
        const mode=query.get('mode')||'light',id=query.get('session_id');
        if(mode!=='light')throw Error('无效的对话模式');
        if(id!==session.sessionId){res.end(JSON.stringify({stale:true,session_id:session.sessionId,mode}));return;}
        const model=currentModel||session.model;
        const contextWindow=Math.min(model.contextWindow,loadInference(PROJECT_ROOT).light.context_window||model.contextWindow);
        const usage=readPiContextUsage(session,contextWindow);
        res.end(JSON.stringify({...usage,session_id:id,mode,model_id:model.id,context_window:contextWindow}));
      }catch(error){res.end(JSON.stringify({error:'暂无上下文统计'}));}
      return;
    }
    if(req.method==='GET'&&req.url==='/inferenceSettings'){
      try{
        const config=loadInference(PROJECT_ROOT),current=currentModel||currentSession?.model;
        const settings=config.light;
        const options=inferenceOptions(settings,current,{defaultReasoning:currentSession.thinkingLevel});
        const effective={light:{provider:current.provider,model:current.id,vision:current.input?.includes('image'),
          reasoning:current.reasoning===false?'未声明支持':options.reasoning,
          max_tokens:Math.min(settings.max_tokens||current.maxTokens,current.maxTokens),
          context_window:Math.min(settings.context_window||current.contextWindow,current.contextWindow),
          timeout_seconds:settings.timeout_seconds,temperature:options.temperature??null,
          top_p:options.onPayload?options.onPayload({}).top_p??null:null,note:inferenceNote(current,options)}};
        res.end(JSON.stringify({config:{light:settings,request:config.request},effective,models:DEEPSEEK_MODELS}));
      }catch(e){res.end(JSON.stringify({error:String(e)}))}return;
    }
    let requestLease=null;
    const releaseRequest=()=>{
      if(requestLease&&activeRequests.get(requestLease.id)===requestLease.controller){
        activeRequests.delete(requestLease.id);requestProgress.delete(requestLease.id);
      }
    };
    const requestSignal = body => {
      const id = body.request_id || randomUUID();
      if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,96}$/.test(id))throw Object.assign(new Error('无效请求ID'),{code:'REQUEST_INVALID'});
      if(body.session_id&&body.session_id!==currentSession.sessionId)throw Object.assign(new Error('当前对话已切换'),{code:'SESSION_CHANGED'});
      const key=requestKey(body,currentSession.sessionId),active=activeRequests.get(id);
      if(active)throw Object.assign(new Error(active.requestKey===key?'仍在处理同一消息':'请求内容已改变'),{code:active.requestKey===key?'REQUEST_ACTIVE':'REQUEST_CHANGED'});
      const controller = new AbortController();
      controller.requestKey=key;
      activeRequests.set(id, controller);
      requestLease={id,controller};
      body.request_id=id;
      requestProgress.set(id,{stage:"queued",text:"等待处理",request_id:id});
      // Connection loss does not cancel a durable turn. The explicit cancel
      // endpoint owns abort; the controller is retained until the work settles.
      return AbortSignal.any([controller.signal,AbortSignal.timeout(7200000)]);
    };
    if(req.method==="GET"&&req.url?.startsWith("/personality/progress?")){
      const id=new URL(req.url,"http://localhost").searchParams.get("request_id");
      res.end(JSON.stringify(requestProgress.get(id)||{stage:"unavailable"}));
      return;
    }
    if (req.method === "POST" && req.url === "/personality/cancel") {
      try {
        const body = await readJsonBody(req);
        const id=body.request_id;
        if(typeof id!=='string'||!/^[A-Za-z0-9._-]{1,96}$/.test(id))throw Object.assign(new Error('无效请求ID'),{code:'REQUEST_INVALID'});
        if(body.session_id&&body.session_id!==currentSession.sessionId)throw Object.assign(new Error('当前对话已切换'),{code:'SESSION_CHANGED'});
        if(followups?.current?.parent===id)followups.cancel();
        const controller = activeRequests.get(body.request_id);
        if(controller){controller.abort();res.end(JSON.stringify({ok:true,cancelled:true}));return;}
        const session=currentSession,branch=session.sessionManager.getBranch(),retry=lightRetryState(session,id);
        const cached=completedRequests.get(id),terminal=retry?.tail.findLast(e=>e.message?.role==='assistant')?.message;
        let legacyComplete=false;
        if(retry?.uninterrupted&&terminal?.stopReason==='stop'){
          try{const behavior=extractBehavior(textContent(terminal.content));legacyComplete=Boolean(behavior?.speech||behavior?.silence);}catch{}
        }
        const completed=cached?.session_id===session.sessionId||legacyComplete||branch.some(e=>
          e.type==='custom'&&e.customType==='asuka.request.result.v1'&&e.data?.id===id
          ||e.message?.role==='assistant'&&e.message?.asukaNative?.record?.client_request_id===id);
        if(completed){res.end(JSON.stringify({ok:true,cancelled:false,completed:true,noop:true}));return;}
        // No worker remains. Do not rewind or delete the original input/tool tail.
        let snapshot=null,sourceUnreadable=false;
        try{snapshot=readLightRequestSnapshot({directory:dialogueDirectory,sessionId:session.sessionId,requestId:id});}
        catch(error){sourceUnreadable=true;logBrainError('cancel_source',error);}
        if(retry||snapshot){
          res.end(JSON.stringify({ok:true,cancelled:true,light:true,noop:true}));return;
        }
        res.end(JSON.stringify({ok:true,cancelled:!sourceUnreadable,inactive:sourceUnreadable,noop:true}));
      } catch(e) { res.end(JSON.stringify({ ok: false, code:e.code||e.name, error: String(e) })); }
      return;
    }
    if(req.method==='POST'&&req.url==='/requests/lookup'){
      try{
        const body=await readJsonBody(req,28*1024*1024);
        const result=rememberedReply({...body,manual_retry:false},currentSession);
        const ready=Boolean(result) && !awaitingSelectedTranslation(unpublishedFormat(body,currentSession),result.behavior,currentSession.sessionId);
        res.end(JSON.stringify({ready,result:ready?await restorePublicReply(body,currentSession,result):null}));
      }catch(error){res.end(JSON.stringify({ready:false,code:error.code||error.name}));}
      return;
    }

    // POST /ask - 对话
    if (req.method === "POST" && req.url === "/ask") {
      let slot=null;
      const lost=()=>{if(!res.writableEnded&&slot)followups.cancel(slot);};
      res.once('close',lost);
      try {
        const body = await readJsonBody(
          req, 28 * 1024 * 1024);
        const { message, images: rawImages } = body;
        if (typeof message !== "string" || !message.trim()) {
          throw new Error("消息不能为空");
        }
        const images = normalizeImages(rawImages);
        const responseSession = currentSession;
        const restored=rememberedReply(body,responseSession);
        if(restored){
          res.end(JSON.stringify(await restorePublicReply(body,responseSession,restored,requestSignal)));
          return;
        }
        if(!isLight(body))throw Object.assign(new Error('此预览只接收普通对话。请用新消息继续。'),{code:'MODE_RETIRED',retryable:false});
        if(!currentModel)throw Object.assign(new Error('请先配置模型连接'),{code:'MODEL_NOT_CONFIGURED',retryable:false});
        let origin=null;
        if(relationship){
          if(relationship.eraseJob())throw Error('请先完成消息删除');
          if(body.session_id!==relationship.id)throw Error('关系档已切换');
          origin=relationship.reserve(body);
        }
        const config=loadInference(PROJECT_ROOT);
        const imageModels=[selectStageModel(config.light,currentModel,stageModels)];
        if (images.length && imageModels.some(m=>!m?.input?.includes("image"))) {
          throw new Error("当前模型未启用图片输入");
        }
        const signal=requestSignal(body);
        if(origin){
          try{
            const firstDispatch=relationship.firstAskDispatch(body.request_id);
            if(firstDispatch&&!relationship.indexRetry&&body.immediate_followup===true&&!res.destroyed)
              slot=followups.begin({body,origin,signal,persona:initiativePersona,
              history:()=>recentPublicDialogue(visibleMessages(responseSession.sessionManager),6,{includeLanguage:true}),
              complete:followupCompletionFor({activeModel:currentModel,mode:body.personality_mode,config,
                defaultReasoning:responseSession.thinkingLevel,
                complete:(model,context,options)=>modelRuntime.completeSimple(model,context,options)})});
          }catch(error){logBrainError('followup-admission',error);}
        }
        const firstReady=slot?behavior=>{
          try{followups.start(slot,behavior);}catch(error){followups.cancel(slot);logBrainError('followup-preparation',error);}
        }:undefined;
        const result = await ask(message, images, body, signal);
        const start=turnStart(responseSession,body);
        const behavior = result.behavior || extractBehavior(result.text,boundLanguage(start));
        if (behavior?.speech) behavior.playback_id = messagePlaybackId(responseSession.sessionManager);
        const response=await finalizeLightResponse(body,responseSession,{behavior,personality:result.personality},signal,start);
        response.behavior=spokenLine(response.behavior,body,responseSession.sessionId);
        firstReady?.(response.behavior);
        rememberReply(body,responseSession,response);
        if(relationship)try{relationship.sync(responseSession);}catch(e){logBrainError('relationship-index',e);}
        let handle=null;
        if(slot){
          try{
            if(relationship.indexRetry||res.destroyed)followups.cancel(slot);
            else handle=await followups.parentPublished(slot,response.behavior);
          }catch(error){followups.cancel(slot);logBrainError('followup-parent',error);}
        }
        res.end(JSON.stringify(handle?{...response,followup:handle}:response));
      } catch (e) {
        if(slot)followups.cancel(slot);
        logBrainError("ask", e);
        res.end(JSON.stringify({ error: errorText(e),code:e.code||e.name,retryable:e.retryable!==false,
          recovery_request_id:e.recovery_request_id,analysis_complete:e.analysis_complete===true,failure_closed:e.failure_closed===true }));
      }finally{res.off('close',lost);releaseRequest();}
      return;
    }

    // POST /clientEvent - 受限的客户端状态事件；输入隐藏，回复正常持久化。
    if (req.method === "POST" && req.url === "/clientEvent") {
      try {
        const body = await readJsonBody(req);
        const event = normalizeClientEvent(body);
        const responseSession = currentSession;
        if(relationship){
          if(body.session_id!==relationship.id||relationship.eraseJob())throw Error('关系资料暂时不可用');
          relationship.reserve(body);
        }
        const restored=rememberedReply(body,responseSession);
        if(restored){
          res.end(JSON.stringify(await restorePublicReply(body,responseSession,restored,requestSignal)));
          return;
        }
        if(!isLight(body))throw Object.assign(new Error('此预览只接收普通对话。请用新消息继续。'),{code:'MODE_RETIRED',retryable:false});
        if(!currentModel)throw Object.assign(new Error('请先配置模型连接'),{code:'MODEL_NOT_CONFIGURED',retryable:false});
        const signal=requestSignal(body);
        const result = await askClientEvent(event.type, body, signal);
        const start=turnStart(responseSession,body);
        const behavior = result.behavior || extractBehavior(result.text,boundLanguage(start));
        if (behavior?.speech) behavior.playback_id = messagePlaybackId(responseSession.sessionManager);
        const response=await finalizeLightResponse(body,responseSession,{behavior,personality:result.personality},signal,start);
        response.behavior=spokenLine(response.behavior,body,responseSession.sessionId);
        rememberReply(body,responseSession,response);
        if(relationship)try{relationship.sync(responseSession);}catch(e){logBrainError('relationship-event-index',e);}
        res.end(JSON.stringify(response));
      } catch (e) {
        logBrainError("clientEvent", e);
        res.end(JSON.stringify({ error: errorText(e),code:e.code||e.name }));
      }finally{releaseRequest();}
      return;
    }

    // POST /setModel - 切换模型源（运行时，不重启）
    if (req.method === "POST" && req.url === "/setModel") {
      try {
        const { provider, id, capabilities } = await readJsonBody(req);
        if(activeModelTurns||activeRequests.size||currentSession?.isStreaming)
          throw new Error('当前回复尚未结束，模型连接将在下一轮应用');
        if (typeof provider !== "string" || typeof id !== "string") {
          throw new Error("provider 和 id 必须是字符串");
        }
        if (capabilities != null
            && (typeof capabilities !== "object" || Array.isArray(capabilities))) {
          throw new Error("capabilities 必须是对象");
        }
        const fullModel = await applyModel(provider, id, capabilities || {});
        res.end(JSON.stringify({ ok: true, model: { provider: fullModel.provider, id: fullModel.id } }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    // POST /configureApi - 动态注册 OpenAI/Anthropic/Google 兼容模型。
    if (req.method === "POST" && req.url === "/configureApi") {
      try {
        if(req.headers.origin||req.headers['x-asuka-settings']!=='1'||!req.headers['content-type']?.startsWith('application/json'))
          throw new Error('模型连接仅允许由原生设置页配置');
        const rawProfile = await readJsonBody(req);
        if (rawProfile?.disabled===true) {
          if(activeModelTurns||activeRequests.size||currentSession?.isStreaming)
            throw new Error('当前回复尚未结束，模型连接将在下一轮停用');
          if(modelRuntime.getRegisteredProviderIds().includes(CUSTOM_API_PROVIDER))
            modelRuntime.unregisterProvider(CUSTOM_API_PROVIDER);
          await modelRuntime.removeRuntimeApiKey(CUSTOM_API_PROVIDER);
          customApiProfile=null;currentModel=null;
          for(const key of knownModelRoutes.keys())if(key.startsWith(CUSTOM_API_PROVIDER+'/'))knownModelRoutes.delete(key);
          res.end(JSON.stringify({ok:true,model:null}));return;
        }
        const profile = await registerCustomApi(rawProfile);
        const fullModel = await applyModel(
          CUSTOM_API_PROVIDER, profile.modelId,
          { vision: profile.vision, contextWindow: profile.contextWindow },
        );
        res.end(JSON.stringify({
          ok: true,
          model: {
            provider: fullModel.provider,
            id: fullModel.id,
            vision: fullModel.input?.includes("image") || false,
            contextWindow: fullModel.contextWindow,
          },
        }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    // GET /models - 可用模型列表
    if (req.method === "GET" && req.url === "/models") {
      try {
        const models = await modelRuntime.getAvailable();
        res.end(JSON.stringify({ models }));
      } catch (e) {
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // GET /model - 当前模型
    if (req.method === "GET" && req.url === "/model") {
      res.end(JSON.stringify({ model: currentModel }));
      return;
    }

    // GET /health - 健康检查
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({
        status: "ok",
        protocolVersion: BRAIN_PROTOCOL_VERSION,
        personalityFingerprint: loadedPersonality.fingerprint,
        personalitySelection: loadedPersonality.selected,
        capabilities: [
          ...(relationship?['relationship-timeline-v1']:[]),
          "image-input-v1", "custom-api-v1", "saved-api-connections-v1", "hidden-client-event-v1", "voice-call-language-v1", "dedicated-call-v1",
          'single-actor-preview-v1',
          "personality-progress-v1", "personality-context-v1", "inference-settings-v1", "personality-agent-tools-v1",
        ],
        model: currentModel,
      }));
      return;
    }

    // ===== 会话管理端点 =====

    // GET /sessions - 列出所有会话
    if (req.method === "GET" && req.url === "/sessions") {
      try {
        const sessions = await catalog.list();
        const file=currentSession.sessionManager.getSessionFile();
        res.end(JSON.stringify({ sessions,active:{id:currentSession.sessionId,path:file&&existsSync(file)?file:null,title:'新对话'} }));
      } catch (e) {
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // POST /sessions - 新建会话
    if (req.method === "POST" && req.url === "/sessions") {
      try {
        const session = await createSession();
        res.end(JSON.stringify({ ok: true, id: session.sessionId }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    // POST /sessions/switch - 切换会话（body: {path} 或 {id}）
    if (req.method === "POST" && req.url === "/sessions/switch") {
      try {
        const { path: filePath, id, restore_empty } = await readJsonBody(req);
        if(id===currentSession.sessionId){
          const file=currentSession.sessionManager.getSessionFile();
          if(!filePath && (!file || !existsSync(file))){
            res.end(JSON.stringify({ok:true,id,path:null}));return;
          }
          if(catalog.isLoaded(currentSession.sessionManager,filePath?safeSessionPath(filePath):file)){
            res.end(JSON.stringify({ok:true,id,path:file,title:catalog.remember(currentSession.sessionManager)?.title}));return;
          }
        }
        // 用 id 找路径，或直接用 path
        let targetFile = filePath;
        if (!targetFile && id) {
          const sessions = await catalog.list();
          const found = sessions.find(s => s.id === id);
          if (found) targetFile = found.path;
        }
        if(!targetFile&&restore_empty===true){
          if(req.headers.origin||req.headers['x-asuka-settings']!=='1')throw Error('会话恢复仅允许原生客户端');
          if(activeModelTurns)throw Object.assign(new Error('请等待当前请求完成'),{code:'CHAT_BUSY'});
          if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))throw Error('无效会话ID');
          if(readdirSync(SESSION_DIR).some(name=>name.endsWith('_'+id+'.jsonl')))throw Error('原会话文件需要检查，未用空会话覆盖');
          await createSession({id});res.end(JSON.stringify({ok:true,id,path:null}));return;
        }
        if (!targetFile) throw new Error("未找到会话");
        targetFile = safeSessionPath(targetFile);
        const selected=await openSession(targetFile,id);
        res.end(JSON.stringify({ ok:true, id:selected.sessionId, path:targetFile, title:catalog.remember(selected.sessionManager)?.title }));
      } catch (e) {
        logBrainError('session-switch',e);
        res.end(JSON.stringify({ ok: false, error: errorText(e), code:e.code||'SESSION_SWITCH_FAILED' }));
      }
      return;
    }

    // GET /sessions/history?path=... - 会话历史（body: {path} 或 {id}）
    if (req.method === "POST" && req.url === "/sessions/history") {
      try {
        const { path: filePath, id, transcript_only:transcriptOnly, surface } = await readJsonBody(req);
        let targetFile = filePath;
        if (!targetFile && id && id!==currentSession.sessionId) {
          const sessions = await catalog.list();
          const found = sessions.find(s => s.id === id);
          if (found) targetFile = found.path;
        }
        let sm;
        if ((!targetFile && id===currentSession.sessionId) ||
            (targetFile && (!id || id===currentSession.sessionId) && catalog.isLoaded(currentSession.sessionManager,safeSessionPath(targetFile)))) {
          sm=currentSession.sessionManager;
        }
        else{
          if (!targetFile) throw new Error("未找到会话");
          targetFile = safeSessionPath(targetFile);
          sm = SessionManager.open(targetFile, SESSION_DIR, CWD);
        }
        if (id && sm.getSessionId() !== id) {
          throw Object.assign(new Error('历史文件与所选对话不一致'),{code:'SESSION_CHANGED'});
        }
        // Compaction limits model context, never the visible conversation.
        const branch=sm.getBranch(),sessionId=sm.getSessionId();
        const callEntries = callMessageEntries(branch);
        const formatContracts=new Map(branch.filter(e=>e.type==='custom'&&e.customType==='asuka.request.start.v1'
          &&hasFormatContract(e.data?.publication_contract)).map(e=>[e.data.id,e.data]));
        const publishedReplies=new Map(branch.filter(e=>e.type==='custom'&&e.customType==='asuka.request.result.v1'
          &&e.data?.response?.behavior?.playback_id).map(e=>[e.data.response.behavior.playback_id,e.data.response.behavior]));
        const requestIds=new Map(branch.filter(e=>e.type==='custom'&&e.customType==='asuka.request.result.v1')
          .map(e=>[e.data?.response?.behavior?.playback_id,e.data?.id]));
        const savedByRequest=new Map(branch.filter(e=>e.type==='custom'&&e.customType==='asuka.request.result.v1'&&e.data?.id&&e.data?.response?.behavior).map(e=>[e.data.id,e.data.response.behavior]));
        let startId=null;const userRequestIds=new Map();
        for(const entry of branch){
          if(entry.type==='custom'&&entry.customType==='asuka.request.start.v1')startId=entry.data?.id;
          if(entry.message?.role==='custom')startId=null;
          if(startId&&entry.message?.role==='user')userRequestIds.set(entry.message,startId);
          if(startId&&entry.message?.role==='assistant'&&entry.message.stopReason==='stop'){
            requestIds.set(`${sm.getSessionId()}:${entry.id}`,startId);startId=null;
          }
        }
        // 提取用户/助手的文本消息
        const messages = [];
        const completedIds=new Set();
        let lastUser = null;
        for (const entry of branch) {
          if(entry.type!=='message')continue;
          const m=entry.message, role=m.role;
          const entryKey=role==='assistant'?sessionId+':'+entry.id:null;
          const boundRequest=m.asukaNative?.record?.client_request_id||requestIds.get(entryKey);
          const savedBehavior=savedByRequest.get(boundRequest)??publishedReplies.get(entryKey);
          const callEntry = callEntries.has(entry);
          if (callEntry && surface === 'chat') {
            if (boundRequest && (savedBehavior?.speech || savedBehavior?.silence || m.asukaNative?.record)) completedIds.add(boundRequest);
            lastUser = null;
            continue;
          }
          if (role === 'custom') lastUser = null;
          const playbackId=savedBehavior?.playback_id||entryKey;
          // display=false 的 CustomMessage 参与模型上下文，但绝不进入客户端历史。
          if (role !== "user" && role !== "assistant") continue;
          const content = m.content;
          let text = "";
          let hasImage = false;
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            hasImage = content.some(c => c && c.type === "image");
            text = content
              .filter(c => c && c.type === "text")
              .map(c => c.text || "")
              .join("");
          }
          if (!text && !hasImage) continue;
          let parts=null,displaySpeech=null,displayTranslation='';
          // assistant 消息若是行为对象 JSON，提取 speech（+translation）
          if (role === "assistant") {
            if(['error','aborted'].includes(m.stopReason))continue;
            try {
              let obj = extractBehavior(text);
              obj=savedBehavior||textOnlyLanguageFallback(obj,LEGACY_LIGHT_FORMAT);
              if(m.asukaNative?.key?.startsWith('general-desktop:'))obj=JSON.parse(text);
              const general=m.asukaNative?.key?.startsWith('general-desktop:'),record=m.asukaNative?.record;
              let analyzed=record?.analysis_complete===true;
              if(lastUser&&(general?analyzed:m.stopReason==='stop'))lastUser.read=true;
              const requestId=record?.client_request_id||boundRequest;
              if(!general&&requestId&&!savedBehavior){
                const start=formatContracts.get(requestId),contract=start?.publication_contract??LEGACY_LIGHT_FORMAT;
                obj=textOnlyLanguageFallback(start
                  ?cachedLightBehavior(extractBehavior(text,boundLanguage(start)),lightFormatDirectory(sm.getSessionId(),requestId),contract,boundLanguage(start))
                  :extractBehavior(text),contract,boundLanguage(start));
                if(awaitingSelectedTranslation(start,obj,sm.getSessionId()))continue;
              }
              if(requestId&&(obj?.speech||obj?.silence)){completedIds.add(requestId);if(lastUser)lastUser.request_id=requestId;}
              if(obj?.silence)continue;
              if(obj?.error)continue;
              if (obj && obj.speech) {
                const t = obj.translation || "";
                displaySpeech=obj.speech;displayTranslation=t;
                text = t && t !== obj.speech ? `${obj.speech}（${t}）` : obj.speech;
                if(Array.isArray(obj.parts))parts=obj.parts;
              }
            } catch { /* 非JSON，用原文 */ }
          }
          const summary=role==='assistant'?m.asukaNative?.record?.public_analysis:undefined;
          const row={ role, content: role==='user'?visibleFileMessage(text):text, hasImage,
            ...(callEntry?{surface:'call'}:{}),
            ...(role==='user'&&(m.asukaInput?.request_id||userRequestIds.has(m))?{request_id:m.asukaInput?.request_id||userRequestIds.get(m)}:{}),
            ...(role==='assistant'?{playback_id:playbackId}:{}),
            ...(displaySpeech!==null?{speech:displaySpeech,translation:displayTranslation}:{}),
            ...(parts?{parts}:{}),...(summary?{analysis_summary:String(summary).slice(0,600)}:{}) };
          if(role==='assistant'){
            const id=boundRequest;
            if(id){row.request_id=id;if(lastUser)lastUser.request_id=id;}
          }
          messages.push(row);
          if(role==='user')lastUser=row;
        }
        const pending=null;
        res.end(JSON.stringify({ ok:true, id:sessionId, messages, pending, completed_requests:[...completedIds] }));
      } catch (e) {
        res.end(JSON.stringify({ ok:false, error:errorText(e), code:e.code||'SESSION_HISTORY_FAILED' }));
      }
      return;
    }

    // POST /sessions/delete - 删除会话（body: {path} 或 {id}）
    if (req.method === "POST" && req.url === "/sessions/delete") {
      if(req.headers.origin||req.headers['x-asuka-settings']!=='1'||activeMutations>1||activeModelTurns){
        res.end(JSON.stringify({ok:false,code:'SESSION_DELETE_UNAVAILABLE',error:'请在客户端等待当前操作结束后删除'}));return;
      }
      deletingConversation=true;
      try {
        const {path:filePath,id:requested}=await readJsonBody(req);
        let receipt=requested?deletionReceipt(SESSION_DIR,requested):null;
        if(!receipt){
          const found=filePath?null:(await catalog.list()).find(s=>s.id===requested);
          const file=filePath||found?.path?safeSessionPath(filePath||found.path):null;
          const id=file?storedSessionId(file):requested;
          if(requested&&id!==requested)throw Error('对话身份不同');
          receipt=prepareRemoval({root:SESSION_DIR,id,sdkFile:file,generalRoot:generalHistory});
        }
        const id=receipt.id;
        if(receipt.sdk_name){
          const named=safeSessionPath(join(SESSION_DIR,receipt.sdk_name));
          if(existsSync(named)&&storedSessionId(named)!==id)throw Error('对话文件归属已变化');
        }
        eraseSessionRecords({root:SESSION_DIR,receipt,generalRoot:generalHistory,dialogueRoot:dialogueDirectory,
          journalRoot:process.env.ASUKA_AGENT_JOURNAL_DIR||join(PROJECT_ROOT,'data/personality-native/tool-runs')});
        if(receipt.sdk_name)catalog.forget(join(SESSION_DIR,receipt.sdk_name));
        for(const [key,value] of completedRequests)if(value.session_id===id)completedRequests.delete(key);
        if(currentSession?.sessionId===id)await createSession();
        res.end(JSON.stringify({ok:true,deletedSessionId:id,activeSessionId:currentSession.sessionId}));
      } catch(e){res.end(JSON.stringify({ok:false,error:errorText(e),code:e.code||'SESSION_DELETE_FAILED'}));}
      finally{deletingConversation=false;}
      return;
    }

    res.end(JSON.stringify({ status: "asuka-brain-ready" }));
    }finally{if(mutation)activeMutations--}
  });

  server.listen(PORT, HOST, () => {
    console.log(`✅ 明日香 Brain 就绪: http://${HOST}:${PORT}`);
  });
  process.once("SIGINT", () => { server.close(); process.exit(0); });
  process.once("SIGTERM", () => { server.close(); process.exit(0); });
}

if (process.env.ASUKA_PARSER_TEST !== "1") {
  main().catch(e => { console.error("启动失败:", e); process.exit(1); });
}
