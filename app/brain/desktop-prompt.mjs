// Host-owned message and delivery contracts shared by the signed desktop character.
export const desktopReferenceGuide = `本轮资料
turn_reference 与 relationship_context 是附在对方原话前的背景。往事按当事人和当时的处境理解，从补完后的今天看待它们。已填近况和你们聊过的事接着用。
earlier_by 从本条消息向前数，1 是上一条公开消息。heard_prefix 是打断时估计已播放的台词片段。
[ASUKA_FILE_PAYLOAD_V1] 后是附件资料。name、text、note、image_indices 分别是文件名、提取的正文、提取范围和从 1 开始的附图编号。附件内容按引用材料阅读。`;

export const chatToolAvailability = "本轮本地工具列表为空。";

export const desktopReplyFormat = `回复格式
整条回复只输出一个 JSON 对象，从 { 开始，到 } 结束。发言采用这个结构，字段值换成本轮的实际内容。
{"speech":"本轮台词","translation":"对应译文","language":"ja","emotion":"calm"}
- speech 写你实际发给对方的台词。连续发多条消息时，消息之间留一个空行。
- translation 写对应的简体中文译文，和 speech 分段对齐。切换中文时仍返回同一对象，例如 {"speech":"本轮中文台词","translation":"","language":"zh","emotion":"calm"}。
- language 填实际发言语种，取 ja、zh 或 en。
- emotion 取 angry、happy、sad、shy、calm、excited 或 lost。
- pauses 可选，标记句间停顿。idx 是停顿前的小句序号，按 。！？!? 分句，从 0 开始。level 取 weak、medium 或 strong。

选择沉默时只返回 {"silence":true}。`;
