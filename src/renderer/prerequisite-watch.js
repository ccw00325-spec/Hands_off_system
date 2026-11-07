// External browsers/installers do not expose a trustworthy progress percentage.
// Poll the host's executable checks, never infer installation from a web visit.
export function createPrerequisiteWatch({ scan, render, becameReady, failed, visible, interval = 3000, schedule = setTimeout, cancel = clearTimeout }) {
  let report, timer, flight, generation = 0, opened = false;
  const intents = new Map();
  const tools = () => (report?.rows ?? []).filter(row => row.state !== 'ready' && (row.required || row.state === 'installing' || intents.has(row.id))).map(row => row.id);
  const paint = checking => render(report, { intents, checking });
  function later(delay = interval) {
    cancel(timer); timer = null;
    if (opened && visible() && tools().length) timer = schedule(() => { void check(); }, delay);
  }
  async function check() {
    if (!opened || !visible()) return;
    if (flight) return flight;
    cancel(timer); timer = null;
    const ticket = generation;
    paint(true);
    flight = (async () => {
      try {
        const next = await scan(tools());
        if (!opened || ticket !== generation || !visible()) return;
        const before = new Map((report?.rows ?? []).map(row => [row.id, row.state]));
        report = next;
        const ready = next.rows.filter(row => row.state === 'ready' && before.get(row.id) !== 'ready');
        for (const row of ready) intents.delete(row.id);
        paint(false);
        if (ready.length) await becameReady?.(ready);
      } catch (error) {
        if (opened && ticket === generation && visible()) { paint(false); failed?.(error); }
      } finally { flight = null; later(); }
    })();
    return flight;
  }
  return {
    open(next) { report = next; for (const row of next.rows) if (row.state === 'ready') intents.delete(row.id); opened = true; generation++; paint(false); later(); },
    async installing(id, open) {
      intents.set(id, 'opening'); paint(false);
      try { await open(); intents.set(id, 'waiting'); }
      catch (error) { intents.delete(id); throw error; }
      finally { if (opened && visible()) { paint(false); later(0); } }
    },
    check,
    close() { opened = false; generation++; cancel(timer); timer = null; },
  };
}
