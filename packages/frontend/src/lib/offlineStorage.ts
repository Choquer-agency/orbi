import { createStore, get, set, del } from 'idb-keyval';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

const idbStore = createStore('orbi-cache', 'query-cache');
const CACHE_KEY = 'tanstack-query';

export const offlinePersister: Persister = {
  persistClient: async (client: PersistedClient) => {
    await set(CACHE_KEY, client, idbStore);
  },
  restoreClient: async () => {
    return await get<PersistedClient>(CACHE_KEY, idbStore);
  },
  removeClient: async () => {
    await del(CACHE_KEY, idbStore);
  },
};
