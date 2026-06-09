/** Slack IM (DM-with-the-bot) channel IDs start with `D`. */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith('D');
}

export interface ChannelDecision {
  allowed: boolean;
  /** When not allowed, an ephemeral message explaining where to run the command. */
  message?: string;
}

/**
 * Decide whether a devops slash command may run where it was invoked. Allowed in
 * the ops channel, or in a DM with the bot for an explicitly allowlisted user.
 * That keeps the surface to exactly the ops channel + each listed person's own
 * 1:1 DM — not any channel, and not anyone else's DM (a 1:1 DM only routes the
 * allowlisted user's own messages, so `/deploy` stays restricted).
 */
export function decideCommandChannel(
  command: string, opsChannelId: string, dmUserIds: string[], channelId: string, userId: string,
): ChannelDecision {
  if (channelId === opsChannelId) return { allowed: true };
  if (isDmChannel(channelId) && dmUserIds.includes(userId)) return { allowed: true };
  return { allowed: false, message: `Run \`${command}\` in <#${opsChannelId}>.` };
}

/** Read the invoking channel stashed in a modal's private_metadata (falls back). */
export function channelFromView(view: { private_metadata?: string } | undefined, fallback: string): string {
  try {
    const meta = JSON.parse(view?.private_metadata || '{}') as { channel?: string };
    return meta.channel || fallback;
  } catch {
    return fallback;
  }
}
