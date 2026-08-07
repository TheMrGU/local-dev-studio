// lib/checklists.js — the built-in review checklists.
//
// A checklist is a set of prompts the site-note panel offers as tickable
// rows; every ticked item is saved as an ordinary global note, so exports and
// the resolve loop treat them exactly like anything the reviewer typed by
// hand. Deliberately three lists and deliberately short — a checklist that
// scrolls is a checklist nobody finishes. (Pro may add custom ones later;
// these stay the floor, not the ceiling.)

const CHECKLISTS = [
  {
    id: 'a11y',
    name: 'Accessibility basics',
    items: [
      'Every image that carries meaning has alt text; decorative ones have empty alt.',
      'Text contrast holds up — body copy and buttons pass at least AA against their background.',
      'The whole page works with only a keyboard: focus is visible and nothing traps it.',
      'Headings are a real outline (one h1, no skipped levels), not styled divs.',
      'Form fields have labels — placeholder text alone is not a label.',
      'Links say where they go; no bare "click here" or icon-only links without a name.',
    ],
  },
  {
    id: 'responsive',
    name: 'Responsive pass',
    items: [
      'Nothing overflows or clips at 375px — no horizontal scrollbar anywhere.',
      'Tap targets are comfortable on touch: nothing important smaller than ~44px.',
      'The navigation collapses sensibly and can be opened, used and closed on mobile.',
      'Images scale down instead of forcing the layout wider.',
      'Type stays readable at every width — no lines longer than ~80 characters, none squeezed to fragments.',
      'The tablet width (768px) is a designed layout, not a stretched phone or a crushed desktop.',
    ],
  },
  {
    id: 'prelaunch',
    name: 'Pre-launch',
    items: [
      'The title tag and favicon are real — no "Untitled" or framework defaults.',
      'Every link goes somewhere: no dead ends, no href="#" left behind.',
      'Forms actually submit, and the failure state says something helpful.',
      'There is a designed 404 page.',
      'The console is clean on every page — no errors, no failing requests.',
      'Placeholder text is gone: no lorem ipsum, no TODO, no test content.',
    ],
  },
];

module.exports = { CHECKLISTS };
