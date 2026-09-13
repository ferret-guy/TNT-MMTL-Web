import { FineProgressTracker } from './fineProgress.ts';
self.onmessage = async ({ data }) => {
  const start = performance.now();
  const tracker = new FineProgressTracker();
  try {
    const { default: create } = await import(/* @vite-ignore */ data.moduleUrl);
    const wasmUrl = new URL('bem.wasm', data.moduleUrl);
    wasmUrl.search = new URL(data.moduleUrl).search;
    const mod = await create({ locateFile: (file: string, prefix: string) =>
      file.endsWith('.wasm') ? wasmUrl.href : prefix + file,
    print: (line: string) => {
      const progress = tracker.feed(line);
      if (progress) self.postMessage({ progress, ms: performance.now() - start });
    }, printErr: () => {} });
    mod.FS.mkdir('/work'); mod.FS.chdir('/work');
    mod.FS.writeFile('/work/case.xsctn', data.xsctn);
    mod.callMain(['/work/case', '400', '400']);
    self.postMessage({ done: true, ms: performance.now() - start,
      resultText: mod.FS.readFile('/work/case.result', { encoding: 'utf8' }) });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
