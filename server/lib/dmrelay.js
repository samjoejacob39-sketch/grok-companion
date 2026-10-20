/** DM relay — pure parsing for "@bot dm @user <thing to say>" commands. */

/**
 * Parse a DM relay request from a channel message.
 * The caller must confirm the message mentions the bot; the leading bot
 * mention tag is stripped here.
 * @returns {{ targetId: string|null, targetName: string|null, instruction: string } | null}
 *          null → not a DM request, run the normal reply pipeline.
 */
export function parseDmRequest({ content, mentionIds = [] }) {
  let text = String(content || "").trim();
  if (!text) return null;
  // strip any leading mention tags (the bot's, and possibly the target's)
  for (const id of mentionIds) {
    text = text.replace(new RegExp(`<@!?${id}>`, "g"), " ");
  }
  text = text.trim();
  if (!/^dm\b(\s|$)/i.test(text) && !/^dms?\s/i.test(text)) return null;

  const body = text.replace(/^dms?\b/i, "").trim();
  // "@bot dm" with nothing after → generic hello delivery
  if (!body) return { targetId: null, targetName: null, instruction: "" };

  const idm = /^<@!?(\d+)>\s*(.*)$/.exec(body);
  if (idm) {
    return { targetId: idm[1], targetName: null, instruction: (idm[2] || "").trim() };
  }
  const nm = /^@?([^\s<]{1,32})(?:\s+([\s\S]{0,400}))?$/.exec(body);
  if (nm && nm[1]) {
    // common casual spellings of addressing someone: "dm him", "dm her📱"
    if (/^(him|her|them|their|that|the|a|an|about|to)$/i.test(nm[1]) && !nm[2]) {
      return { targetId: null, targetName: null, instruction: "" };
    }
    return { targetId: null, targetName: nm[1], instruction: (nm[2] || "").trim() };
  }
  return { targetId: null, targetName: null, instruction: body };
}

export const dmRelay = { parseDmRequest };
export default dmRelay;
