// @ts-check
import { icon, el, categoryIcons } from './app.js';
/** @param {string} name */
function showView(name) {
  for (const view of ['topics','polls','schedule','about','community']) el(`#${view}-view`).hidden = view !== name;
  for (const button of document.querySelectorAll('nav [data-view]')) {
    if (button.getAttribute('data-view') === name) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
  if (name === 'topics') document.body.classList.remove('show-detail');
  document.dispatchEvent(new CustomEvent('viewchange', { detail: name }));
}
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-view]') : null;
  if (target) showView(target.getAttribute('data-view') ?? 'topics');
});
el('#topic-form').addEventListener('submit', () => { showView('topics'); document.body.classList.add('show-detail'); });
const picker = /** @type {HTMLDetailsElement} */(el('#category-picker'));
const categoryOptions = el('#category-options');
categoryOptions.innerHTML = Object.entries(categoryIcons).map(([name, symbol], index) => `<label><input type="radio" name="category" value="${name}" ${index === 0 ? 'checked' : ''}>${icon(symbol)}<span>${name}</span></label>`).join('');
function updateCategory() {
  const selected = /** @type {HTMLInputElement} */(el('input[name="category"]:checked'));
  el('#category-selected').innerHTML = `${icon(categoryIcons[selected.value])}<span>${selected.value}</span>${icon('chevron')}`;
}
categoryOptions.addEventListener('change', () => { updateCategory(); picker.open = false; el('#category-selected').focus(); });
el('#topic-form').addEventListener('reset', () => queueMicrotask(updateCategory));
picker.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); picker.open = false; el('#category-selected').focus(); } });
updateCategory();
const splitter = el('#splitter'), main = el('#topics-view');
let split = 40;
/** @param {number} value */
function resize(value) {
  const width = main.clientWidth - 38;
  const min = Math.max(25, 290 / width * 100), max = Math.min(65, 100 - 380 / width * 100);
  split = Math.max(min, Math.min(max, value));
  main.style.setProperty('--split', `${split}%`);
  splitter.setAttribute('aria-valuenow', String(Math.round(split)));
  splitter.setAttribute('aria-valuemin', String(Math.round(min)));
  splitter.setAttribute('aria-valuemax', String(Math.round(max)));
}
splitter.addEventListener('pointerdown', (event) => { splitter.setPointerCapture(event.pointerId); document.body.classList.add('resizing'); });
splitter.addEventListener('pointermove', (event) => {
  if (!splitter.hasPointerCapture(event.pointerId)) return;
  const box = main.getBoundingClientRect(), style = getComputedStyle(main), left = parseFloat(style.paddingLeft), right = parseFloat(style.paddingRight);
  resize((event.clientX - box.left - left) / (box.width - left - right) * 100);
});
splitter.addEventListener('lostpointercapture', () => document.body.classList.remove('resizing'));
splitter.addEventListener('dblclick', () => resize(40));
splitter.addEventListener('keydown', (event) => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault(); resize(event.key === 'Home' ? 25 : event.key === 'End' ? 65 : split + (event.key === 'ArrowLeft' ? -2 : 2));
});
window.addEventListener('resize', () => { if (innerWidth > 700) resize(split); });

export { showView };
