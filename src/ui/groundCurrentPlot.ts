import type {
  GroundCurrentDistribution,
  GroundCurrentSurfaceElementTrace,
} from '../analysis/groundCurrent.ts';
import type { Geometry, Viewport } from './crossSection.ts';
import { formatDim, type DimUnit } from './dimField.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const METERS_PER_MIL = 25.4e-6;
const GROUND_CURRENT_CLEARANCE_PX = 4;
const GROUND_CURRENT_SURFACE_GAP_FRACTION = 0.72;
const GROUND_CURRENT_FACE_COSINE_LIMIT = 0.98;

export interface GroundCurrentOverlayOptions {
  distribution: GroundCurrentDistribution | null;
  unavailableMessage?: string;
  /** Hide the unavailable-state label while a solve progress overlay is active. */
  suppressUnavailableMessage?: boolean;
  /** Meters per cross-section model unit. */
  modelUnitScaleM: number;
  displayUnit: DimUnit;
}

export function groundCurrentUnavailableLabel(
  options: Pick<
    GroundCurrentOverlayOptions,
    'unavailableMessage' | 'suppressUnavailableMessage'
  >,
): string | null {
  if (options.suppressUnavailableMessage) return null;
  return options.unavailableMessage ??
    'Ground-current distribution is unavailable for this geometry.';
}

interface GroundCurrentInteractiveSvg extends SVGSVGElement {
  groundCurrentHoverController?: AbortController;
}

export function clearGroundCurrentHoverInteraction(
  svg: SVGSVGElement,
): void {
  const interactiveSvg = svg as GroundCurrentInteractiveSvg;
  interactiveSvg.groundCurrentHoverController?.abort();
  delete interactiveSvg.groundCurrentHoverController;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, String(value));
  }
  return element;
}

function appendText(
  parent: SVGElement,
  x: number,
  y: number,
  text: string,
  className: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
): SVGTextElement {
  const element = svgElement('text', {
    x,
    y,
    class: className,
    'text-anchor': anchor,
  });
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export function groundCurrentAlignmentOffsetModelUnits(
  geometry: Geometry,
  distribution: GroundCurrentDistribution,
  modelUnitScaleM: number,
): number | null {
  if (!(modelUnitScaleM > 0)) return null;
  const allConductors = geometry.polys
    .filter(
      (poly) =>
        poly.kind === 'conductor' &&
        !poly.isGroundConductor &&
        poly.signalIndex != null,
    )
    .sort((left, right) => left.signalIndex! - right.signalIndex!);

  // Most guided views have one displayed signal band per drawn signal and
  // retain their positional ordering. A floating pair is different: the
  // electrical reduction publishes one differential loop, while the editor
  // still draws both user conductors as signals. In that case, bind the one
  // driven band by its stable solver name and leave the other member to the
  // explicit return-surface trace.
  const conductorByName = new Map(
    allConductors.flatMap((conductor) => {
      const name = geometry.signalNames[conductor.signalIndex!];
      return name ? [[name, conductor] as const] : [];
    }),
  );
  const namedConductors = distribution.signals.map(
    (signal) => conductorByName.get(signal.label),
  );
  const hasCompleteUniqueNameMatch =
    namedConductors.every((conductor) => conductor != null) &&
    new Set(namedConductors).size === namedConductors.length;
  const conductors = hasCompleteUniqueNameMatch
    ? namedConductors as typeof allConductors
    : allConductors.length === distribution.signals.length
      ? allConductors
      : null;
  if (!conductors || conductors.length === 0) {
    return null;
  }
  const offsets = conductors.map((conductor, index) => {
    const conductorCenter =
      (conductor.x0 + conductor.x1) / 2;
    const distributionCenter =
      distribution.signals[index].centerM / modelUnitScaleM;
    return conductorCenter - distributionCenter;
  });
  const mean =
    offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length;
  const scale = Math.max(
    1,
    Math.abs(mean),
    ...conductors.flatMap((conductor) => [
      Math.abs(conductor.x0),
      Math.abs(conductor.x1),
    ]),
  );
  if (offsets.some((offset) => Math.abs(offset - mean) > scale * 1e-9)) {
    return null;
  }
  return mean;
}

export function groundCurrentXModelUnits(
  xM: number,
  alignmentOffsetModelUnits: number,
  modelUnitScaleM: number,
): number {
  return xM / modelUnitScaleM + alignmentOffsetModelUnits;
}

export function groundCurrentMagnitudePercent(
  density: number,
  globalPeak: number,
): number {
  return globalPeak > 0
    ? (100 * Math.abs(density)) / globalPeak
    : 0;
}

export function formatGroundCurrentPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  const percent = Math.min(100, Math.abs(value));
  if (percent === 0) return '0%';
  if (percent < 0.01) return '<0.01%';

  const initialDecimals = percent >= 10 ? 0 : percent >= 1 ? 1 : 2;
  const rounded = Number(percent.toFixed(initialDecimals));
  if (rounded >= 10) return `${rounded.toFixed(0)}%`;
  if (rounded >= 1) return `${rounded.toFixed(1)}%`;
  return `${rounded.toFixed(2)}%`;
}

