/**
 * Real-time synchronisation of a Univer workbook with the server operation log.
 *
 * - Local mutations are captured from CommandExecuted, batched and sent over WebSocket.
 *   The server assigns each batch a revision and relays it to the other clients.
 * - Remote batches are applied strictly in revision order (gaps are filled over REST).
 * - When a remote batch lands "under" local batches that were already applied
 *   (concurrent edits), absolute mutations are re-applied so every client ends with
 *   the server order; anything else triggers a rebuild from snapshot + log, which is
 *   deterministic for all clients.
 */
import { CommandType } from '@univerjs/core';

import { api as http, type OpsBatch } from '../api/client';
import type { FUniver } from './univer';

export interface Mutation {
  id: string;
  params: unknown;
}

export interface Peer {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  selection: { sheet?: string; range?: string } | null;
}

export type SyncStatus = 'connecting' | 'online' | 'offline';

export interface SyncCallbacks {
  onStatus: (status: SyncStatus) => void;
  onSaved: (state: 'saved' | 'saving' | 'unsaved' | 'error') => void;
  onPeers: (peers: Peer[]) => void;
  onRebuild: (reason: string) => Promise<void>;
  onTitle: (title: string) => void;
  onRole: (role: string) => void;
}

const MUTATION_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.mutation\.[A-Za-z0-9_.-]+$/;
// Mutations that set absolute state for their targets: replaying them reproduces server order.
const ABSOLUTE = new Set([
  'sheet.mutation.set-range-values',
  'sheet.mutation.set-worksheet-col-width',
  'sheet.mutation.set-worksheet-row-height',
  'sheet.mutation.set-worksheet-row-is-auto-height',
  'sheet.mutation.set-worksheet-name',
  'sheet.mutation.set-tab-color',
]);
const FLUSH_DELAY_MS = 40;
const SAVE_IDLE_MS = 2500;
const GAP_TIMEOUT_MS = 1200;
const PING_MS = 30_000;

