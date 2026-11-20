// Where Tiro thinks (the Model page's "Brain" setting):
// - 'server': the Tiro server answers (its Claude API key and local models), with Tiro's own tools plus this PC's
//   tools (pc_*), which run here when it calls them. The conversation is saved in Tiro's chats like the phone's.
// - 'pc': this app's own agent answers, on whatever is signed in on the Model page (a Claude subscription); each
//   finished turn is copied into Tiro's chats, and Tiro's memory is in its prompt.
// Long "take over my screen" jobs always run on the PC's agent: the server hands them over with pc_takeover.
//
// The server protocol (tiro: brain/app/desktop.py): POST /desktop/chat → {call} | {done} | {wait}; a call is run
// here and answered with POST /desktop/turn/{id}, a wait with GET /desktop/turn/{id}. Everything a PC tool reads
// from the screen or other apps reaches the server as tool output, which it treats as information, not instructions.
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { z } from 'zod';

export const BRAINS = ['server', 'pc'];
export const brainOf = (config) => (BRAINS.includes(config?.brain) ? config.brain : 'server');

// The PC tools the server may use, and whether each acts (clicks, types, opens, writes, runs, saves): the server
// refuses an acting tool when email or the web were read in the same message. The rest only read, point or show.
// say, notify, remind and get_context are the server's own (desktools.mjs); the PC's agent never gets them.
// Separately, every tier-2 tool asks Jamie first on the PC (safety.mjs TIERS; tools.mjs).
export const PC_TOOLS = new Map([
  ['take_screenshot', false], ['read_window', false], ['list_windows', false], ['read_selection', false],
  ['draw', false], ['see_photo', false], ['list_files', false], ['search_files', false], ['read_file', false],
  ['open', true], ['act_in_app', true], ['write_file', true], ['run_command', true],
  ['say', false], ['notify', false], ['get_context', false], ['remind', true],
]);
export const PREFIX = 'pc_';
const TAKEOVER = 'takeover';

/** The handover tool: the server calls it for a long job, and the PC's own agent does the job after the turn. */
export function takeoverTool(onTask) {
  return {
    name: TAKEOVER,
    description: 'Hand a long, multi-step job on this PC (many clicks across apps, filling in long forms, minutes of work) to the PC\'s own agent, which carries it out after this reply and reports back in this chat. task: the whole job in plain words, with every detail it needs. Say in your reply that it\'s started.',
    parameters: z.object({ task: z.string().min(1).max(4000) }),
    execute: async ({ task }) => { onTask(task); return 'Started: the PC\'s agent takes over after this reply and reports back in this chat.'; },
  };
}

/** The tool list sent to the server: Claude tool definitions named pc_*, with acts. Tools that can't be described
 *  (a schema the converter refuses) are left out. */
export function pcTools(tools, { allowActions = false } = {}) {
  const out = [];
  for (const t of tools) {
    const acts = t.name === TAKEOVER ? true : PC_TOOLS.get(t.name);
    if (acts === undefined) continue;
    if (!allowActions && (t.name === 'write_file' || t.name === 'run_command')) continue; // switched off: they'd refuse
    let schema;
    try { schema = resolveToolSchema(t); } catch { continue; }
    if (!schema || schema.type !== 'object') continue;
    out.push({ name: PREFIX + t.name, description: String(t.description ?? '').slice(0, 2000), input_schema: schema, acts });
  }
  return out;
}

// Arguments checked against the tool's own schema first (its defaults filled in), as the PC's agent does; a model
// that writes null for "not given" is forgiven once.
const stripNulls = (v) => (Array.isArray(v) ? v.map(stripNulls) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)])) : v);
export function parseArgs(tool, args) {
  if (!tool.parameters?.parse) return args;
  try { return tool.parameters.parse(args); } catch (first) {
    try { return tool.parameters.parse(stripNulls(args)); } catch { throw new Error(`Those arguments don't fit ${tool.name}: ${String(first?.message ?? first).slice(0, 400)}`); }
  }
}

