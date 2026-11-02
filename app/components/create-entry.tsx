import { useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from './common';
import { errorMessage } from './api';

export function CreateEntry({ mode, open, onOpenChange, onCreate }: {
  mode: 'topic' | 'poll';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: unknown) => Promise<void>;
}): ReactNode {
  const [kind, setKind] = useState<'choice' | 'binary'>('choice');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: unknown = mode === 'topic'
      ? { action: 'create', kind: 'topic', title: String(form.get('title') || ''), body: String(form.get('body') || ''), category: String(form.get('category') || '') }
      : { action: 'create', kind, title: String(form.get('title') || ''), options: kind === 'binary' ? ['Yes', 'No'] : String(form.get('options') || '').split('\n').map((option: string) => option.trim()).filter(Boolean), duration: Number(form.get('duration')) };
    setPending(true);
    setError('');
    try { await onCreate(body); onOpenChange(false); }
    catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <Modal open={open} onOpenChange={(next: boolean) => { if (!pending) { setError(''); onOpenChange(next); } }} title={mode === 'topic' ? 'Suggest a topic' : 'Create a poll'} description={mode === 'topic' ? 'What would make a great conversation?' : 'Ask your community. You control when voting ends.'}>
    <form onSubmit={(event: FormEvent<HTMLFormElement>) => { void submit(event); }}>
      <label>{mode === 'topic' ? 'Title' : 'Question'}<input name="title" required maxLength={mode === 'topic' ? 100 : 160} /></label>
      {mode === 'topic' ? <>
        <label>Details<textarea name="body" required maxLength={2000} rows={5} /></label>
        <label>Category<select name="category"><option>Tech &amp; setups</option><option>Gaming</option><option>Creative</option><option>Just chatting</option></select></label>
      </> : <>
        <fieldset className="poll-types"><legend>Poll type</legend><label><input type="radio" name="kind" value="choice" checked={kind === 'choice'} onChange={() => setKind('choice')} />Multiple choice</label><label><input type="radio" name="kind" value="binary" checked={kind === 'binary'} onChange={() => setKind('binary')} />Yes / No</label></fieldset>
        {kind === 'choice' ? <label>Options, one per line<textarea name="options" rows={4} required maxLength={486} aria-describedby="options-help" /><small id="options-help">2 to 6 distinct options. Up to 80 characters each.</small></label> : <p className="muted">Yes / No results stay private until you reveal them.</p>}
        <label>Voting time<select name="duration" defaultValue="60"><option value="0">Unlimited — until I end it</option><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option><option value="600">10 minutes</option></select></label>
      </>}
      <p className="form-error" role="alert">{error}</p>
      <button className="gold" type="submit" disabled={pending}>{pending ? 'Saving…' : mode === 'topic' ? 'Submit topic' : 'Start poll'}</button>
    </form>
  </Modal>;
}
