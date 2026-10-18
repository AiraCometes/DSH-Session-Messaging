import { randomUUID } from 'node:crypto';
import { ensure, identifier, integer, oneOf, text, SESSION_ADDRESS_MAX_BYTES, SESSION_LABEL_MAX_BYTES } from './validation.js';
import { DeliveryRejected } from './delivery.js';

const TERMINAL = ['completed'];
const TASK_STATES = ['pending', 'in_progress', 'blocked', 'review', 'completed'];

/** Model/transport independent coordination service. No Harness imports here. */
export class ControlTower {
  constructor(store, { maxMessageBytes = 65536, maxPending = 1000, maxThreadMessages = 32, maxSendsPerMinute = 60 } = {}) {
    this.store = store;
    this.maxMessageBytes = integer(maxMessageBytes, 'maxMessageBytes', 1);
    this.maxPending = integer(maxPending, 'maxPending', 1);
    this.maxThreadMessages = integer(maxThreadMessages, 'maxThreadMessages', 1);
    this.maxSendsPerMinute = integer(maxSendsPerMinute, 'maxSendsPerMinute', 1);
    this.adapters = new Map();
    // Acceptance can have happened before the previous owner crashed. Never resend blindly.
    store.transaction(() => {
      for (const message of store.all('messages').filter(m => m.status === 'delivering')) {
        this.setMessage(message, 'uncertain', { error: 'Process stopped during delivery; verify target before retry.' });
      }
    });
  }

  registerAdapter(name, adapter) {
    identifier(name, 'adapter');
    ensure(!this.adapters.has(name), 'DUPLICATE_ADAPTER', `Adapter ${name} already registered`);
    ensure(typeof adapter?.deliver === 'function', 'INVALID_ADAPTER', 'Adapter must implement deliver()');
    this.adapters.set(name, adapter);
    return () => this.adapters.delete(name);
  }

  registerSession(input) {
    const value = {
      id: identifier(input.id),
      role: oneOf(input.role, ['tower', 'spec', 'implementation', 'review', 'integration'], 'role'),
      adapter: identifier(input.adapter, 'adapter'),
      address: text(input.address, 'address', SESSION_ADDRESS_MAX_BYTES),
      model: text(input.model, 'model', SESSION_LABEL_MAX_BYTES),
      provider: text(input.provider, 'provider', SESSION_LABEL_MAX_BYTES),
    };
    return this.store.transaction(() => {
      const existing = this.store.get('sessions', value.id);
      if (existing) {
        ensure(JSON.stringify(existing) === JSON.stringify(value), 'SESSION_CONFLICT', 'Session binding is immutable; use a new id', 409);
        return existing;
      }
      this.store.put('sessions', value);
      this.store.append('session.registered', value);
      return value;
    });
  }

  session(id) {
    const session = this.store.get('sessions', identifier(id));
    ensure(session, 'NOT_FOUND', `Unknown session ${id}`, 404);
    return session;
  }

  message(id) {
    const message = this.store.get('messages', identifier(id));
    ensure(message, 'NOT_FOUND', `Unknown message ${id}`, 404);
    return message;
  }

  /** All mutating model-facing calls supply the sender from trusted execution context. */
  send(actor, input) {
    return this.store.transaction(() => this.enqueue(actor, input));
  }