/** A tool's result as the server takes it: text, or text and pictures. */
export function toServer(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.content === 'string') return result.content;
  const parts = Array.isArray(result?.content) ? result.content : null;
  if (!parts) return JSON.stringify(result ?? '');
  return parts.map((p) => (p?.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.mediaType ?? p.mimeType ?? 'image/jpeg', data: p.data } }
    : { type: 'text', text: String(p?.text ?? '') }));
}

/**
 * One turn on the server, as the same events the PC's own agent gives (text_delta, tool_call_start/end, turn_end),
 * so the bubble, the voice and the activity list work the same either way.
 * call: tiro.mjs's tiroCall. tools: the PC tools by name (the agent's tool objects). chat: { id } kept across turns.
 */
export async function* serverEvents({ message, images = [], chat, tools, call, signal, localOk = true, allowActions = false, log = () => {} }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const sent = pcTools(tools, { allowActions });
  const t0 = Date.now();
  let ev = await call('POST', '/desktop/chat', { message, images, tools: sent, local_ok: localOk, ...(chat.id ? { chat_id: chat.id } : {}) }, { timeout: 90_000 });
  let n = 0;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    if (ev.error) throw new Error(`Tiro: ${ev.error}`);
    if (ev.done) {
      const d = ev.done;
      if (d.chat_id) chat.id = d.chat_id;
      log({ model: d.model, local: !!d.local, tools: d.tools?.length ?? 0, ms: Date.now() - t0 });
      yield { type: 'text_delta', text: d.reply ?? '' };
      yield { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: d.usage?.input ?? 0, outputTokens: d.usage?.output ?? 0 } };
      return;
    }
    if (ev.wait) { yield { type: 'ping' }; ev = await call('GET', `/desktop/turn/${encodeURIComponent(ev.turn)}`, undefined, { timeout: 90_000 }); continue; }
    if (!ev.call) throw new Error('Tiro sent something this app doesn\'t understand. Update the app?');
    const { id, name, input } = ev.call;
    const local = String(name).startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    const tool = byName.get(local);
    const toolCallId = `srv-${++n}-${id}`;
    yield { type: 'tool_call_start', toolCallId, name: local, args: input ?? {} };
    const started = Date.now();
    let content, isError = false;
    if (!tool) { content = `This PC has no tool called ${name}.`; isError = true; }
    else {
      try { content = toServer(await tool.execute(parseArgs(tool, input ?? {}), { signal, toolCallId })); }
      catch (e) { content = String(e?.message ?? e).slice(0, 2000); isError = true; }
    }
    yield { type: 'tool_call_end', toolCallId, isError, result: typeof content === 'string' ? content : '(text and a picture)', durationMs: Date.now() - started };
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    ev = await call('POST', `/desktop/turn/${encodeURIComponent(ev.turn)}`, { id, content, is_error: isError }, { timeout: 90_000 });
  }
}

/** Saves a turn the PC answered itself in Tiro's chats (user omitted: a finished takeover's report). */
export async function noteTurn({ call, chat, user, reply, model = '', source = 'pc' }) {
  if (!reply?.trim()) return;
  const r = await call('POST', '/desktop/note', { reply: reply.slice(0, 40000), ...(user ? { user: user.slice(0, 20000) } : {}), model: String(model).slice(0, 80), source, ...(chat.id ? { chat_id: chat.id } : {}) });
  if (r.chat_id) chat.id = r.chat_id;
}

/** Tiro's memory for the PC's own agent's prompt (approved items only), or '' when the server can't be reached. */
export async function tiroMemory(call) {
  const r = await call('GET', '/memory', undefined, { timeout: 8000 });
  const items = (r.items ?? []).filter((m) => !m.pending).map((m) => `- ${String(m.text).slice(0, 300)}`);
  return items.length ? items.slice(-60).join('\n') : '';
}
