import { isWeb } from './platform';

function getApiBase(): string {
  if (!isWeb()) {
    return import.meta.env.VITE_API_URL || 'https://api.orbimail.com/api';
  }
  return '/api';
}

const API_BASE = getApiBase();

class ApiClient {
  private token: string | null = null;
  private onUnauthorized: (() => void) | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  private getHeaders(json = false): HeadersInit {
    const headers: HeadersInit = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs = 30000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleErrorResponse(res: Response) {
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new Error('Session expired. Please log in again.');
    }
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'POST',
      headers: this.getHeaders(!!body),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: this.getHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(!!body),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async postFormData<T>(path: string, formData: FormData): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'POST',
      headers: this.getHeaders(false),
      body: formData,
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(`${API_BASE}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      this.handleErrorResponse(res);
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || `Request failed: ${res.status}`);
    }
    return res.json();
  }
}

export const api = new ApiClient();
