/**
 * Causal ETA from native work telemetry. Time inputs are seconds on a caller-owned clock.
 * Kernel rates are fitted offline; no geometry names or target solve durations enter
 * this model. Completed phases calibrate later work in the same run. A single
 * settling time controls how quickly a live phase replaces its fitted prior.
 * The sqrt(row-count) pseudo-sample weight prevents an expensive first row from
 * determining the rate of an entire matrix. Neither timer ticks nor future events
 * add completed work to the progress bar.
 */
export const DEFAULT_SETTLING_SECONDS = 0.1;

// Legacy arrays are accepted so historical recording models remain replayable.
function kernelRates(model, backend) {
    if (model.conductor == null) return model[backend] || model.serial;
    return {assembly:[model.conductor], dielectric:[model.conductor,model.dielectric],
        lu:[model.lu[backend] ?? model.lu.serial,0], solve:[0,model.overhead], setup:[model.overhead,0]};
}

export class WorkTracker {
    constructor(backend = 'serial', maxThreads = 4) {
        this.maxThreads = maxThreads;
        this.freeNodes = 0;
        this.backend = backend;
        this.c = 0;
        this.n = 0;
        this.nodes = 0;
        this.signals = 1;
        this.stage = 0;
        this.fraction = 0;
        this.phaseStart = 0;
        this.at = 0;
        this.boundaries = [0];
        this.threads = [null, null];
        this.completed = 0;
        this.total = 1;
    }
    feed(line, at) {
        if (!Number.isFinite(at) || at < this.at) return;
        this.at = at;
        let m;
        if ((m = line.match(/(\d+) elements and (\d+) nodes were generated/))) {
            this.n = +m[1];
            this.nodes = +m[2];
        }
        if ((m = line.match(/num_sig:\s*(\d+)/)))
            this.signals = +m[1];
        if (line.startsWith('MMTL_LU Eigen'))
            this.backend = 'eigen';
        if (line.includes('Calculate LHS'))
            this.enter(line.includes('dielectric') ? 4 : 1, at);
        if ((m = line.match(/^MMTL_PARALLEL (\d+)/)))
            this.threads[this.stage >= 4 ? 1 : 0] = +m[1];
        if ((m = line.match(/^MMTL_PROGRESS (assembly|factorization) (\d+) (\d+)/))) {
            if (+m[3] <= 0 || +m[2] > +m[3]) return;
            const stage = (this.stage >= 4 ? 4 : 1) + (m[1] === 'factorization' ? 1 : 0);
            // Small auxiliary matrices after RHS are not the main factorization.
            if (this.stage === 3 || this.stage === 6)
                return;
            this.enter(stage, at);
            this.completed = +m[2];
            this.total = +m[3];
            // The native pool threshold is 384 elements. A reported count above
            // that threshold also reveals a restricted/overridden pool capacity.
            if (m[1] === 'assembly' && this.total >= 384 && this.threads[stage >= 4 ? 1 : 0] != null)
                this.maxThreads = this.threads[stage >= 4 ? 1 : 0];
            if (stage === 1)
                this.c = this.total;
            if (stage === 2)
                this.freeNodes = this.total;
            this.fraction = this.completed / this.total;
        }
        if ((m = line.match(/calculate RHS .*conductor (\d+)/i))) {
            this.enter(this.stage >= 4 ? 6 : 3, at);
            this.fraction = (+m[1] - 1) / this.signals;
        }
        if (line.includes('MMTL is done')) {
            this.enter(6, at);
            this.fraction = 1;
        }
    }
    enter(stage, at) {
        if (stage === this.stage)
            return;
        this.stage = stage;
        this.fraction = 0;
        this.phaseStart = at;
        this.boundaries[stage] = at;
    }
    shape() {
        return { c: this.c, n: this.n, nodes: this.nodes, signals: this.signals, backend: this.backend, threads: this.threads };
    }
}
/** Phase costs: setup, free assembly/LU/RHS, dielectric assembly/LU/RHS.
 * c counts conductor elements, n all elements, nodes matrix unknowns, signals RHSs.
 * Dimensions are divided by 1000 solely to condition the offline regression.
 */
