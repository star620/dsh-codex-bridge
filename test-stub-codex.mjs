// Stand-in for codex.exe used by test-async.mjs: answers "exec" with a thread id and
// "queue" with success, so the bridge's delivery plumbing can be tested without a paid turn.
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const mode = args[0]
const marker = process.env.STUB_MARKER || ''
if (marker) fs.appendFileSync(marker, JSON.stringify({ mode, args }) + '\n')
// Optionally simulate a Codex thread's rollout: 'queue' with STUB_ROLLOUT_DIR grows a file named
// after the thread. STUB_ROLLOUT_LINE=noise writes an unrelated turn (the counterexample from
// Codex review seq 19: the file moved, the queued message never arrived), anything else writes
// the arguments themselves so the bridge marker really is in there.
const rolloutDir = process.env.STUB_ROLLOUT_DIR || ''
if (rolloutDir && mode === 'queue') {
  const ti = args.indexOf('--thread')
  const thread = ti >= 0 ? args[ti + 1] : ''
  if (thread) {
    fs.mkdirSync(rolloutDir, { recursive: true })
    const file = path.join(rolloutDir, 'rollout-2026-11-18T00-00-00-' + thread + '.jsonl')
    const kind = process.env.STUB_ROLLOUT_LINE || ''
    const userLine = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: args.join(' ') }] },
    }) + '\n'
    if (kind === 'noise') {
      // The file grows, but by an unrelated turn.
      fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'unrelated turn' } }) + '\n')
    } else if (kind === 'decoy') {
      // The marker is there, but only as the assistant talking about it and as tool output.
      // Raw byte matching said "delivered" here (Codex review, seq 21, P1).
      fs.appendFileSync(file, JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 're: ' + args.join(' ') }] },
      }) + '\n')
      fs.appendFileSync(file, JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', output: args.join(' ') },
      }) + '\n')
    } else if (kind === 'tall') {
      // One legal user record that is itself larger than a read window, preceded by another big
      // line: the target line straddles the chunk boundary (Codex review, seq 23, P2).
      fs.appendFileSync(file, JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(2 * 1024 * 1024) }] },
      }) + '\n')
      fs.appendFileSync(file, JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: args.join(' ') + ' ' + 'b'.repeat(3 * 1024 * 1024) }] },
      }) + '\n')
    } else if (kind === 'flood') {
      // More than one 4MiB read window of unrelated output before the real input: a fixed
      // window re-reads the same bytes forever (Codex review, seq 21, P2).
      const filler = JSON.stringify({ type: 'event_msg', payload: { type: 'exec_output', text: 'x'.repeat(900) } }) + '\n'
      let written = 0
      while (written < 9 * 1024 * 1024) { fs.appendFileSync(file, filler); written += filler.length }
    }
    if (kind !== 'noise' && kind !== 'decoy' && kind !== 'tall') fs.appendFileSync(file, userLine)
  }
}
if (mode === 'exec') {
  // All exec callers send the prompt via stdin; consume it before producing events.
  let input = ''
  for await (const chunk of process.stdin) input += chunk.toString('utf8')
  if (process.env.STUB_TURN_MODE === 'split' && !input.includes('[bridge seq ')) process.exit(7)
  if (process.env.STUB_TURN_MODE === 'no-evidence') process.exit(3)
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'stub-thread-1' }))
  const started = JSON.stringify({ type: 'turn.started' }) + '\n'
  if (process.env.STUB_TURN_MODE === 'split') {
    process.stdout.write(started.slice(0, 8))
    await new Promise(r => setTimeout(r, 100))
    process.stdout.write(started.slice(8))
  } else console.log(started.trim())
  console.log(started.trim()) // repeated start evidence must not create another running write
  if (['delayed', 'split'].includes(process.env.STUB_TURN_MODE)) await new Promise(r => setTimeout(r, 1500))
  if (process.env.STUB_TURN_MODE === 'timeout') await new Promise(r => setTimeout(r, 10000))
  // Transport retry errors must not be mistaken for terminal failure.
  console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5' }))
  console.log(JSON.stringify({ type: 'item.completed', text: 'stub done' }))
  if (process.env.STUB_TURN_MODE === 'exit3') process.exit(3)
  if (process.env.STUB_TURN_MODE !== 'missing') {
    const ended = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
    if (process.env.STUB_TURN_MODE === 'no-newline') process.stdout.write(ended)
    else console.log(ended)
  }
}
process.exit(0)