export function groundCurrentSharedAmplitudePixels(
  availableGaps: number[],
): number {
  const positiveGaps = availableGaps.filter(
    (gap) => Number.isFinite(gap) && gap > 0,
  );
  if (positiveGaps.length === 0) return 0;
  const minimumGap = Math.min(...positiveGaps);
  return Math.max(
    0,
    Math.min(
      minimumGap * 0.9,
      minimumGap - GROUND_CURRENT_CLEARANCE_PX,
    ),
  );
}

export function groundCurrentInterpolatedPercent(
  x: number,
  sampleX: readonly number[],
  samplePercent: readonly number[],
): number | null {
  if (
    !Number.isFinite(x) ||
    sampleX.length === 0 ||
    sampleX.length !== samplePercent.length
  ) {
    return null;
  }
  const lastIndex = sampleX.length - 1;
  const firstX = sampleX[0];
  const lastX = sampleX[lastIndex];
  if (
    !Number.isFinite(firstX) ||
    !Number.isFinite(lastX) ||
    x < firstX ||
    x > lastX
  ) {
    return null;
  }
  if (x === lastX) {
    const value = samplePercent[lastIndex];
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : null;
  }

  let low = 0;
  let high = lastIndex;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (sampleX[middle] <= x) low = middle;
    else high = middle;
  }
  const x0 = sampleX[low];
  const x1 = sampleX[high];
  const y0 = samplePercent[low];
  const y1 = samplePercent[high];
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(y1) ||
    !(x1 > x0)
  ) {
    return null;
  }
  const value = y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  return Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

function setSvgDescription(
  svg: SVGSVGElement,
  title: string,
  description: string,
): void {
  const titleElement = svg.querySelector<SVGTitleElement>('#cs-svg-title');
  const descriptionElement =
    svg.querySelector<SVGDescElement>('#cs-svg-description');
  if (titleElement) titleElement.textContent = title;
  if (descriptionElement) descriptionElement.textContent = description;
}

function planeSurfaceAndDirection(
  geometry: Geometry,
  viewport: Viewport,
  plane: 'bottom' | 'top',
): {
  baseline: number;
  inwardDirection: -1 | 1;
  availableGapPixels: number;
} | null {
  const grounds = geometry.polys
    .filter((poly) => poly.kind === 'ground')
    .sort((left, right) => left.y0 - right.y0);
  const signals = geometry.polys.filter(
    (poly) => poly.kind === 'conductor' && !poly.isGroundConductor,
  );
  if (grounds.length === 0 || signals.length === 0) return null;

  if (plane === 'bottom') {
    const surfaceY = grounds[0].y1;
    const nearestSignalY = Math.min(...signals.map((signal) => signal.y0));
    const baseline = viewport.sy(surfaceY);
    const gapPixels = baseline - viewport.sy(nearestSignalY);
    return {
      baseline,
      inwardDirection: -1,
      availableGapPixels: gapPixels,
    };
  }

  if (grounds.length < 2) return null;
  const surfaceY = grounds[grounds.length - 1].y0;
  const nearestSignalY = Math.max(...signals.map((signal) => signal.y1));
  const baseline = viewport.sy(surfaceY);
  const gapPixels = viewport.sy(nearestSignalY) - baseline;
  return {
    baseline,
    inwardDirection: 1,
    availableGapPixels: gapPixels,
  };
}

