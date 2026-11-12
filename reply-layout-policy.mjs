export const DEFAULT_REPLY_MESSAGES=2;
export const MAX_REPLY_MESSAGE_SETTING=20;
export const validReplyMessageLimit=value=>Number.isInteger(value)&&value>=0&&value<=MAX_REPLY_MESSAGE_SETTING;
export function checkedReplyMessageLimit(value=DEFAULT_REPLY_MESSAGES){if(!validReplyMessageLimit(value))throw Error('分条数量必须为 0–20 的整数，0 表示不限制条数。');return value;}
export function validateReplyLayout(settings){if(settings===undefined)return;if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>key!=='maxMessages'))throw Error('分条发送设置无效。');if(settings.maxMessages!==undefined)checkedReplyMessageLimit(settings.maxMessages);}
export function replyMessageLimit(wechat){validateReplyLayout(wechat?.replyLayout);return checkedReplyMessageLimit(wechat?.replyLayout?.maxMessages);}
// The other party's consecutive messages are one thought: read them together and
// answer once. Split only when the ideas are genuinely separate.
const DEFAULT_NOTICE='微信消息节奏：对方连着发来的几条消息算一个整体，读懂以后再回，不要一句一句各回一次。只有意思确实独立、需要分开说的时候才分成多条，一次最多两条。多条之间用一个空行分隔，单个换行只用于消息内部排版。每条保持完整自然；简短答复只发一条，不为分段增加内容，不按字数、空格或逗号硬切。代码块、完整列表、引用和需要连续阅读的说明保持完整。';
export function replyLayoutNotice(value=DEFAULT_REPLY_MESSAGES){const limit=checkedReplyMessageLimit(value);if(limit===1)return '微信消息节奏：本轮只发送一条完整的微信文字回复，把对方连着的几条消息合并回答。保留正文中的换行排版，不拆成多条。简短自然，代码块、完整列表、引用和连续说明保持完整。';return DEFAULT_NOTICE.replace('一次最多两条',limit===0?'本轮不设固定条数上限，由你根据内容决定发送几条，避免机械碎片化':'本轮最多 '+limit+' 条').replace('多条之间用一个空行分隔','分条时用一个空行隔开不同的消息');}
export function splitReplyParts(text,enabled=true,maxMessages=DEFAULT_REPLY_MESSAGES){
 const limit=checkedReplyMessageLimit(maxMessages);if(!enabled||limit===1)return null;
 const paragraphs=text.split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/).map(part=>part.trim()).filter(Boolean);if(paragraphs.length<2)return null;
 if(limit===0||paragraphs.length<=limit)return paragraphs;
 return [...paragraphs.slice(0,limit-1),paragraphs.slice(limit-1).join(' ')];
}
