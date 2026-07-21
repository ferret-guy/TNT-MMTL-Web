import 'bootstrap/dist/css/bootstrap.min.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './style.css';
import {
  FREEFORM_EXAMPLES_BY_ID,
  type FreeformExampleId,
} from './model/freeformExamples.ts';
import { currentStackup } from './model/store.ts';
import { renderCrossSection } from './ui/crossSection.ts';

document
  .querySelectorAll<HTMLAnchorElement>('[data-freeform-example]')
  .forEach((link) => {
    const id = link.dataset.freeformExample as FreeformExampleId | undefined;
    if (id && FREEFORM_EXAMPLES_BY_ID[id]) {
      link.href = FREEFORM_EXAMPLES_BY_ID[id].href;
    }
  });

document
  .querySelectorAll<SVGSVGElement>('[data-freeform-preview]')
  .forEach((svg, index) => {
    const id = svg.dataset.freeformPreview as FreeformExampleId | undefined;
    const example = id ? FREEFORM_EXAMPLES_BY_ID[id] : undefined;
    if (!example) return;

    renderCrossSection(svg, currentStackup(example.state), {
      equalAxisScale: true,
      showSignalNames: true,
    });

    const title = svg.querySelector(':scope > title');
    const description = svg.querySelector(':scope > desc');
    const idStem = `about-${id}-${index}`;
    if (title) {
      title.id = `${idStem}-title`;
      title.textContent = `${example.title} geometry`;
    }
    if (description) {
      description.id = `${idStem}-description`;
      description.textContent = example.summary;
    }
    svg.setAttribute(
      'aria-labelledby',
      `${idStem}-title ${idStem}-description`,
    );
  });
