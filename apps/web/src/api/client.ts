export type Role = 'owner' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  is_personal: boolean;
  role: Role;
}

export interface WorkbookItem {
  id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
  owner_name: string;
  updated_at: string;
  role: Role;
  favorite: boolean;
  viewed_at: string | null;
}

export interface WorkbookDetail {
  id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
  favorite: boolean;
  head_rev: number;
  snapshot_rev: number;
  // Univer IWorkbookData
  snapshot: Record<string, unknown>;
  updated_at: string;
}

export interface OpsBatch {
  rev: number;
  client_id: string;
  op_id: string | null;
  ops: Array<Record<string, unknown>>;
}

export interface Share {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  source: 'workspace' | 'share';
}

export interface Version {
  id: string;
  rev: number;
  label: string | null;
  author: string | null;
  created_at: string;
}

export interface DbConnection {
  id: string;
  workspace_id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  sslmode: string;
  read_only: boolean;
  created_at: string;
}

export interface DbConnectionInput {
  workspace_id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: string;
  read_only: boolean;
}

export interface DbTable {
  name: string;
  kind: 'table' | 'partitioned' | 'view' | 'materialized_view' | 'foreign';
  estimated_rows: number;
  comment: string | null;
}

export interface DbColumn {
  name: string;
  type: string;
  base_type: string;
  category: string;
  not_null: boolean;
  has_default: boolean;
  is_identity: boolean;
  is_generated: boolean;
  enum_values: string[] | null;
  comment: string | null;
  references: { schema: string; table: string; column: string } | null;
}

export interface DbTableInfo {
  schema: string;
  name: string;
  kind: DbTable['kind'];
  columns: DbColumn[];
  primary_key: string[];
  estimated_rows: number;
  editable: boolean;
  can_update: boolean;
  can_insert: boolean;
  can_delete: boolean;
  read_only_reason: 'connection' | 'not_a_table' | 'no_primary_key' | null;
}

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'is_null'
  | 'not_null';

export interface RowsRequest {
  offset: number;
  limit: number;
  filters: Array<{ column: string; op: FilterOp; value?: string | null }>;
  sort: Array<{ column: string; desc: boolean }>;
}

export interface RowsPage {
  rows: Array<Array<string | null>>;
  total: number;
  total_exact: boolean;
}

export interface QueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  truncated: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

const FIELD_LABELS: Record<string, string> = {
  port: 'Порт',
  host: 'Хост',
  database: 'База данных',
  username: 'Пользователь',
  name: 'Название',
  email: 'Email',
  password: 'Пароль',
  title: 'Название',
  sql: 'SQL',
};