type PlanePlacement = NonNullable<
  ReturnType<typeof planeSurfaceAndDirection>
>;

interface RenderedGroundCurrentPlane {
  id: 'bottom' | 'top';
  label: string;
  placement: PlanePlacement;
  normalized: number[];
  seriesClass: 'cs-current-bottom' | 'cs-current-top';
}

interface RenderedGroundCurrentSurface {
  label: string;
  peakPercent: number;
}

interface SurfaceRenderPoint {
  baseX: number;
  baseY: number;
  curveX: number;
  curveY: number;
}

interface SurfaceBasePoint {
  baseX: number;
  baseY: number;
  normalX: number;
  normalY: number;
}

function pointSegmentDistancePixels(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator > 0
    ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / denominator))
    : 0;
  return Math.hypot(x - (x0 + fraction * dx), y - (y0 + fraction * dy));
}

function surfaceElementDirection(
  element: GroundCurrentSurfaceElementTrace,
): { x: number; y: number; span: number } | null {
  const first = element.samples[0];
  const last = element.samples.at(-1);
  if (!first || !last) return null;
  const dx = last.xM - first.xM;
  const dy = last.yM - first.yM;
  const span = Math.hypot(dx, dy);
  return span > 0
    ? { x: dx / span, y: dy / span, span }
    : null;
}

/**
 * Preserve solver contour order while separating sharp corners and physical
 * gaps. Display filtering must not blend current density across those joins.
 */
