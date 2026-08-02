/**
 * Landing-layout rule — the one place that decides whether the chat surface
 * renders CENTERED (the "Talk to Fleetify" headline with the composer floating
 * mid-screen) or DOCKED (transcript fills the column, composer pinned to the
 * bottom).
 *
 * A freshly opened compose surface must ALWAYS come up centered. The welcome
 * line the composer seeds under the sentinel chat key ("Pick a folder above and
 * I'll take a look…") is scene setting, not conversation — it is written
 * asynchronously, so counting it as transcript made "New chat" open centered or
 * docked depending on which store write won the race.
 *
 * The first real send still docks the surface: a folderless send echoes the
 * typed text (`attempt-folder-*`) and answers with a warning (`warn-folder-*`),
 * both of which are conversation, as is anything the agent streams back.
 */

/** Message-id prefix for compose-mode scene setting (the welcome line). Shares
 *  the `welcome-` convention chat-view's `hasRealMessage` gate already uses. */
export const SCENE_MESSAGE_PREFIX = "welcome-";

export function isSceneMessage(id: string): boolean {
  return id.startsWith(SCENE_MESSAGE_PREFIX);
}

export function isLandingLayout(opts: {
  /** Empty Fleet hub (no active session, no composer). */
  isControlCenter: boolean;
  /** Compose surface — a not-yet-persisted new session. */
  isComposing: boolean;
  isStreaming: boolean;
  messages: ReadonlyArray<{ id: string }>;
}): boolean {
  const { isControlCenter, isComposing, isStreaming, messages } = opts;
  // A real session always uses the docked layout, empty or not.
  if (!isControlCenter && !isComposing) return false;
  if (isStreaming) return false;
  // Compose mode discounts scene-setting rows; the hub has none of its own, so
  // any message there means the staff agent is mid-conversation.
  return isComposing ? messages.every((m) => isSceneMessage(m.id)) : messages.length === 0;
}