  enqueue(actor, input) {
    const sender = this.session(actor);
    const recipient = this.session(input.to);
    ensure(actor !== input.to, 'SELF_MESSAGE', 'Cannot send to self');
    const body = text(input.body, 'body', this.maxMessageBytes);
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 200);
    const taskId = input.taskId == null ? null : this.task(input.taskId).id;
    const parent = input.replyTo == null ? null : this.message(input.replyTo);
    const replyTo = parent?.id ?? null;
    ensure(!parent || parent.from === actor || parent.to === actor, 'FORBIDDEN', 'Reply must reference a message visible to this participant', 403);
    const key = JSON.stringify([actor, idempotencyKey]);
    const prior = this.store.db.prepare('SELECT data FROM messages WHERE idem=?').get(key);
    const payload = { from: actor, to: recipient.id, body, taskId, replyTo };
    if (prior) {
      const existing = JSON.parse(prior.data);
      ensure(Object.entries(payload).every(([k, v]) => existing[k] === v),
        'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different payload', 409);
      return existing;
    }
    const since = new Date(Date.now() - 60000).toISOString();
    const recent = this.store.db.prepare("SELECT count(*) AS n FROM messages WHERE json_extract(data,'$.from')=? AND json_extract(data,'$.createdAt')>=?").get(actor, since).n;
    ensure(recent < this.maxSendsPerMinute, 'RATE_LIMITED', 'Sender message rate exceeded; batch related updates', 429);
    const id = randomUUID();
    const threadId = parent?.threadId ?? parent?.id ?? id;
    const threadCount = this.store.db.prepare("SELECT count(*) AS n FROM messages WHERE json_extract(data,'$.threadId')=?").get(threadId).n;
    ensure(threadCount < this.maxThreadMessages, 'THREAD_LIMIT', 'Conversation thread limit reached; ask tower to summarize and decide next steps', 429);
    const pending = this.store.db.prepare("SELECT count(*) AS n FROM messages WHERE status IN ('queued','delivering')").get().n;
    ensure(pending < this.maxPending, 'QUEUE_FULL', 'Pending message limit reached', 429);
    const value = {
      id, threadId, key, ...payload, sender, recipient,
      status: 'queued', attempts: 0, createdAt: new Date().toISOString(),
    };
    this.store.putMessage(value, true);
    this.store.append('message.queued', value);
    return value;
  }

  setMessage(message, status, fields = {}) {
    const next = { ...message, ...fields, status, updatedAt: new Date().toISOString() };
    this.store.putMessage(next);
    this.store.append(`message.${status}`, next);
    return next;
  }

  async dispatch(id) {
    const claimed = this.store.transaction(() => {
      const current = this.message(id);
      if (current.status !== 'queued') return undefined;
      return this.setMessage(current, 'delivering', { attempts: current.attempts + 1, error: null });
    });
    if (!claimed) return this.message(id);
    const adapter = this.adapters.get(claimed.recipient.adapter);
    let status, fields;
    try {
      if (!adapter) throw new DeliveryRejected(`Adapter ${claimed.recipient.adapter} is unavailable`);
      const receipt = await adapter.deliver(structuredClone(claimed));
      ensure(receipt && typeof receipt.id === 'string' && receipt.id.length > 0,
        'BAD_RECEIPT', 'Adapter returned no acceptance receipt');
      status = 'accepted'; fields = { receiptId: receipt.id };
    } catch (error) {
      status = error instanceof DeliveryRejected ? 'failed' : 'uncertain';
      fields = { error: String(error.message ?? error).slice(0, 2000) };
    }
    return this.store.transaction(() => this.setMessage(this.message(id), status, fields));
  }

  async dispatchQueued(limit = 100) {
    integer(limit, 'limit', 1, 1000);
    const ids = this.store.db.prepare("SELECT id FROM messages WHERE status='queued' ORDER BY rowid LIMIT ?").all(limit);
    for (const { id } of ids) await this.dispatch(id);
  }

  /** Retries are explicit, bounded by an operator decision, and use the same message id. */
  retry(actor, id, { confirmNotAccepted = false } = {}) {
    ensure(this.session(actor).role === 'tower', 'FORBIDDEN', 'Only tower may retry', 403);
    return this.store.transaction(() => {
      const message = this.message(id);
      ensure(message.status === 'failed' || (message.status === 'uncertain' && confirmNotAccepted === true),
        'RETRY_UNSAFE', 'Verify an uncertain delivery was not accepted before retrying', 409);
      return this.setMessage(message, 'queued', { error: null });
    });
  }

  report(actor, id, status) {
    return this.store.transaction(() => {
      const message = this.message(id);
      ensure(message.to === actor, 'FORBIDDEN', 'Only recipient may report processing', 403);
      oneOf(status, ['processing', 'completed'], 'status');
      const allowed = status === 'processing' ? ['accepted', 'uncertain'] : ['accepted', 'processing', 'uncertain'];
      ensure(allowed.includes(message.status), 'INVALID_TRANSITION', `Cannot mark ${message.status} as ${status}`, 409);
      return this.setMessage(message, status, { reportedBy: actor });
    });
  }

  task(id) {
    const task = this.store.get('tasks', identifier(id));
    ensure(task, 'NOT_FOUND', `Unknown task ${id}`, 404);
    return task;
  }

  createTask(actor, input) {
    ensure(this.session(actor).role === 'tower', 'FORBIDDEN', 'Only tower creates tasks', 403);
    return this.store.transaction(() => {
      const id = identifier(input.id);
      ensure(!this.store.get('tasks', id), 'TASK_EXISTS', 'Task already exists', 409);
      const value = {
        id, title: text(input.title, 'title', 500), description: text(input.description, 'description'),
        owner: input.owner == null ? null : this.session(input.owner).id,
        status: 'pending', revision: 1, blockedBy: [], specVersion: null, pr: null,
        kind: oneOf(input.kind ?? 'general', ['general', 'spec', 'implementation', 'review'], 'kind'),
        headSha: null, reviewedSha: null, review: null, ci: null,
      };
      this.store.put('tasks', value);
      this.store.append('task.created', { actor, task: value });
      return value;
    });
  }

  updateTask(actor, id, expectedRevision, patch) {
    const caller = this.session(actor);
    return this.store.transaction(() => {
      const current = this.task(id);
      ensure(caller.role === 'tower' || current.owner === actor, 'FORBIDDEN', 'Only tower or task owner may update', 403);
      integer(expectedRevision, 'expectedRevision', 1);
      ensure(current.revision === expectedRevision, 'STALE_REVISION', 'Read the latest task before updating', 409);
      ensure(patch && typeof patch === 'object' && !Array.isArray(patch), 'INVALID_INPUT', 'patch must be an object');
      const allowed = ['title', 'description', 'owner', 'status', 'blockedBy', 'specVersion', 'pr', 'headSha', 'reviewedSha', 'review', 'ci'];
      ensure(Object.keys(patch).every(key => allowed.includes(key)), 'INVALID_INPUT', 'Unknown task field');
      if ('owner' in patch) {
        ensure(caller.role === 'tower', 'FORBIDDEN', 'Only tower assigns owners', 403);
        if (patch.owner !== null) this.session(patch.owner);
      }
      if ('title' in patch) text(patch.title, 'title', 500);
      if ('description' in patch) text(patch.description, 'description');
      if ('status' in patch) oneOf(patch.status, TASK_STATES, 'status');
      if ('blockedBy' in patch) {
        ensure(Array.isArray(patch.blockedBy) && patch.blockedBy.length <= 100, 'INVALID_INPUT', 'blockedBy must be an array (max 100)');
        const visit = (dependency, seen = new Set()) => {
          ensure(dependency !== id, 'DEPENDENCY_CYCLE', 'Task dependencies must be acyclic', 409);
          if (seen.has(dependency)) return;
          seen.add(dependency);
          for (const next of this.task(dependency).blockedBy) visit(next, seen);
        };
        for (const dependency of patch.blockedBy) visit(dependency);
      }
      for (const key of ['specVersion', 'pr']) if (patch[key] != null) text(patch[key], key, 500);
      for (const key of ['headSha', 'reviewedSha']) if (patch[key] != null) {
        ensure(typeof patch[key] === 'string' && /^[a-f0-9]{40,64}$/i.test(patch[key]), 'INVALID_INPUT', `${key} must be a full commit SHA`);
      }
      // Implementation cannot approve its own work; approvals and CI reports have distinct writers.
      if ('review' in patch || 'reviewedSha' in patch) {
        ensure(caller.role === 'review' || caller.role === 'tower', 'FORBIDDEN', 'Review evidence requires reviewer or tower', 403);
        if (patch.review !== undefined) oneOf(patch.review, ['approved', 'changes_requested', null], 'review');
      }
      if ('ci' in patch) {
        ensure(caller.role === 'tower', 'FORBIDDEN', 'Only tower records CI evidence', 403);
        oneOf(patch.ci, ['passed', 'failed', 'pending', null], 'ci');
      }
      const next = { ...current, ...structuredClone(patch), revision: current.revision + 1 };
      if (next.headSha !== current.headSha) {
        next.review = null; next.reviewedSha = null; next.ci = null;
        if (current.status === 'completed' && !('status' in patch)) next.status = 'review';
      }
      if (TERMINAL.includes(next.status) || next.status === 'in_progress') {
        ensure(next.blockedBy.every(dep => this.task(dep).status === 'completed'), 'TASK_BLOCKED', 'Dependencies must be completed first', 409);
      }
      if (next.status === 'completed' && (next.kind === 'implementation' || next.headSha)) {
        ensure(next.headSha && next.review === 'approved' && next.reviewedSha === next.headSha && next.ci === 'passed',
          'MISSING_EVIDENCE', 'Completion requires review and passing CI for the current head SHA', 409);
      }
      this.store.put('tasks', next);
      this.store.append('task.updated', { actor, task: next });
      return next;
    });
  }

  events(after = 0, limit = 100) {
    return this.store.events(integer(after, 'after'), integer(limit, 'limit', 1, 500));
  }

  recordActivity(id, status) {
    this.session(id);
    text(status, 'activity status', 100);
    this.store.transaction(() => this.store.append('session.activity', {id, status}));
  }

  snapshot() {
    const activity = new Map(this.store.db.prepare("SELECT time,data FROM events WHERE seq IN (SELECT MAX(seq) FROM events WHERE type='session.activity' GROUP BY json_extract(data,'$.id'))").all()
      .map(row => {const value = JSON.parse(row.data);return [value.id,{status:value.status,observedAt:row.time}];}));
    return { sessions: this.store.all('sessions').map(session=>({...session, activity:activity.get(session.id) ?? null})), tasks: this.store.all('tasks'),
      messages: this.store.all('messages').slice(-200),
      lastSeq: this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq };
  }
}
