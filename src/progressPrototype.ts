import { ProgressEta, formatEta } from './solver/progressEta.ts';
import { currentStackup, decodeHash, defaultState } from './model/store.ts';
import { generateXsctn } from './xsctn/generate.ts';
import { parseResult } from './solver/parseResult.mjs';
const hash = '#v=3&kind=microstrip&var=se&mat=jlc-np155f&w=5.93938&h=3.91339&cseg=400&dseg=400&refined_mesh=1&units=mm&f_hz=10000000000';
const stack = currentStackup({ ...defaultState(), ...decodeHash(hash) });
const start = document.querySelector<HTMLButtonElement>('#start')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const bar = document.querySelector<HTMLProgressElement>('#bar')!;
const phase = document.querySelector('#phase')!;
const elapsed = document.querySelector('#elapsed')!;
const metrics = document.querySelector('#metrics')!;
let worker: Worker | null = null;
let timer = 0;
let frame = 0;
function stop() { clearInterval(timer); cancelAnimationFrame(frame); worker?.terminate(); worker = null; start.disabled = false; cancel.disabled = true; }
cancel.onclick = () => { stop(); phase.textContent = 'Cancelled'; };
start.onclick = () => {
  stop(); start.disabled = true; cancel.disabled = false; bar.value = 0;
  phase.textContent = 'Preparing mesh'; metrics.textContent = '';
  const started = performance.now();
  const eta = new ProgressEta(started, 84);
  elapsed.textContent = `0 s elapsed · ${formatEta(eta.remainingSeconds(started))}`;
  let previous = 0, lastMs = 0, maxJump = 0, maxGap = 0, count = 0;
  let painted = 0, maxPaintJump = 0;
  const paint = () => {
    maxPaintJump = Math.max(maxPaintJump, bar.value - painted);
    painted = bar.value;
    frame = requestAnimationFrame(paint);
  };
  frame = requestAnimationFrame(paint);
  timer = window.setInterval(() => { elapsed.textContent = `${Math.floor((performance.now() - started) / 1000)} s elapsed · ${formatEta(eta.remainingSeconds(performance.now()))}`; }, 100);
  worker = new Worker(new URL('./solver/progressPrototypeWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.error) { phase.textContent = data.error; stop(); return; }
    if (data.progress) {
      const percent = 100 * data.progress.fraction;
      if (percent > previous) {
        maxJump = Math.max(maxJump, percent - previous);
        maxGap = Math.max(maxGap, data.ms - lastMs);
        previous = percent; lastMs = data.ms; count++;
      }
      bar.value = percent;
      eta.update(percent / 100, performance.now());
      phase.textContent = `${percent.toFixed(1)}% · ${data.progress.label}`;
      metrics.textContent = `${count} updates · largest jump ${maxJump.toFixed(3)} percentage points\nLargest animation-frame jump: ${maxPaintJump.toFixed(3)} percentage points\nLongest interval between advances: ${(maxGap / 1000).toFixed(2)} s`;
    }
    if (data.done) {
      phase.textContent = `Complete · ${parseResult(data.resultText).z0[0].toFixed(3)} Ω`;
      elapsed.textContent = `${Math.floor(data.ms / 1000)} s total`;
      maxPaintJump = Math.max(maxPaintJump, 100 - painted);
      metrics.textContent = `${count} updates · largest jump ${maxJump.toFixed(3)} percentage points\nLargest animation-frame jump: ${maxPaintJump.toFixed(3)} percentage points\nLongest interval between advances: ${(maxGap / 1000).toFixed(2)} s`;
      stop();
    }
  };
  worker.onerror = event => { phase.textContent = event.message; stop(); };
  worker.postMessage({ xsctn: generateXsctn(stack), moduleUrl: new URL(`/wasm/bem.mjs?prototype=${Date.now()}`, location.href).href });
};