function errorMessage(status: number, detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: unknown }).message);
  }
  if (Array.isArray(detail) && detail[0]?.loc) {
    // FastAPI validation error: name the offending field instead of showing the raw message.
    const field = detail[0].loc[detail[0].loc.length - 1];
    return `Некорректное значение поля «${FIELD_LABELS[field] ?? field}»`;
  }
  return `Ошибка ${status}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const response = await fetch(`/api${path}`, init);
  if (response.status === 204) return undefined as T;
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail = typeof data === 'object' && data ? (data as { detail?: unknown }).detail : data;
    throw new ApiError(response.status, errorMessage(response.status, detail), detail);
  }
  return data as T;
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  me: () => request<User>('GET', '/auth/me'),
  login: (email: string, password: string) =>
    request<User>('POST', '/auth/login', { email, password }),
  register: (email: string, name: string, password: string) =>
    request<User>('POST', '/auth/register', { email, name, password }),
  logout: () => request<void>('POST', '/auth/logout'),

  workspaces: () => request<Workspace[]>('GET', '/workspaces'),
  createWorkspace: (name: string, icon = 'folder') =>
    request<Workspace>('POST', '/workspaces', { name, icon }),

  workbooks: (params: { view?: string; workspace_id?: string; q?: string }) =>
    request<WorkbookItem[]>('GET', `/workbooks${query(params)}`),
  createWorkbook: (workspace_id: string, title: string, template: 'blank' | 'finance') =>
    request<WorkbookDetail>('POST', '/workbooks', { workspace_id, title, template }),
  workbook: (id: string) => request<WorkbookDetail>('GET', `/workbooks/${id}`),
  updateWorkbook: (id: string, patch: { title?: string; workspace_id?: string }) =>
    request<WorkbookDetail>('PATCH', `/workbooks/${id}`, patch),
  deleteWorkbook: (id: string) => request<void>('DELETE', `/workbooks/${id}`),
  setFavorite: (id: string, favorite: boolean) =>
    request<void>(favorite ? 'PUT' : 'DELETE', `/workbooks/${id}/favorite`),
  ops: (id: string, since: number) => request<OpsBatch[]>('GET', `/workbooks/${id}/ops?since=${since}`),
  saveSnapshot: (id: string, rev: number, snapshot: unknown) =>
    request<{ snapshot_rev: number; head_rev: number }>('PUT', `/workbooks/${id}/snapshot`, {
      rev,
      snapshot,
    }),
  shares: (id: string) => request<Share[]>('GET', `/workbooks/${id}/shares`),
  share: (id: string, email: string, role: 'viewer' | 'editor') =>
    request<Share>('PUT', `/workbooks/${id}/shares`, { email, role }),
  unshare: (id: string, userId: string) => request<void>('DELETE', `/workbooks/${id}/shares/${userId}`),
  versions: (id: string) => request<Version[]>('GET', `/workbooks/${id}/versions`),
  createVersion: (id: string, label: string | null) =>
    request<Version>('POST', `/workbooks/${id}/versions`, { label }),
  restoreVersion: (id: string, versionId: string) =>
    request<{ snapshot_rev: number; head_rev: number }>(
      'POST',
      `/workbooks/${id}/versions/${versionId}/restore`,
    ),
  importFile: (workspaceId: string, file: File) => {
    const form = new FormData();
    form.set('workspace_id', workspaceId);
    form.set('file', file);
    return request<{ id: string; title: string }>('POST', '/workbooks/import', form);
  },
  exportFile: async (id: string, format: 'xlsx' | 'csv', snapshot: unknown, sheetId?: string) => {
    const response = await fetch(`/api/workbooks/${id}/export${query({ format, sheet_id: sheetId })}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    });
    if (!response.ok) throw new ApiError(response.status, 'Не удалось экспортировать файл');
    return response.blob();
  },

  connections: (workspace_id?: string) =>
    request<DbConnection[]>('GET', `/connections${query({ workspace_id })}`),
  testConnection: (data: DbConnectionInput) =>
    request<{ ok: boolean; server_version?: string; error?: string }>('POST', '/connections/test', data),
  testSavedConnection: (id: string) =>
    request<{ ok: boolean; server_version?: string; error?: string }>('POST', `/connections/${id}/test`),
  createConnection: (data: DbConnectionInput) => request<DbConnection>('POST', '/connections', data),
  updateConnection: (id: string, data: Partial<Omit<DbConnectionInput, 'password'>> & { password?: string | null }) =>
    request<DbConnection>('PATCH', `/connections/${id}`, data),
  deleteConnection: (id: string) => request<void>('DELETE', `/connections/${id}`),
  schemas: (id: string) => request<string[]>('GET', `/connections/${id}/schemas`),
  tables: (id: string, schema: string) =>
    request<DbTable[]>('GET', `/connections/${id}/schemas/${enc(schema)}/tables`),
  table: (id: string, schema: string, table: string) =>
    request<DbTableInfo>('GET', `/connections/${id}/schemas/${enc(schema)}/tables/${enc(table)}`),
  rows: (id: string, schema: string, table: string, body: RowsRequest) =>
    request<RowsPage>('POST', `/connections/${id}/schemas/${enc(schema)}/tables/${enc(table)}/rows`, body),
  updateRows: (
    id: string,
    schema: string,
    table: string,
    changes: Array<{
      pk: Record<string, string | null>;
      values: Record<string, string | null>;
      expected?: Record<string, string | null>;
    }>,
  ) =>
    request<{ rows: Array<Array<string | null>> }>(
      'PATCH',
      `/connections/${id}/schemas/${enc(schema)}/tables/${enc(table)}/rows`,
      { changes },
    ),
  insertRow: (id: string, schema: string, table: string, values: Record<string, string | null>) =>
    request<{ row: Array<string | null> }>(
      'POST',
      `/connections/${id}/schemas/${enc(schema)}/tables/${enc(table)}/rows/insert`,
      { values },
    ),
  deleteRows: (id: string, schema: string, table: string, keys: Array<Record<string, string | null>>) =>
    request<{ deleted: number }>(
      'POST',
      `/connections/${id}/schemas/${enc(schema)}/tables/${enc(table)}/rows/delete`,
      { keys },
    ),
  query: (id: string, sql: string, limit?: number) =>
    request<QueryResult>('POST', `/connections/${id}/query`, { sql, limit }),
};
