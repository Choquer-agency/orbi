// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED — JWT/Fastify HTTP client.
//
// The backend has been replaced by Convex (queries + mutations + actions).
// New code MUST use `useQuery` / `useMutation` from `convex/react` with the
// generated `api` from `convex/_generated/api`.
//
// This file is kept as a stub so files that still reference `api.get/post/...`
// continue to type-check during the migration. Each method throws at runtime.
// Phase 5+ agents will delete every remaining import; this file goes away
// once the last consumer is migrated.
// ─────────────────────────────────────────────────────────────────────────────

const STUB_MESSAGE =
  'lib/api.ts is deprecated. Use Convex hooks (useQuery / useMutation) from convex/react instead.';

class ApiClientStub {
  setToken(_token: string | null) {
    /* no-op — Convex Auth manages session */
  }

  setOnUnauthorized(_callback: () => void) {
    /* no-op */
  }

  async get<T>(_path: string): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }

  async post<T>(_path: string, _body?: unknown): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }

  async patch<T>(_path: string, _body: unknown): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }

  async put<T>(_path: string, _body?: unknown): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }

  async postFormData<T>(_path: string, _formData: FormData): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }

  async delete<T>(_path: string): Promise<T> {
    throw new Error(STUB_MESSAGE);
  }
}

export const api = new ApiClientStub();
