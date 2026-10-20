/** DM relay — pure parsing for "@bot dm @user <thing>" and "@bot dm @everyone <broadcast>" commands. */

/**
 * Parse a DM relay request from a channel message.
 * Only the BOT's own mention tag is stripped — the target's mention must
 * survive so we can read their user id from it.
 * @returns {{ targetId: string|null, targetName: string|null, instruction: string, broadcast: boolean } | null}
 *          null → not a DM request, run the normal reply pipeline.
 */
export function parseDmRequest({ content, botId = null }) {
  let text = String(content || "").trim();
  if (!text) return null;
  // strip the bot's mention wherever it appears (start usually)
  if (botId) text = text.replace(new RegExp(`<@!?${botId}>`, "g"), " ");
  text = text.trim();

  const kw = /^dms?\b|^broadcast\b/i;
  if (!kw.test(text)) return null;
  const isBroadcastKeyword = /^broadcast\b/i.test(text);

  const body = text.replace(/^dms?\b|^broadcast\b/i, "").trim();

  // no target and no content after the keyword
  if (!body) {
    return isBroadcastKeyword
      ? { targetId: null, targetName: null, instruction: "", broadcast: true }
      : { targetId: null, targetName: null, instruction: "", broadcast: false };
  }

  const idm = /^<@!?(\d+)>\s*([\s\S]*)$/.exec(body);
  if (idm) {
    return { targetId: idm[1], targetName: null, instruction: (idm[2] || "").trim(), broadcast: false };
  }

  // @everyone / @here → broadcast
  const evm = /^@(everyone|here)\b\s*([\s\S]*)$/i.exec(body);
  if (evm) {
    return { targetId: null, targetName: evm[1].toLowerCase(), instruction: (evm[2] || "").trim(), broadcast: true };
  }

  // name-based target: first token is the name, rest is the instruction
  const nm = /^@?([^\s<]{1,32})(?:\s+([\s\S]{0,400}))?$/.exec(body);
  if (nm && nm[1]) {
    if (/^(him|her|them|that|the|a|an|about|to)$/i.test(nm[1]) && !nm[2]) {
      return { targetId: null, targetName: null, instruction: "", broadcast: false };
    }
    const broadcast = nm[1].toLowerCase() === "everyone";
    return { targetId: null, targetName: broadcast ? null : nm[1], instruction: (nm[2] || "").trim(), broadcast };
  }
  return { targetId: null, targetName: null, instruction: body, broadcast: isBroadcastKeyword };
}

export const dmRelay = { parseDmRequest };
export default dmRelay;