export function groundCurrentSurfaceFaceRuns(
  elements: readonly GroundCurrentSurfaceElementTrace[],
): GroundCurrentSurfaceElementTrace[][] {
  const runs: GroundCurrentSurfaceElementTrace[][] = [];
  let run: GroundCurrentSurfaceElementTrace[] = [];
  let previousElement: GroundCurrentSurfaceElementTrace | null = null;
  let previousDirection: ReturnType<typeof surfaceElementDirection> = null;

  for (const element of elements) {
    const direction = surfaceElementDirection(element);
    if (!direction) continue;
    let beginsNewRun = false;
    if (previousElement && previousDirection) {
      const previousLast = previousElement.samples.at(-1)!;
      const currentFirst = element.samples[0];
      const gap = Math.hypot(
        currentFirst.xM - previousLast.xM,
        currentFirst.yM - previousLast.yM,
      );
      const tangentCosine =
        previousDirection.x * direction.x +
        previousDirection.y * direction.y;
      beginsNewRun =
        tangentCosine < GROUND_CURRENT_FACE_COSINE_LIMIT ||
        gap > 3 * Math.max(previousDirection.span, direction.span);
    }
    if (beginsNewRun && run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(element);
    previousElement = element;
    previousDirection = direction;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function medianMagnitude(values: readonly number[]): number {
  const finite = values
    .filter(Number.isFinite)
    .map(Math.abs)
    .sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

/**
 * Collapse each element's singular quadrature samples to a robust median,
 * then apply a short triangular filter within one continuous contour face.
 */
export function groundCurrentSmoothedFaceMagnitudes(
  elements: readonly GroundCurrentSurfaceElementTrace[],
): number[] {
  const medians = elements.map((element) =>
    medianMagnitude(
      element.samples.map((sample) => sample.densityAPerM),
    )
  );
  if (medians.length < 2) return medians;
  return medians.map((value, index) => {
    const previous = medians[Math.max(0, index - 1)];
    const next = medians[Math.min(medians.length - 1, index + 1)];
    return (previous + 2 * value + next) / 4;
  });
}

/** One post-filter peak shared by every trace in the visualization. */
export function groundCurrentDisplayPeak(
  distribution: GroundCurrentDistribution,
): number {
  let peak = 0;
  for (const plane of distribution.planes) {
    for (const density of plane.densityAPerM) {
      if (Number.isFinite(density)) peak = Math.max(peak, Math.abs(density));
    }
  }
  for (const surface of distribution.surfaces ?? []) {
    for (const face of groundCurrentSurfaceFaceRuns(surface.elements)) {
      for (const magnitude of groundCurrentSmoothedFaceMagnitudes(face)) {
        peak = Math.max(peak, magnitude);
      }
    }
  }
  return peak;
}

function pointerInSvg(
  svg: SVGSVGElement,
  event: MouseEvent | PointerEvent,
): { x: number; y: number } | null {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  try {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return Number.isFinite(transformed.x) && Number.isFinite(transformed.y)
      ? { x: transformed.x, y: transformed.y }
      : null;
  } catch {
    return null;
  }
}

function dielectricMessagePosition(
  geometry: Geometry,
  viewport: Viewport,
): { x: number; y: number } {
  const visibleLayers = geometry.polys
    .filter((poly) => poly.kind === 'layer')
    .map((poly) => {
      const x0 = Math.max(poly.x0, viewport.vx0);
      const x1 = Math.min(poly.x1, viewport.vx1);
      const y0 = Math.max(poly.y0, viewport.vy0);
      const y1 = Math.min(poly.y1, viewport.vy1);
      return {
        poly,
        visibleArea: Math.max(0, x1 - x0) * Math.max(0, y1 - y0),
      };
    })
    .filter(({ visibleArea }) => visibleArea > 0);
  const mainLayer = visibleLayers.reduce<
    (typeof visibleLayers)[number] | undefined
  >(
    (largest, layer) =>
      !largest || layer.visibleArea > largest.visibleArea ? layer : largest,
    undefined,
  )?.poly;

  return mainLayer
    ? {
      x: viewport.W / 2,
      y: viewport.sy((mainLayer.y0 + mainLayer.y1) / 2),
    }
    : { x: viewport.W / 2, y: viewport.H / 2 };
}

/**
 * Draw normalized current magnitude directly from each reference-plane
 * surface. The current and geometry both use viewport.sx(), so there is no
 * independent chart scale or horizontal stretching.
 */
export function renderGroundCurrentOverlay(
  svg: SVGSVGElement,
  geometry: Geometry,
  viewport: Viewport,
  options: GroundCurrentOverlayOptions,
): number {
  const { H, vx0, vx1, sx } = viewport;
  const group = svgElement('g', {
    class: 'cs-current-overlay',
    role: 'group',
    'aria-label': 'Ground return-current density as percent of peak',
  });
  svg.appendChild(group);

  if (!options.distribution) {
    const message = groundCurrentUnavailableLabel(options);
    if (message == null) {
      setSvgDescription(
        svg,
        'Stackup cross-section',
        'The dielectric is unfilled and the geometry uses a widened lateral view.',
      );
      return H;
    }
    const messagePosition = dielectricMessagePosition(geometry, viewport);
    appendText(
      group,
      messagePosition.x,
      messagePosition.y,
      message,
      'cs-current-message',
      'middle',
    );
    setSvgDescription(
      svg,
      'Stackup cross-section and ground return-current density',
      `The dielectric is unfilled and the geometry uses a widened lateral view. ${message}`,
    );
    return H;
  }

  const distribution = options.distribution;
  const origin = groundCurrentAlignmentOffsetModelUnits(
    geometry,
    distribution,
    options.modelUnitScaleM,
  );
  if (origin == null) {
    const messagePosition = dielectricMessagePosition(geometry, viewport);
    const message =
      'Ground-current distribution could not be aligned to this geometry.';
    appendText(
      group,
      messagePosition.x,
      messagePosition.y,
      message,
      'cs-current-message',
      'middle',
    );
    setSvgDescription(
      svg,
      'Stackup cross-section and ground return-current density',
      `${message} No potentially misleading current curve is shown.`,
    );
    return H;
  }

  const xModel = distribution.xM.map((value) =>
    groundCurrentXModelUnits(
      value,
      origin,
      options.modelUnitScaleM,
    ));
  const xPixels = xModel.map(sx);
  const drivenCurrentMagnitude = distribution.signals.reduce(
    (sum, signal) => sum + Math.abs(signal.currentA),
    0,
  );
  const centerlineModelUnits = distribution.signals.reduce(
    (sum, signal) => {
      const weight = drivenCurrentMagnitude > 0
        ? Math.abs(signal.currentA)
        : 1;
      return sum + weight * groundCurrentXModelUnits(
        signal.centerM,
        origin,
        options.modelUnitScaleM,
      );
    },
    0,
  ) / (drivenCurrentMagnitude || distribution.signals.length || 1);
  const globalPeak = groundCurrentDisplayPeak(distribution);
  const denominator = globalPeak > 0 ? globalPeak : 1;

  const defs = svg.querySelector('defs') ?? svgElement('defs');
  if (!defs.parentElement) svg.prepend(defs);
  const clip = svgElement('clipPath', { id: 'cs-current-clip' });
  clip.appendChild(svgElement('rect', {
    x: sx(vx0),
    y: 0,
    width: sx(vx1) - sx(vx0),
    height: H,
  }));
  defs.appendChild(clip);

  const placements = distribution.planes.map((plane) =>
    planeSurfaceAndDirection(geometry, viewport, plane.id));
  const availableGaps = placements
    .filter((placement) => placement != null)
    .map((placement) => placement.availableGapPixels);
  const commonAmplitude =
    groundCurrentSharedAmplitudePixels(availableGaps);
  const renderedPlanes: RenderedGroundCurrentPlane[] = [];
  const renderedSurfaces: RenderedGroundCurrentSurface[] = [];

  for (const [planeIndex, plane] of distribution.planes.entries()) {
    const placement = placements[planeIndex];
    if (!placement) continue;
    const normalized = plane.densityAPerM.map(
      (value) => groundCurrentMagnitudePercent(value, denominator),
    );
    const yPoints = normalized.map(
      (percent) =>
        placement.baseline +
        placement.inwardDirection *
          commonAmplitude *
          (percent / 100),
    );
    const lineData = xPixels
      .map((x, index) => {
        const command = index === 0 ? 'M' : 'L';
        return `${command}${x.toFixed(2)},${yPoints[index].toFixed(2)}`;
      })
      .join(' ');
    const areaData =
      `M${xPixels[0].toFixed(2)},${placement.baseline.toFixed(2)} ` +
      lineData.replace(/^M/, 'L') +
      ` L${xPixels[xPixels.length - 1].toFixed(2)},${placement.baseline.toFixed(2)} Z`;
    const seriesClass =
      plane.id === 'bottom'
        ? 'cs-current-bottom'
        : 'cs-current-top';
    group.appendChild(svgElement('path', {
      d: areaData,
      class: `cs-current-area ${seriesClass}`,
      'clip-path': 'url(#cs-current-clip)',
    }));
    const line = svgElement('path', {
      d: lineData,
      class: `cs-current-line ${seriesClass}`,
      'clip-path': 'url(#cs-current-clip)',
    });
    const title = svgElement('title');
    title.textContent =
      `${plane.label} return-current magnitude, normalized to the global peak`;
    line.appendChild(title);
    group.appendChild(line);
    renderedPlanes.push({
      id: plane.id,
      label: plane.label,
      placement,
      normalized,
      seriesClass,
    });
  }

  // Explicit grounds are present in the BEM mesh, unlike the implicit lower
  // image plane. Draw the solved density as a ribbon displaced along each
  // conductor surface's outward normal. This retains the actual conductor
  // contour for CPW and arbitrary free-form geometry.
  const xPixelsPerModelUnit =
    (sx(vx1) - sx(vx0)) / Math.max(Number.EPSILON, vx1 - vx0);
  const yPixelsPerModelUnit =
    (viewport.sy(viewport.vy1) - viewport.sy(viewport.vy0)) /
    Math.max(Number.EPSILON, viewport.vy1 - viewport.vy0);
  const maximumSurfaceAmplitude = Math.max(12, Math.min(28, H * 0.1));
  const signalPolygonsPixels = geometry.polys
    .filter((poly) => poly.kind === 'conductor' && !poly.isGroundConductor)
    .map((poly) => poly.pts.map(([x, y]) => ({ x: sx(x), y: viewport.sy(y) })));
  let minimumSignalClearance = Number.POSITIVE_INFINITY;
  for (const surface of distribution.surfaces ?? []) {
    for (const element of surface.elements) {
      for (const sample of element.samples) {
        const x = sx(groundCurrentXModelUnits(
          sample.xM,
          origin,
          options.modelUnitScaleM,
        ));
        const y = viewport.sy(sample.yM / options.modelUnitScaleM);
        for (const polygon of signalPolygonsPixels) {
          for (let index = 0; index < polygon.length; index++) {
            const start = polygon[index];
            const end = polygon[(index + 1) % polygon.length];
            minimumSignalClearance = Math.min(
              minimumSignalClearance,
              pointSegmentDistancePixels(
                x,
                y,
                start.x,
                start.y,
                end.x,
                end.y,
              ),
            );
          }
        }
      }
    }
  }
  const surfaceAmplitude = Number.isFinite(minimumSignalClearance)
    ? Math.max(
      0,
      Math.min(
        maximumSurfaceAmplitude,
        minimumSignalClearance * GROUND_CURRENT_SURFACE_GAP_FRACTION,
      ),
    )
    : maximumSurfaceAmplitude;
  const surfaceBasePoint = (
    sample: GroundCurrentSurfaceElementTrace['samples'][number],
  ): SurfaceBasePoint => {
    const modelX = groundCurrentXModelUnits(
      sample.xM,
      origin,
      options.modelUnitScaleM,
    );
    const screenNormalX = sample.nx * xPixelsPerModelUnit;
    const screenNormalY = sample.ny * yPixelsPerModelUnit;
    const screenNormalLength = Math.hypot(
      screenNormalX,
      screenNormalY,
    ) || 1;
    return {
      baseX: sx(modelX),
      baseY: viewport.sy(sample.yM / options.modelUnitScaleM),
      normalX: screenNormalX / screenNormalLength,
      normalY: screenNormalY / screenNormalLength,
    };
  };
  for (const surface of distribution.surfaces ?? []) {
    const surfaceGroup = svgElement('g', {
      class: 'cs-current-surface',
      role: 'group',
      'aria-label': `${surface.label} return-current magnitude`,
    });
    let surfacePeak = 0;
    const areaSubpaths: string[] = [];
    const lineSubpaths: string[] = [];
    for (const face of groundCurrentSurfaceFaceRuns(surface.elements)) {
      const magnitudes = groundCurrentSmoothedFaceMagnitudes(face);
      const renderPoint = (
        point: SurfaceBasePoint,
        magnitude: number,
      ): SurfaceRenderPoint => {
        const percent = groundCurrentMagnitudePercent(
          magnitude,
          denominator,
        );
        surfacePeak = Math.max(surfacePeak, percent);
        const offset = surfaceAmplitude * percent / 100;
        return {
          baseX: point.baseX,
          baseY: point.baseY,
          curveX: point.baseX + offset * point.normalX,
          curveY: point.baseY + offset * point.normalY,
        };
      };
      const points = face.flatMap((element, elementIndex) =>
        element.samples.map((sample) =>
          renderPoint(
            surfaceBasePoint(sample),
            magnitudes[elementIndex],
          )
        )
      );
      const curve = points.map((point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.curveX.toFixed(2)},${point.curveY.toFixed(2)}`
      ).join(' ');
      const reversedBaseline = [...points].reverse().map((point) =>
        `L${point.baseX.toFixed(2)},${point.baseY.toFixed(2)}`
      ).join(' ');
      areaSubpaths.push(`${curve} ${reversedBaseline} Z`);
      lineSubpaths.push(curve);
    }
    if (areaSubpaths.length > 0) {
      // The physical samples remain untouched. For display only, collapse the
      // eight singular quadrature samples per element to their median and use
      // a short face-local filter. Separate subpaths prevent corner bridges.
      surfaceGroup.appendChild(svgElement('path', {
        d: areaSubpaths.join(' '),
        class: 'cs-current-surface-area',
        'clip-path': 'url(#cs-current-clip)',
      }));
      surfaceGroup.appendChild(svgElement('path', {
        d: lineSubpaths.join(' '),
        class: 'cs-current-surface-line',
        'clip-path': 'url(#cs-current-clip)',
      }));
    }
    group.appendChild(surfaceGroup);
    renderedSurfaces.push({
      label: surface.label,
      peakPercent: surfacePeak,
    });
  }

  const plotX0 = sx(vx0);
  const plotX1 = sx(vx1);
  if (
    commonAmplitude > 0 &&
    xPixels.length > 1 &&
    renderedPlanes.length > 0
  ) {
    const hoverGroup = svgElement('g', {
      class: 'cs-current-hover',
      'aria-hidden': 'true',
      visibility: 'hidden',
    });
    const hoverGuide = svgElement('line', {
      class: 'cs-current-hover-guide',
    });
    const hoverMarker = svgElement('circle', {
      r: 3,
      class: 'cs-current-hover-marker',
    });
    const hoverLabel = svgElement('text', {
      class: 'cs-current-hover-label',
      'text-anchor': 'middle',
    });
    hoverGroup.append(hoverGuide, hoverMarker, hoverLabel);

    const hideHover = () => {
      hoverGroup.setAttribute('visibility', 'hidden');
    };
    const hoverController = new AbortController();
    (svg as GroundCurrentInteractiveSvg).groundCurrentHoverController =
      hoverController;
    const hideOutsideCurrentHit = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.classList.contains('cs-current-hit')
      ) {
        hideHover();
      }
    };
    document.addEventListener(
      'pointermove',
      hideOutsideCurrentHit,
      { passive: true, signal: hoverController.signal },
    );
    document.addEventListener(
      'mousemove',
      hideOutsideCurrentHit,
      { passive: true, signal: hoverController.signal },
    );
    window.addEventListener(
      'blur',
      hideHover,
      { signal: hoverController.signal },
    );
    const sampledX0 = Math.max(plotX0, xPixels[0]);
    const sampledX1 = Math.min(plotX1, xPixels[xPixels.length - 1]);
    const multiplePlanes = renderedPlanes.length > 1;

    for (const rendered of renderedPlanes) {
      const { placement, normalized, seriesClass } = rendered;
      const profileEnd =
        placement.baseline +
        placement.inwardDirection * commonAmplitude;
      const hitY = Math.min(placement.baseline, profileEnd);
      const hit = svgElement('rect', {
        x: sampledX0,
        y: hitY,
        width: Math.max(0, sampledX1 - sampledX0),
        height: commonAmplitude,
        class: 'cs-current-hit',
        'aria-hidden': 'true',
      });
      const updateHover = (event: MouseEvent | PointerEvent) => {
        const point = pointerInSvg(svg, event);
        if (!point) {
          hideHover();
          return;
        }
        const percent = groundCurrentInterpolatedPercent(
          point.x,
          xPixels,
          normalized,
        );
        if (percent == null) {
          hideHover();
          return;
        }
        const curveY =
          placement.baseline +
          placement.inwardDirection *
            commonAmplitude *
            (percent / 100);
        const lineStart = sampledX0;
        const lineEnd = Math.max(
          sampledX0,
          Math.min(sampledX1, point.x),
        );
        if (lineEnd - lineStart < 8) {
          hideHover();
          return;
        }
        const planeName =
          rendered.id === 'bottom' ? 'Bottom' : 'Top';
        const pointerModelUnits =
          vx0 +
          ((point.x - plotX0) / (plotX1 - plotX0)) *
            (vx1 - vx0);
        const distanceM =
          Math.abs(pointerModelUnits - centerlineModelUnits) *
          options.modelUnitScaleM;
        const distanceText = formatDim(
          distanceM / METERS_PER_MIL,
          options.displayUnit,
        );
        const unitLabel =
          options.displayUnit === 'inch'
            ? 'in'
            : options.displayUnit;
        const labelText =
          (multiplePlanes ? `${planeName} ` : '') +
          `${formatGroundCurrentPercent(percent)} at ${distanceText} ${unitLabel}`;
        const estimatedLabelWidth = labelText.length * 6.5;
        const labelX = Math.max(
          plotX0 + estimatedLabelWidth / 2 + 4,
          Math.min(
            plotX1 - estimatedLabelWidth / 2 - 4,
            lineEnd,
          ),
        );
        const labelY =
          curveY +
          (placement.inwardDirection === -1 ? -6 : 13);

        hoverGuide.setAttribute('x1', String(lineStart));
        hoverGuide.setAttribute('y1', String(curveY));
        hoverGuide.setAttribute('x2', String(lineEnd));
        hoverGuide.setAttribute('y2', String(curveY));
        hoverGuide.setAttribute(
          'class',
          `cs-current-hover-guide ${seriesClass}`,
        );
        hoverMarker.setAttribute('cx', String(lineEnd));
        hoverMarker.setAttribute('cy', String(curveY));
        hoverMarker.setAttribute(
          'class',
          `cs-current-hover-marker ${seriesClass}`,
        );
        hoverLabel.setAttribute('x', String(labelX));
        hoverLabel.setAttribute('y', String(labelY));
        hoverLabel.textContent = labelText;
        hoverGroup.setAttribute('visibility', 'visible');
      };
      hit.addEventListener('pointerenter', updateHover);
      hit.addEventListener('pointermove', updateHover);
      hit.addEventListener('mouseenter', updateHover);
      hit.addEventListener('mousemove', updateHover);
      hit.addEventListener('pointerleave', hideHover);
      hit.addEventListener('pointerout', hideHover);
      hit.addEventListener('mouseout', hideHover);
      hit.addEventListener('pointercancel', hideHover);
      hit.addEventListener('pointerup', hideHover);
      group.appendChild(hit);
    }
    group.appendChild(hoverGroup);
  }

  const peakSummary = [
    ...distribution.planes.map((plane) => {
      const planePeak = Math.max(
        0,
        ...plane.densityAPerM.map((value) => Math.abs(value)),
      );
      return (
        `${plane.label} peak ` +
        `${formatGroundCurrentPercent(
          groundCurrentMagnitudePercent(planePeak, denominator),
        )}`
      );
    }),
    ...renderedSurfaces.map((surface) =>
      `${surface.label} peak ${formatGroundCurrentPercent(surface.peakPercent)}`
    ),
  ]
    .join('; ');
  setSvgDescription(
    svg,
    'Stackup cross-section with ground return-current density',
    `The dielectric is unfilled. Absolute current magnitude is drawn from each solved reference-conductor surface as percent of the global peak; current sign and direction are omitted. ${peakSummary}. A peak percentage is a density comparison, not that conductor's share of total return current. All values use one global percentage scale; ribbon height adapts to the available geometry clearance. Pointer hover on a reference plane shows the interpolated percent at the selected horizontal position. The lateral view is twice the normal width and uses the same physical scale for geometry and current.`,
  );
  return H;
}
