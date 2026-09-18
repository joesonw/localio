/**
 * A searchable picker over a short list, in the shape of MUI's Autocomplete.
 *
 * One text input with a filtered popup under it. No framework and no build step, like the
 * rest of `public/`, and **every option is rendered with `textContent`** — the labels here
 * are phone numbers and friendly names that came out of the database, which this page has
 * no business parsing.
 *
 * Two uses, and they differ in one way: the handset picker must resolve to a number this
 * server actually holds, while the field you dial *out* to is any number at all. That is
 * `freeSolo` — with it, whatever was typed stands even when nothing matched.
 */

let nextId = 0;

/**
 * @param {object} args
 * @param {HTMLInputElement} args.input  the text box; the menu is positioned against its parent
 * @param {Array<{value: string, label: string, hint?: string}>} [args.options]
 * @param {(value: string) => void} [args.onChange]  fired only when the value actually changes
 * @param {boolean} [args.freeSolo]  keep typed text that matches nothing
 * @param {string} [args.placeholder]
 */
export function createAutocomplete({
  input,
  options = [],
  onChange = () => {},
  freeSolo = false,
  placeholder = '',
}) {
  const id = `ac-${nextId++}`;
  let list = options;
  let value = '';
  let open = false;
  let active = -1;
  /**
   * Whether the text in the box is a query or a committed label.
   *
   * Opening the menu is not typing: a box showing what was picked would otherwise filter
   * the list down to that one row, so clicking a picker that already has a value would
   * hide every other option. The filter is tied to the user having typed, exactly as
   * MUI's Autocomplete resets it on open.
   */
  let filtering = false;
  /** What the box showed before it was focused, to put back when the edit is abandoned. */
  let committed = '';

  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  if (placeholder) input.placeholder = placeholder;

  const menu = document.createElement('div');
  menu.className = 'ac-menu';
  menu.id = `${id}-menu`;
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  input.setAttribute('aria-controls', menu.id);

  const wrap = document.createElement('div');
  wrap.className = 'ac';
  input.replaceWith(wrap);
  wrap.append(input, menu);

  const labelFor = (option) => (option.hint ? `${option.label} — ${option.hint}` : option.label);

  /** Case-insensitive, over both halves of the label: you may know either one. */
  function matches(query) {
    const needle = query.trim().toLowerCase();
    if (needle === '') return list;
    return list.filter(
      (option) =>
        option.value.toLowerCase().includes(needle) ||
        labelFor(option).toLowerCase().includes(needle),
    );
  }

  /** What the menu is showing right now — the one list every handler must agree on. */
  const visible = () => matches(filtering ? input.value : '');

  function render() {
    const shown = visible();
    menu.textContent = '';
    if (shown.length === 0) {
      const none = document.createElement('div');
      none.className = 'ac-empty';
      none.textContent = freeSolo ? 'no match — will use what you typed' : 'no match';
      menu.append(none);
      active = -1;
    }
    shown.forEach((option, index) => {
      const row = document.createElement('div');
      row.className = `ac-option${index === active ? ' on' : ''}`;
      row.id = `${id}-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.value === value));
      row.append(labelNode(option));
      // `mousedown`, not `click`: the input's own blur would close the menu first.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        commit(option);
      });
      menu.append(row);
    });
    input.setAttribute(
      'aria-activedescendant',
      active >= 0 && active < shown.length ? `${id}-option-${active}` : '',
    );
    return shown;
  }

  function labelNode(option) {
    const node = document.createElement('span');
    node.className = 'ac-label';
    node.textContent = option.label;
    if (option.hint) {
      const hint = document.createElement('span');
      hint.className = 'ac-hint';
      hint.textContent = option.hint;
      node.append(' ', hint);
    }
    return node;
  }

  function show() {
    open = true;
    filtering = false;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  }

  function close() {
    open = false;
    active = -1;
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-activedescendant', '');
  }

  function commit(option) {
    close();
    setValue(option.value);
  }

  /** Free-solo only: the typed text becomes the value as-is. */
  function commitTyped() {
    const typed = input.value.trim();
    const exact = list.find(
      (option) => option.value.toLowerCase() === typed.toLowerCase() || labelFor(option) === typed,
    );
    if (exact) {
      commit(exact);
      return;
    }
    if (freeSolo) {
      close();
      setValue(typed);
      return;
    }
    // Not free-solo and nothing matched: the box goes back to the last real value rather
    // than sitting there showing a number that was never selected.
    close();
    input.value = committed;
  }

  function setValue(next, { quiet = false } = {}) {
    const option = list.find((candidate) => candidate.value === next);
    const changed = next !== value;
    value = next;
    committed = option ? labelFor(option) : next;
    input.value = committed;
    if (changed && !quiet) onChange(value);
  }

  input.addEventListener('focus', () => {
    // Select-all, so typing replaces the current pick the way a real combobox does.
    input.select();
    show();
  });

  // A click on a box that already has focus reopens it — `focus` fires only the first
  // time, so without this the menu stays shut after an Escape or a blur-commit. No
  // `preventDefault`: the caret and the select-all above are the point of the click.
  input.addEventListener('mousedown', () => {
    if (!open) show();
  });

  input.addEventListener('input', () => {
    active = -1;
    if (!open) show();
    // After `show`, which clears it: from here the box holds a query, not a pick.
    filtering = true;
    render();
  });

  input.addEventListener('blur', () => {
    if (!open) return;
    commitTyped();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      const shown = visible();
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      render();
      menu.querySelector('.ac-option.on')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      const shown = visible();
      if (open && active >= 0 && shown[active]) {
        event.preventDefault();
        commit(shown[active]);
        return;
      }
      // Let a form submit through only once the box holds something usable.
      if (open) {
        event.preventDefault();
        commitTyped();
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      input.value = committed;
    }
  });

  return {
    /** Refreshing the list must not drop the current pick — the poller calls this. */
    setOptions(next) {
      list = next;
      const option = list.find((candidate) => candidate.value === value);
      if (option) {
        committed = labelFor(option);
        if (document.activeElement !== input) input.value = committed;
      }
      if (open) render();
    },
    get value() {
      return value;
    },
    setValue(next, options2) {
      setValue(next, options2);
    },
    focus() {
      input.focus();
    },
  };
}
