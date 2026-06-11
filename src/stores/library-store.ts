// Zustand store for the user's authored library items. Single source of
// truth for the prompts / skills / commands / hooks / templates the user
// created themselves (distinct from plugin-contributed content, which lives
// in usePluginStore). Mirrors the shape/conventions of plugin-store.ts:
// a flat `items` array, a `loading` flag, and refresh/create/remove actions
// that re-fetch after every mutation so the UI never shows stale state.
import { create } from "zustand";
import * as api from "@/lib/library-api";
import type { CreateLibraryItem, LibraryItem } from "@/lib/library-api";

interface State {
  items: LibraryItem[];
  loading: boolean;
  error: string | null;

  /** Re-fetch every authored item (all kinds) from the backend. */
  refresh: () => Promise<void>;
  /** Create an item then refresh. Re-throws so the caller (create dialog)
   *  can surface 400/409 inline; the throw skips the refresh. */
  create: (body: CreateLibraryItem) => Promise<LibraryItem>;
  /** Edit an item then refresh. Re-throws so the dialog can surface errors. */
  update: (id: string, body: CreateLibraryItem) => Promise<LibraryItem>;
  /** Delete an item by id then refresh. */
  remove: (id: string) => Promise<void>;
}

export const useLibraryStore = create<State>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const items = await api.listLibraryItems();
      set({ items, loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  create: async (body) => {
    const item = await api.createLibraryItem(body);
    await get().refresh();
    return item;
  },

  update: async (id, body) => {
    const item = await api.updateLibraryItem(id, body);
    await get().refresh();
    return item;
  },

  remove: async (id) => {
    await api.deleteLibraryItem(id);
    await get().refresh();
  },
}));