function isSyncable(id: string): boolean {
  if (!MUTATION_ID.test(id)) return false;
  // doc.* mutations belong to the in-cell editor document (keystrokes), not to the workbook.
  if (id.startsWith('doc.')) return false;
  if (id.startsWith('formula.mutation.') && !id.includes('defined-name')) return false;
  return !id.includes('mark-dirty');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

interface OwnBatch {
  opId: string;
  ops: Mutation[];
}

export class WorkbookSync {
  private ws: WebSocket | null = null;
  private clientId = '';
  private rev: number;
  private pending: Mutation[] = [];
  private inflight: OwnBatch | null = null;
  /** Own batches acked with a revision that is not yet contiguous with `rev`. */
  private ownAhead = new Map<number, Mutation[]>();
  /** Remote batches waiting for earlier revisions. */
  private remoteAhead = new Map<number, Mutation[] | 'reset'>();
  /** Own batches already applied locally but not yet placed in server order. */
  private unordered: Mutation[][] = [];
  private applyingRemote = false;
  private disposed = false;
  private needsRebuild: string | null = null;
  private flushTimer: number | undefined;
  private saveTimer: number | undefined;
  private gapTimer: number | undefined;
  private pingTimer: number | undefined;
  private reconnectDelay = 500;
  private lastSavedRev: number;
  private authoredSinceSave = false;
  private peers = new Map<string, Peer>();
  private disposers: Array<() => void> = [];
  private canEdit: boolean;

  constructor(
    private readonly api: FUniver,
    private readonly workbookId: string,
    snapshotRev: number,
    canEdit: boolean,
    private readonly cb: SyncCallbacks,
  ) {
    this.rev = snapshotRev;
    this.lastSavedRev = snapshotRev;
    this.canEdit = canEdit;
  }

  get revision(): number {
    return this.rev;
  }

  /** Apply the log tail after the snapshot, then go online. */
  async start(): Promise<void> {
    await this.catchUp();
    this.listen();
    this.connect();
    const onUnload = () => this.saveOnExit();
    window.addEventListener('pagehide', onUnload);
    this.disposers.push(() => window.removeEventListener('pagehide', onUnload));
  }

  /** Re-initialise after the workbook was rebuilt from a fresh snapshot. */
  resetTo(snapshotRev: number): void {
    this.rev = snapshotRev;
    this.lastSavedRev = snapshotRev;
    this.pending = [];
    this.inflight = null;
    this.ownAhead.clear();
    this.remoteAhead.clear();
    this.unordered = [];
    this.needsRebuild = null;
  }

  async catchUp(): Promise<void> {
    const tail = await http.ops(this.workbookId, this.rev);
    for (const batch of tail) {
      // Our own batch reached the log before the connection dropped: treat it as acked.
      if (this.inflight && batch.op_id === this.inflight.opId) this.onAck(batch.op_id, batch.rev);
      else this.receiveRemote(batch.rev, batch.ops as unknown as Mutation[]);
    }
  }

  setCanEdit(canEdit: boolean): void {
    this.canEdit = canEdit;
  }

  sendSelection(selection: Peer['selection']): void {
    this.send({ type: 'presence', selection });
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.flushTimer);
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.gapTimer);
    window.clearInterval(this.pingTimer);
    this.disposers.forEach((d) => d());
    this.ws?.close();
  }

  // ------------------------------------------------------------- local side

  private listen(): void {
    const disposable = this.api.addEvent(this.api.Event.CommandExecuted, (event) => {
      if (this.applyingRemote || event.type !== CommandType.MUTATION) return;
      const options = event.options ?? {};
      if (options.onlyLocal || options.fromCollab || options.fromChangeset) return;
      if (!isSyncable(event.id)) return;
      const unitId = (event.params as { unitId?: string } | undefined)?.unitId;
      if (unitId && unitId !== this.api.getActiveWorkbook()?.getId()) return;
      if (!this.canEdit) return;
      this.pending.push({ id: event.id, params: clone(event.params) });
      this.authoredSinceSave = true;
      this.cb.onSaved('unsaved');
      this.scheduleFlush();
    });
    this.disposers.push(() => disposable.dispose());
  }

  private scheduleFlush(): void {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  private flush(): void {
    if (this.inflight || this.pending.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const batch: OwnBatch = { opId: crypto.randomUUID(), ops: this.pending.splice(0, 500) };
    this.inflight = batch;
    this.unordered.push(batch.ops);
    this.cb.onSaved('saving');
    this.send({ type: 'ops', opId: batch.opId, baseRev: this.rev, ops: batch.ops });
  }

  private resendInflight(): void {
    if (this.inflight) {
      const { opId, ops } = this.inflight;
      this.send({ type: 'ops', opId, baseRev: this.rev, ops });
    } else {
      this.flush();
    }
  }

  private onAck(opId: string, rev: number): void {
    if (!this.inflight || this.inflight.opId !== opId) return;
    if (rev > this.rev) {
      this.ownAhead.set(rev, this.inflight.ops);
    } else {
      this.unordered.pop(); // the inflight batch is always the newest unordered entry
    }
    this.inflight = null;
    this.drain();
    this.flush();
  }

  // ------------------------------------------------------------- remote side

  private receiveRemote(rev: number, ops: Mutation[] | Array<Record<string, unknown>>): void {
    if (rev <= this.rev) return;
    const isReset = ops.length === 1 && (ops[0] as Record<string, unknown>).reset === true;
    this.remoteAhead.set(rev, isReset ? 'reset' : (ops as Mutation[]));
    this.drain();
  }

  /** Advance `rev` over contiguous revisions, applying remote batches in order. */
  private drain(): void {
    for (;;) {
      const next = this.rev + 1;
      const own = this.ownAhead.get(next);
      if (own) {
        this.ownAhead.delete(next);
        this.unordered.shift();
        this.rev = next;
        continue;
      }
      const remote = this.remoteAhead.get(next);
      if (!remote) break;
      this.remoteAhead.delete(next);
      this.rev = next;
      if (remote === 'reset') {
        this.requestRebuild('Версия восстановлена');
        return;
      }
      this.applyRemote(remote);
    }
    window.clearTimeout(this.gapTimer);
    if (this.remoteAhead.size > 0) {
      this.gapTimer = window.setTimeout(() => void this.catchUp(), GAP_TIMEOUT_MS);
    }
    if (!this.inflight && this.pending.length === 0) {
      if (this.authoredSinceSave) this.cb.onSaved('saving');
      this.scheduleSave();
    }
  }

  private applyRemote(ops: Mutation[]): void {
    const localUnder = [...this.unordered, this.pending];
    const conflicts = localUnder.some((batch) => batch.length > 0);
    if (conflicts) {
      const allAbsolute = [...ops, ...localUnder.flat()].every((m) => ABSOLUTE.has(m.id));
      if (!allAbsolute) {
        this.requestRebuild('Одновременное изменение структуры');
        return;
      }
    }
    this.execute(ops);
    if (conflicts) {
      // Local edits are ordered after this batch on the server: replay them on top.
      for (const batch of localUnder) this.execute(batch);
    }
  }

  private execute(ops: Mutation[]): void {
    this.applyingRemote = true;
    try {
      for (const op of ops) {
        try {
          // fromCollab (not onlyLocal): the formula engine must see peer edits to recalculate.
          this.api.syncExecuteCommand(op.id, op.params as object, { fromCollab: true });
        } catch (error) {
          console.warn('Failed to apply mutation', op.id, error);
        }
      }
    } finally {
      this.applyingRemote = false;
    }
  }

  private requestRebuild(reason: string): void {
    if (this.needsRebuild) return;
    this.needsRebuild = reason;
    // Let own batches reach the server first so the log contains them.
    const tryRebuild = () => {
      if (this.disposed) return;
      if (this.inflight || this.pending.length) {
        this.flush();
        window.setTimeout(tryRebuild, 150);
        return;
      }
      void this.cb.onRebuild(reason);
    };
    tryRebuild();
  }

  // ------------------------------------------------------------- snapshots

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    if (!this.authoredSinceSave || !this.canEdit) {
      if (this.rev === this.lastSavedRev || !this.authoredSinceSave) this.cb.onSaved('saved');
      return;
    }
    this.saveTimer = window.setTimeout(() => void this.saveSnapshot(), SAVE_IDLE_MS);
  }

  private snapshot(): unknown {
    return this.api.getActiveWorkbook()?.save();
  }

  async saveSnapshot(): Promise<void> {
    if (this.inflight || this.pending.length || this.unordered.length || this.needsRebuild) return;
    const rev = this.rev;
    const snapshot = this.snapshot();
    if (!snapshot) return;
    try {
      await http.saveSnapshot(this.workbookId, rev, snapshot);
      this.lastSavedRev = rev;
      if (this.rev === rev && !this.pending.length) this.authoredSinceSave = false;
      this.cb.onSaved('saved');
    } catch {
      this.cb.onSaved('error');
    }
  }

  private saveOnExit(): void {
    if (!this.authoredSinceSave || this.inflight || this.pending.length || this.unordered.length) return;
    const snapshot = this.snapshot();
    if (!snapshot) return;
    void fetch(`/api/workbooks/${this.workbookId}/snapshot`, {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: this.rev, snapshot }),
    }).catch(() => undefined);
  }

  // ------------------------------------------------------------- transport

  private connect(): void {
    if (this.disposed) return;
    this.cb.onStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/api/workbooks/${this.workbookId}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(event.data as string));
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.disposed) return;
      this.cb.onStatus('offline');
      // An unacknowledged batch may or may not be in the log. It keeps its opId: after
      // catching up it is either recognised in the log or resent (the server dedupes).
      window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private onMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'hello': {
        this.clientId = String(message.clientId);
        this.cb.onRole(String(message.role));
        this.peers = new Map((message.peers as Peer[]).map((p) => [p.clientId, p]));
        this.emitPeers();
        this.cb.onStatus('online');
        void this.catchUp().then(() => this.resendInflight());
        break;
      }
      case 'ack':
        this.onAck(String(message.opId), Number(message.rev));
        break;
      case 'ops':
        if (message.clientId === this.clientId) break;
        this.receiveRemote(Number(message.rev), message.ops as Mutation[]);
        break;
      case 'reset':
        this.receiveRemote(Number(message.rev), [{ reset: true }]);
        break;
      case 'presence': {
        const peer = message as unknown as Peer;
        if (peer.clientId !== this.clientId) {
          this.peers.set(peer.clientId, peer);
          this.emitPeers();
        }
        break;
      }
      case 'leave':
        this.peers.delete(String(message.clientId));
        this.emitPeers();
        break;
      case 'meta':
        this.cb.onTitle(String(message.title));
        break;
      case 'error':
        console.warn('Sync error:', message.message);
        break;
    }
  }

  private emitPeers(): void {
    this.cb.onPeers([...this.peers.values()]);
  }
}

export type { OpsBatch };
