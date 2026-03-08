export interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}

export interface AiDraftRequest {
  instruction: string;
  threadId: string | null;
  accountId: string;
}

export interface AiDraftResponse {
  draftHtml: string;
  draftText: string;
  suggestedSubject: string | null;
  tokensUsed: number;
}
