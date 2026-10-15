const $ = id => document.getElementById(id);
let token = '', timer, snapshot, generation = 0, eventCursor = 0;
const labels = { queued:'送信待ち', delivering:'配送中', accepted:'受信済み', processing:'処理中（報告）', completed:'処理完了（報告）', failed:'配送失敗', uncertain:'配信結果不明' };
function node(tag, value, className) {
  const el = document.createElement(tag); if (value != null) el.textContent = value;
  if (className) el.className = className; return el;
}
async function api(path) {
  const response = await fetch(path, { headers:{ Authorization:`Bearer ${token}` }, cache:'no-store' });
  if (!response.ok) throw new Error(`接続エラー (${response.status})`);
  return response.json();
}
function table(id, rows) {
  $(id).replaceChildren(...rows.map(row => { const tr = node('tr'); for (const cell of row) tr.append(node('td', cell)); return tr; }));
}
function renderMessages() {
  if (!snapshot) return;
  const session = $('sessionFilter').value, task = $('taskFilter').value, status = $('statusFilter').value;
  const messages = snapshot.messages.filter(m => (!session || m.from === session || m.to === session) && (!task || m.taskId?.includes(task)) && (!status || m.status === status));
  $('messages').replaceChildren(...messages.reverse().map(m => {
    const article = node('article');
    const title = node('div', `${new Date(m.createdAt).toLocaleString()}  ${m.from} → ${m.to}`);
    title.append(node('span', labels[m.status] ?? m.status, `badge ${m.status}`));
    const meta = node('div', `${m.sender.provider}/${m.sender.model} → ${m.recipient.provider}/${m.recipient.model} | タスク: ${m.taskId ?? '—'}`, 'muted');
    const details = node('details'); details.append(node('summary', m.body.slice(0, 120)), node('pre', m.body));
    details.append(node('div', `メッセージID: ${m.id} | 返信先: ${m.replyTo ?? '—'} | 配送試行: ${m.attempts}`));
    if (m.error) details.append(node('pre', m.error));
    article.append(title, meta, details); return article;
  }));
  if (!messages.length) $('messages').append(node('p', '該当する通信はありません。'));
}
async function refresh(run) {
  try {
    const data = await api('/api/snapshot');
    if (run !== generation) return;
    if (!snapshot || snapshot.lastSeq !== data.lastSeq) {
      snapshot = data;
      table('sessions', data.sessions.map(s => [s.id, s.role, `${s.provider} / ${s.model}`,s.activity ? `${s.activity.status} (${new Date(s.activity.observedAt).toLocaleTimeString()})` : '未観測']));
      table('tasks', data.tasks.map(t => [`${t.id}: ${t.title}`, t.owner ?? '未割当', t.status, `v${t.revision} / ${t.headSha?.slice(0,12) ?? '—'}`]));
      const selection = $('sessionFilter').value;
      $('sessionFilter').replaceChildren(new Option('すべて',''), ...data.sessions.map(s => new Option(s.id,s.id)));
      $('sessionFilter').value = selection;
      renderMessages();
    }
    $('connection').textContent = `接続中 · 最終確認 ${new Date().toLocaleTimeString()} · イベント #${data.lastSeq}`;
  } catch (error) { if (run === generation) $('connection').textContent = `${error.message} — 再接続を試みます`; }
  if (run === generation) timer = setTimeout(() => refresh(run), 2000);
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); clearTimeout(timer); const run = ++generation;
  token = $('token').value; $('token').value = '';
  snapshot = undefined; eventCursor = 0; $('events').replaceChildren();
  $('content').hidden = false; await refresh(run);
});
$('disconnect').addEventListener('click', () => {
  ++generation; clearTimeout(timer); token = ''; snapshot = undefined;
  for (const id of ['sessions','tasks','messages','events']) $(id).replaceChildren();
  $('content').hidden = true; $('connection').textContent = '切断しました';
});
for (const id of ['sessionFilter','statusFilter','taskFilter']) $(id).addEventListener('input', renderMessages);
$('history').addEventListener('click', async () => {
  const run = generation;
  $('history').disabled = true;
  try {
    const { events } = await api(`/api/events?after=${eventCursor}`);
    if (run !== generation) return;
    for (const event of events) {
      const details = node('details');
      details.append(node('summary', `#${event.seq} ${event.time} ${event.type}`), node('pre',JSON.stringify(event.data,null,2)));
      $('events').append(details); eventCursor = event.seq;
    }
    if (!events.length) $('connection').textContent = '履歴の末尾です。';
  } catch (error) { if (run === generation) $('connection').textContent = error.message; }
  finally { $('history').disabled = false; }
});
