/** Sentinel chat-store key used for compose-time messages (welcome
 *  typewriter, "pick a folder" warnings, etc.). The composer doesn't
 *  have a session id yet, so these messages live under this fixed key
 *  in chat-store. They are NOT migrated to the real session id on
 *  commitComposer — by design, they're transient compose-mode UX and
 *  disappear the moment the surface flips to the real session.
 *
 *  Lives in its own module because BOTH stores need it: app-store owns the
 *  composer lifecycle and chat-store must know not to evict the key (see
 *  `evictInactive`). app-store already imports chat-store, so declaring it
 *  there would make that dependency circular. app-store re-exports it, so
 *  `import { COMPOSER_CHAT_KEY } from "@/stores/app-store"` keeps working. */
export const COMPOSER_CHAT_KEY = "__composer__";