export function costs(shape, model, first = false) {
    const m = kernelRates(model, shape.backend);
    if (!m)
        return Array(7).fill(1);
    const c = shape.c / 1000, n = shape.n / 1000, nd = shape.nodes / 1000, ns = shape.signals;
    const threads = [shape.threads?.[0] ?? (shape.backend === 'eigen' && shape.c >= 384 ? (shape.maxThreads ?? 4) : 1), shape.threads?.[1] ?? (shape.backend === 'eigen' && shape.n >= 384 ? (shape.maxThreads ?? 4) : 1)];
    const cold = first ? (m.coldAssembly ?? 1) : 1;
    const lu = x => m.lu[0] * x ** 3 + m.lu[1] * x * x;
    const solve = x => m.solve[0] * x * x * ns + m.solve[1];
    return [m.setup[0] + (first ? m.setup[1] : 0), cold * m.assembly[0] * c * c / threads[0], lu((shape.freeNodes || 2 * shape.c) / 1000), solve((shape.freeNodes || 2 * shape.c) / 1000),
        cold * (n === c ? m.assembly[0] * n * n : m.dielectric[0] * c * n + m.dielectric[1] * (n - c) * n) / threads[1], lu(nd), solve(nd)];
}
export class SolveWorkEta {
    constructor(model, roles, initialSeconds = 1, settlingSeconds = DEFAULT_SETTLING_SECONDS) {
        this.model = model;
        this.roles = roles;
        this.initialSeconds = initialSeconds;
        this.settlingSeconds = settlingSeconds;
        this.index = -1;
        this.tracker = null;
        this.primary = null;
        this.scales = Array(7).fill(null);
        this.seen = new Set();
        this.start = 0;
        this.lastProgress = 0;
        this.remaining = initialSeconds;
        this.finishedSeconds = 0;
    }
    begin(index, at, backend) {
        this.index = index;
        this.start = at;
        this.tracker = new WorkTracker(backend);
        this.seen = new Set();
    }
    feed(line, at) {
        const t = this.tracker;
        if (!t)
            return;
        t.feed(line, at - this.start);
        this.observe();
    }
    apply(snapshot) {
        this.tracker = snapshot;
        this.observe();
    }
    observe() {
        const t = this.tracker;
        if (!t)
            return;
        if (t.c && this.index === 0)
            this.primary = { ...t, threads: undefined };
        const base = costs(t, this.model, this.index === 0);
        for (let stage = 0; stage < 7; stage++)
            if (t.boundaries[stage] != null && t.boundaries[stage + 1] != null && !this.seen.has(stage)) {
                const duration = t.boundaries[stage + 1] - t.boundaries[stage];
                if (base[stage] > 0 && duration > 0)
                    this.scales[stage] = duration / base[stage];
                this.seen.add(stage);
            }
    }
    fraction(t) {
        let f = t.fraction;
        if (t.stage === 2 || t.stage === 5)
            f = 1 - (1 - f) ** 3;
        if (t.stage === 4 && t.total > t.c) {
            const m = kernelRates(this.model, t.backend);
            const c = Math.min(t.c, t.total), k = t.completed;
            f = (m.dielectric[0] * Math.min(k, c) + m.dielectric[1] * Math.max(0, k - c)) / (m.dielectric[0] * c + m.dielectric[1] * (t.total - c));
        }
        return Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));
    }
    scale(stage, shape = this.tracker) {
        let source = stage;
        if (this.scales[stage] == null) {
            if (stage === 4)
                source = 1;
            if (stage === 5)
                source = 2;
            if (stage === 6)
                source = 3;
        }
        if (stage === 4 && shape?.n === shape?.c)
            source = 1;
        const prior = this.scales[source] ?? this.scales[1] ?? 1, t = this.tracker;
        if (t?.c && t.stage === stage && [1, 2, 4, 5].includes(stage)) {
            const f = this.fraction(t), elapsed = t.at - t.phaseStart, base = costs(t, this.model, this.index === 0)[stage];
            if (f > 0 && f < 1 && base > 0) {
                const trust = (1 - Math.exp(-elapsed / this.settlingSeconds)) * t.completed / (t.completed + Math.sqrt(t.total));
                return prior * (1 - trust) + (elapsed / f / base) * trust;
            }
        }
        return prior;
    }
    finish(at) {
        const t = this.tracker;
        if (t?.c) {
            const base = costs(t, this.model, this.index === 0);
            if (base[6] > 0)
                this.scales[6] = (at - this.start - t.phaseStart) / base[6];
        }
        this.finishedSeconds += at - this.start;
        this.tracker = null;
    }
    read(now) {
        if (!this.primary)
            return { remaining: Math.max(0, this.initialSeconds - now), progress: 0 };
        let remaining = this.model.overhead ?? this.model.post ?? 0;
        for (let i = this.index + 1; i < this.roles.length; i++) {
            const shape = { ...this.primary, threads: undefined };
            if (this.roles[i] === 'air') {
                shape.n = shape.c;
                shape.nodes = shape.freeNodes || 2 * shape.c;
            }
            remaining += costs(shape, this.model).reduce((s, c, j) => s + c * this.scale(j, shape), 0);
        }
        const t = this.tracker;
        if (t) {
            const expected = {...this.primary, threads: undefined};
            if (this.roles[this.index] === 'air') {
                expected.n = expected.c;
                expected.nodes = expected.freeNodes || 2 * expected.c;
            }
            const predicted = costs(t.c ? t : expected, this.model, this.index === 0).map((c, j) => c * this.scale(j, t.c ? t : expected));
            const f = this.fraction(t), projected = predicted[t.stage];
            remaining += Math.max(0, (1 - f) * projected - Math.max(0, now - this.start - t.at));
            const completed = this.finishedSeconds + t.phaseStart + f * projected;
            const future = remaining + predicted.slice(t.stage + 1).reduce((a, b) => a + b, 0);
            const marker = `${this.index}:${t.at}`;
            if (marker !== this.progressMarker) {
                this.lastProgress = Math.max(this.lastProgress, Math.min(.9999, completed / (completed + future)));
                this.progressMarker = marker;
            }
            for (let j = t.stage + 1; j < 7; j++)
                remaining += predicted[j];
        }
        this.remaining = Math.max(0, remaining);
        return { remaining: this.remaining, progress: this.lastProgress };
    }
}
