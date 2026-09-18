import { createAutocomplete } from './autocomplete.js';
import { createHandset } from './handset.js';

/**
 * The page.
 *
 * Two panels over `/admin` and `/api`: **Phone**, which is one number's handset, calls and
 * conversations at once, and **Admin** — accounts, API keys and numbers — which is the
 * only configuration there is. There
 * is no framework and no build step, so rendering is `textContent` and `append` — never
 * `innerHTML` with anything that came from the server. What arrives here includes TwiML
 * from another process and message bodies somebody was actually sent; this page has no
 * business parsing either.
 *
 * **`state.sim` is what the Phone panel means by "here".** The call list, the keypad and
 * the conversations are all that one number's, which is why nothing below it asks again
 * which number you meant.
 *
 * Polling is deliberate and coarse: two seconds, and only for the panel on screen. The
 * interesting state is on the server, and a socket per panel would be more things to get
 * wrong for no benefit a developer can see.
 */

const SIM_KEY = 'localio.sim';

const state = {
  accounts: [],
  keys: [],
  numbers: [],
  panel: 'phone',
  /** One of our numbers: whose handset this is. `''` until a number exists. */
  sim: readStoredSim(),
  /** The far end of the conversation on screen, or `null` for the list of them. */
  smsPeer: null,
  editing: null,
  /**
   * What the user has opened, kept out of the DOM on purpose.
   *
   * Every panel here is redrawn from scratch every two seconds, so anything a click opened
   * has to be a fact the next render can read back — otherwise the poll closes it. Both are
   * keyed by sid, so a row that leaves the listing simply stops matching; there is nothing
   * to clean up.
   */
  openEvents: new Set(),
  /** sid -> the secret behind a `reveal` left on. Emptied only by `hide`. */
  revealed: new Map(),
  /**
   * The calls waiting to be picked up, sid -> the `/api/calls` view of each.
   *
   * Written by two things on purpose: the stream, frame by frame, and the two-second poll,
   * wholesale. The poll is the one that is right — a stream that dropped a frame or never
   * connected heals on its next tick — and the stream is only there to make the common
   * case immediate.
   */
  pending: new Map(),
};

function readStoredSim() {
  try {
    return localStorage.getItem(SIM_KEY) ?? '';
  } catch {
    // Private mode, or storage turned off. Not worth failing the page over.
    return '';
  }
}

let handset = null;

/**
 * Who this tab is when it claims a call, for the length of one page load.
 *
 * Not a credential and not a sid — it only has to be different from the other tabs'. A
 * reload deliberately gets a new one: the old claim is nobody's now, and its TTL on the
 * server is what clears it.
 */
const holder = crypto.randomUUID();

/* ------------------------------------------------------------------- fetch */

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server's own sentence, which is written to be read next to the box that
    // caused it. A status code alone would send somebody to the network tab.
    throw new Error(payload.message ?? payload.error ?? `${response.status}`);
  }
  return payload;
}

function showError(id, error) {
  const box = document.getElementById(id);
  if (!error) {
    box.hidden = true;
    return;
  }
  box.textContent = error.message ?? String(error);
  box.hidden = false;
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * `AC… / name`, because a sid on its own does not say which account it is.
 *
 * Read out of `state.accounts`, which the admin refresh loads before the keys and the
 * numbers, so the name is always the one the accounts table above is showing.
 */
const accountLabel = (sid) => {
  const name = state.accounts.find((account) => account.account_sid === sid)?.friendly_name;
  return name ? `${sid} / ${name}` : sid;
};

const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleTimeString() : '—');

/* -------------------------------------------------------------------- tabs */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.panel = tab.dataset.panel;
    showError('dial-error', null);
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('on', other === tab);
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('on', panel.id === `panel-${state.panel}`);
    }
    void refresh();
  });
}

/* ---------------------------------------------------------------- accounts */

/**
 * The accounts table, ordered as a **tree**: each top-level account followed by its own
 * subaccounts.
 *
 * `/admin/accounts` answers one flat list in creation order, which would scatter a child
 * away from its parent as soon as a second parent existed. The grouping is done here
 * rather than server-side because the flat list is also what every picker on this panel
 * wants.
 */
const accountTree = (accounts) => {
  const tops = accounts.filter((account) => !account.parent_account_sid);
  const rows = tops.flatMap((top) => [
    top,
    ...accounts.filter((account) => account.parent_account_sid === top.account_sid),
  ]);
  // An orphan cannot happen through the API — the parent delete guard is what prevents
  // it — but a row that fell out of the grouping would simply vanish from the panel, so
  // anything unplaced is appended rather than dropped.
  const placed = new Set(rows.map((account) => account.account_sid));
  return [...rows, ...accounts.filter((account) => !placed.has(account.account_sid))];
};

const STATUS_PILL = { active: 'pill good', suspended: 'pill', closed: 'pill bad' };

async function loadAccounts() {
  const { accounts } = await api('/admin/accounts');
  state.accounts = accounts;
  const body = document.querySelector('#accounts tbody');
  body.textContent = '';
  if (accounts.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.append(el('p', 'empty', 'No accounts yet. Create one to get a sid and a token.'));
    return;
  }
  for (const account of accountTree(accounts)) {
    const child = Boolean(account.parent_account_sid);
    const row = body.insertRow();

    const sidCell = row.insertCell();
    // Indented and marked, so a child reads as belonging to the row above it.
    if (child) sidCell.className = 'sub';
    sidCell.append(el('span', 'sid', child ? `↳ ${account.account_sid}` : account.account_sid));

    row.insertCell().textContent = account.friendly_name || '—';
    row.insertCell().append(el('span', STATUS_PILL[account.status] ?? 'pill', account.status));
    row.insertCell().textContent = String(account.number_count);
    row.insertCell().textContent = String(account.key_count);

    const tokenCell = row.insertCell();
    revealCell(
      tokenCell,
      account.account_sid,
      async () => (await api(`/admin/accounts/${account.account_sid}?reveal=1`)).auth_token,
    );

    const actions = row.insertCell();
    // Only a subaccount's status is worth flipping from here: suspending the top-level
    // account would shut the REST API out of itself, and the REST route refuses it too.
    if (child) {
      const next = account.status === 'active' ? 'suspended' : 'active';
      const toggle = el('button', 'link', next === 'active' ? 'activate' : 'suspend');
      toggle.addEventListener('click', async () => {
        try {
          showError('account-error', null);
          await api(`/admin/accounts/${account.account_sid}`, {
            method: 'PATCH',
            body: { status: next },
          });
          await loadAccounts();
        } catch (error) {
          showError('account-error', error);
        }
      });
      actions.append(toggle);
    }

    const remove = el('button', 'link', 'delete');
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete ${account.account_sid}?`)) return;
      try {
        showError('account-error', null);
        await api(`/admin/accounts/${account.account_sid}`, { method: 'DELETE' });
        await loadAccounts();
        // Deleting an account takes its keys with it, so the keys table is stale here.
        await loadKeys();
        await loadNumbers();
      } catch (error) {
        showError('account-error', error);
      }
    });
    actions.append(remove);
  }
  fillAccountSelect();
}

/**
 * Both account pickers on this panel: the one on the number form and the one on the key
 * form. They are the same component as the handset's number picker — every list that
 * comes out of the server is picked the same way, searchable, and only the `POST`/`GET`
 * method boxes stay native, because those are two fixed words.
 */
const numberAccount = createAutocomplete({ input: document.getElementById('n-account') });
const keyAccount = createAutocomplete({ input: document.getElementById('k-account') });
/**
 * The third picker: the parent on the account form.
 *
 * Unlike the other two it is **optional and never defaulted** — blank is what makes a
 * top-level account, which is the common case — and it lists only top-level accounts,
 * because a subaccount cannot hold subaccounts.
 */
const accountParent = createAutocomplete({ input: document.getElementById('account-parent') });

const accountOption = (account) => ({
  value: account.account_sid,
  label: account.friendly_name || 'unnamed',
  hint: account.account_sid,
});

function fillAccountSelect() {
  // Name first, sid as the hint: the name is what an account is picked *by*, and the sid
  // is 34 characters that would fill the box on its own. `matches` searches both, so a
  // pasted sid still finds its account.
  const options = state.accounts.map(accountOption);
  for (const picker of [numberAccount, keyAccount]) {
    // `setOptions` keeps the current pick and leaves a focused box alone, which is what
    // makes this safe to call from the two-second poll.
    picker.setOptions(options);
    const held = state.accounts.some((account) => account.account_sid === picker.value);
    // Defaulted to the only account there is, which is the common case and saves a click
    // on every number added. An account deleted out from under the box falls back the
    // same way rather than leaving a sid that is gone.
    if (!held) picker.setValue(state.accounts[0]?.account_sid ?? '', { quiet: true });
  }
  // Subaccounts hold their own numbers and keys, so they stay in the two pickers above and
  // are kept out of this one only.
  accountParent.setOptions(state.accounts.filter((account) => !account.parent_account_sid).map(accountOption));
  const parentHeld = state.accounts.some(
    (account) => account.account_sid === accountParent.value && !account.parent_account_sid,
  );
  if (!parentHeld && accountParent.value) accountParent.setValue('', { quiet: true });
}

/* ---------------------------------------------------------------- api keys */

/**
 * The keys table.
 *
 * The secret is not in the listing, so the cell holds a `reveal` that fetches it. A key
 * just created shows its secret without the click, because it was in that one answer — it
 * goes into `state.revealed` like any other, so both last until they are put back.
 */
async function loadKeys() {
  const { keys } = await api('/admin/keys');
  state.keys = keys;
  const body = document.querySelector('#keys tbody');
  body.textContent = '';
  if (keys.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.append(el('p', 'empty', 'No API keys. An account works without one; create a key to test a client built with SK credentials.'));
    return;
  }
  for (const key of keys) {
    const row = body.insertRow();
    row.insertCell().append(el('span', 'sid', key.sid));
    row.insertCell().append(el('span', 'sid', accountLabel(key.account_sid)));
    row.insertCell().textContent = key.friendly_name || '—';

    const secretCell = row.insertCell();
    revealCell(secretCell, key.sid, async () => (await api(`/admin/keys/${key.sid}?reveal=1`)).secret);

    const actions = row.insertCell();
    const remove = el('button', 'link', 'delete');
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete ${key.sid}?`)) return;
      try {
        showError('key-error', null);
        await api(`/admin/keys/${key.sid}`, { method: 'DELETE' });
        await loadKeys();
        await loadAccounts();
      } catch (error) {
        showError('key-error', error);
      }
    });
    actions.append(remove);
  }
}

document.getElementById('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('k-name');
  // The picker is a text box now, so `required` guards the label, not a sid — this is
  // what catches "no accounts yet", the same way the number form does below.
  if (!keyAccount.value) {
    showError('key-error', new Error('create an account first — a key belongs to one'));
    return;
  }
  try {
    showError('key-error', null);
    const created = await api('/admin/keys', {
      method: 'POST',
      body: { account_sid: keyAccount.value, friendly_name: name.value },
    });
    name.value = '';
    // The listing has no secrets in it, so the one answer that did is kept, and the row
    // draws it for as long as it is there.
    state.revealed.set(created.sid, created.secret);
    await loadKeys();
    await loadAccounts();
  } catch (error) {
    showError('key-error', error);
  }
});

/**
 * A secret that is fetched only when asked for, and then stays until it is put back.
 *
 * The listing never carries one, so no secret sits in the two-second poll of this panel —
 * that is the bargain the auth token and the key secret both make. What it does *not* mean
 * any more is that the redraw closes what the user opened: `state.revealed` is what the
 * cell is drawn from, so a reveal ends when `hide` is clicked and not before.
 */
function revealCell(cell, sid, fetchSecret) {
  cell.textContent = '';
  if (state.revealed.has(sid)) {
    const hide = el('button', 'link on', 'hide');
    hide.addEventListener('click', () => {
      state.revealed.delete(sid);
      revealCell(cell, sid, fetchSecret);
    });
    cell.append(el('span', 'sid', state.revealed.get(sid)), hide);
    return;
  }
  const reveal = el('button', 'link', 'reveal');
  reveal.addEventListener('click', async () => {
    state.revealed.set(sid, await fetchSecret());
    revealCell(cell, sid, fetchSecret);
  });
  cell.append(reveal);
}

document.getElementById('account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('account-name');
  try {
    showError('account-error', null);
    await api('/admin/accounts', {
      method: 'POST',
      body: {
        friendly_name: input.value,
        // Absent rather than empty: a blank box means a top-level account, and the
        // schema takes an `AC…` or nothing at all.
        ...(accountParent.value ? { parent_account_sid: accountParent.value } : {}),
      },
    });
    input.value = '';
    accountParent.setValue('', { quiet: true });
    await loadAccounts();
  } catch (error) {
    showError('account-error', error);
  }
});

/* ----------------------------------------------------------------- numbers */

async function loadNumbers() {
  const { numbers } = await api('/admin/numbers');
  state.numbers = numbers;
  renderNumbers();
  fillNumberSelects();
}

function renderNumbers() {
  const host = document.getElementById('numbers');
  // A form being typed into is not something a poll gets to redraw: rebuilding it from the
  // server row would wipe whatever was half-entered. The node is moved, not recreated.
  const openEditor = state.editing === null ? null : host.querySelector('.card.on');
  host.textContent = '';
  if (state.numbers.length === 0) {
    host.append(el('p', 'empty', 'No numbers yet. Add one above; until then every call answers no_such_number.'));
    return;
  }
  for (const number of state.numbers) {
    host.append(
      state.editing === number.sid ? (openEditor ?? numberEditor(number)) : numberCard(number),
    );
  }
}

function numberCard(number) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('span', 'card-title', number.phone_number));
  head.append(el('span', 'card-meta', `${number.friendly_name || 'unnamed'} · ${number.sid}`));
  card.append(head);

  const body = el('dl', 'card-body');
  for (const [label, value] of [
    ['voice', number.voice_url ? `${number.voice_method} ${number.voice_url}` : null],
    ['status', number.status_callback_url],
    ['sms', number.sms_url ? `${number.sms_method} ${number.sms_url}` : null],
    ['sms status', number.sms_status_callback_url],
    ['account', accountLabel(number.account_sid)],
  ]) {
    body.append(el('dt', '', label), el('dd', '', value ?? '— not set'));
  }
  card.append(body);

  const actions = el('div', 'card-actions');
  const edit = el('button', 'link', 'edit');
  edit.addEventListener('click', () => {
    state.editing = number.sid;
    renderNumbers();
  });
  const remove = el('button', 'link', 'release');
  remove.addEventListener('click', async () => {
    const full = await api(`/admin/numbers/${number.sid}`);
    // Names what will be left behind. Releasing a number is a change to what this
    // simulator answers for from now on, and is not a reason to lose its history — so
    // the confirm says the history stays rather than leaving that to be guessed.
    const message =
      `Release ${number.phone_number}?\n\n` +
      `${full.usage.calls} call(s) and ${full.usage.messages} message(s) reference it. ` +
      `They are kept.`;
    if (!confirm(message)) return;
    try {
      showError('number-error', null);
      await api(`/admin/numbers/${number.sid}`, { method: 'DELETE' });
      await loadNumbers();
      await loadAccounts();
    } catch (error) {
      showError('number-error', error);
    }
  });
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

/**
 * Editing in place.
 *
 * The webhook URLs are the fields that actually change day to day, which is why this
 * exists rather than a delete-and-recreate. It sends a `PATCH` of only these fields; a
 * blank box is `null`, which the store reads as "clear it" — distinct from a field not
 * mentioned at all.
 */
function numberEditor(number) {
  const card = el('div', 'card on');
  const head = el('div', 'card-head');
  head.append(el('span', 'card-title', number.phone_number));
  card.append(head);

  const form = el('form', 'stack');
  const inputs = {};
  const field = (key, label, value, type = 'url') => {
    const wrap = el('label', '', label);
    const input = el('input');
    input.type = type;
    input.value = value ?? '';
    inputs[key] = input;
    wrap.append(input);
    return wrap;
  };
  const picker = (key, value) => {
    const wrap = el('label', 'narrow', 'method');
    const select = el('select');
    for (const option of ['POST', 'GET']) select.append(el('option', '', option));
    select.value = value;
    inputs[key] = select;
    wrap.append(select);
    return wrap;
  };

  const rowOne = el('div', 'fields');
  rowOne.append(field('friendly_name', 'name', number.friendly_name, 'text'));
  form.append(rowOne);

  const rowTwo = el('div', 'fields');
  rowTwo.append(field('voice_url', 'voice url', number.voice_url), picker('voice_method', number.voice_method));
  rowTwo.append(field('status_callback_url', 'status callback', number.status_callback_url));
  form.append(rowTwo);

  const rowThree = el('div', 'fields');
  rowThree.append(field('sms_url', 'sms url', number.sms_url), picker('sms_method', number.sms_method));
  rowThree.append(field('sms_status_callback_url', 'sms status callback', number.sms_status_callback_url));
  form.append(rowThree);

  const actions = el('div', 'actions');
  const save = el('button', '', 'Save');
  save.type = 'submit';
  const cancel = el('button', '', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    state.editing = null;
    renderNumbers();
  });
  actions.append(save, cancel);
  form.append(actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {};
    for (const [key, input] of Object.entries(inputs)) {
      // `""` for a URL means "clear it"; the server turns it into `null`. A name is
      // left as a string, because a number with a blank name is not a number with none.
      patch[key] = input.value;
    }
    try {
      showError('number-error', null);
      await api(`/admin/numbers/${number.sid}`, { method: 'PATCH', body: patch });
      state.editing = null;
      await loadNumbers();
    } catch (error) {
      showError('number-error', error);
    }
  });

  card.append(form);
  return card;
}

document.getElementById('number-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    phone_number: document.getElementById('n-number').value.trim(),
    account_sid: numberAccount.value,
    friendly_name: document.getElementById('n-name').value,
    voice_url: document.getElementById('n-voice').value,
    voice_method: document.getElementById('n-voice-method').value,
    status_callback_url: document.getElementById('n-status').value,
    sms_url: document.getElementById('n-sms').value,
    sms_method: document.getElementById('n-sms-method').value,
    sms_status_callback_url: document.getElementById('n-sms-status').value,
  };
  if (!body.account_sid) {
    showError('number-error', new Error('create an account first — a number has to be held by one'));
    return;
  }
  try {
    showError('number-error', null);
    await api('/admin/numbers', { method: 'POST', body });
    for (const id of ['n-number', 'n-name', 'n-voice', 'n-status', 'n-sms', 'n-sms-status']) {
      document.getElementById(id).value = '';
    }
    await loadNumbers();
    await loadAccounts();
  } catch (error) {
    showError('number-error', error);
  }
});

/* --------------------------------------------------------------- the sim */

/**
 * The handset's identity. Everything on the Phone page is this number's, so it is the
 * one control the whole panel reads, and it is remembered across reloads — reaching for
 * the same number after every restart is the friction this page exists to remove.
 */
const sim = createAutocomplete({
  input: document.getElementById('sim'),
  onChange: (value) => void setSim(value),
});

/**
 * Move the handset to a number.
 *
 * One path, because there are two ways in: somebody picking from the box, and picking up
 * a call that came in on a number the box was not set to. The second is why this exists
 * at all — the pending strip is panel-wide, so answering has to bring the rest of the
 * panel to the call rather than leave it describing a different number.
 */
async function setSim(value) {
  if (state.sim === value) return;
  state.sim = value;
  // A conversation belongs to the number it was held with; keeping it open across a
  // change of handset would show a thread this number was never part of.
  state.smsPeer = null;
  try {
    localStorage.setItem(SIM_KEY, value);
  } catch {
    // Private mode, or storage turned off. The picker still works, it just forgets.
  }
  // `quiet`: the box is already showing this when the change came from the box itself.
  if (sim.value !== value) sim.setValue(value, { quiet: true });
  renderSim();
  await refresh();
}

/** Any number at all — this is who is calling *in*, so it is deliberately not our list. */
const peer = createAutocomplete({
  input: document.getElementById('p-peer'),
  freeSolo: true,
  placeholder: '+15559999999',
});

/** Fed from the numbers panel, so a number added there is dialable without a reload. */
function fillNumberSelects() {
  sim.setOptions(
    state.numbers.map((number) => ({
      value: number.phone_number,
      label: number.phone_number,
      hint: number.friendly_name || '',
    })),
  );
  // What was remembered may have been deleted since, and on the very first run there is
  // nothing remembered at all — either way, fall back to the first number rather than
  // leaving the page pointed at nothing.
  const known = state.numbers.some((number) => number.phone_number === state.sim);
  const wanted = known ? state.sim : (state.numbers[0]?.phone_number ?? '');
  state.sim = wanted;
  // `quiet`: this is the page catching the box up, not somebody picking a number, so it
  // must not re-enter `onChange` and clear the conversation they are reading.
  if (sim.value !== wanted) sim.setValue(wanted, { quiet: true });
  renderSim();
}

function renderSim() {
  const hint = document.getElementById('sim-hint');
  const known = state.numbers.find((number) => number.phone_number === state.sim);
  if (state.numbers.length === 0) {
    hint.textContent = 'no numbers yet — add one in the Admin tab';
  } else if (!known) {
    hint.textContent = 'pick one of your numbers';
  } else if (!known.voice_url) {
    // Worth saying here rather than as a failed call: this is the whole reason a dial
    // comes back `no_voice_url`.
    hint.textContent = 'no voice URL — calls to it will fail';
  } else {
    hint.textContent = known.voice_url;
  }
  document.getElementById('call-button').disabled = handset.live || !known;
}

/* -------------------------------------------------------------- the keypad */

/**
 * One keypad, two meanings.
 *
 * With a call up the digits are tones on the wire; with no call they compose the number
 * being dialled. `handset.js` deliberately does not decide this — it cannot see the number
 * box — so the page routes each press and the handset only sends what it is given.
 */
document.getElementById('h-keypad').addEventListener('click', (event) => {
  const digit = event.target.dataset?.digit;
  if (!digit) return;
  if (handset.live) handset.dtmf(digit);
  else peer.setValue(peer.value + digit);
});

document.getElementById('p-clear').addEventListener('click', () => {
  peer.setValue(peer.value.slice(0, -1));
});

document.getElementById('call-button').addEventListener('click', async () => {
  const other = peer.value.trim();
  if (!state.sim) {
    showError('dial-error', new Error('pick one of your numbers above first'));
    return;
  }
  if (!other) {
    showError('dial-error', new Error('type the number that is calling in'));
    return;
  }
  showError('dial-error', null);
  // The handset only ever dials **in**: this is somebody ringing the number the picker is
  // set to. An outbound call is placed through `POST …/Calls.json` and answered below.
  await handset.dial({ type: 'dial', from: other, to: state.sim });
});

document.getElementById('hangup-button').addEventListener('click', () => handset.hangup());

/* ------------------------------------------------------------- ringing now */

/**
 * Every call waiting to be picked up, on one line each, above the picker.
 *
 * **Deliberately not filtered by `state.sim`.** A call your application placed went out on
 * whichever of your numbers it named, and requiring the picker to already be on that
 * number means the thing you are waiting for is invisible until you guess where it is.
 * Picking one up sets the picker instead, which is what puts the columns below back in
 * step with the call that is now live.
 */
async function loadIncoming() {
  const { calls } = await api('/api/calls?status=queued');
  // Wholesale, not merged: this is the authoritative listing, so anything the stream added
  // that is not in it was already gone, and anything it missed appears here.
  state.pending = new Map(calls.map((call) => [call.sid, call]));
  renderIncoming();
}

/**
 * Draw the strip from `state.pending`.
 *
 * The one renderer, so the poll and the stream cannot fight over the DOM — they both write
 * the map and then call this.
 */
function renderIncoming() {
  const calls = [...state.pending.values()];
  const host = document.getElementById('incoming');
  host.textContent = '';
  host.hidden = calls.length === 0;
  for (const call of calls) {
    // Which way this one goes decides what to call it. A call *to* one of our numbers is
    // somebody ringing in; a queued `outbound-api` call is one the application placed
    // through `Calls.json`, so picking it up means playing the person being called.
    const inbound = call.direction !== 'outbound-api';
    // Somebody else is mid-pickup. Advisory only — the server would refuse us anyway, but
    // a button that is already grey is the difference between losing the race now and
    // losing it after the microphone prompt.
    const taken = call.claimed_by !== null && call.claimed_by !== holder;

    const row = el('div', 'pending-row');
    row.title = call.sid;
    row.append(el('span', 'pending-number', call.from));
    row.append(el('span', 'pending-arrow', '\u2192'));
    row.append(el('span', 'pending-number', call.to));
    row.append(
      el(
        'span',
        'pending-what',
        taken ? 'being picked up' : inbound ? 'ringing' : 'your app is calling',
      ),
    );

    const actions = el('div', 'pending-actions');
    const answer = el('button', 'call', 'Pick up');
    answer.disabled = taken;
    answer.addEventListener('click', () => void pickUp(call));
    const decline = el('button', 'danger', 'Decline');
    decline.disabled = taken;
    decline.addEventListener('click', async () => {
      // No webhook is posted at all — a call nobody picked up never rang.
      await api(`/api/calls/${call.sid}`, { method: 'DELETE' }).catch(() => {});
      await loadIncoming();
    });
    actions.append(answer, decline);
    row.append(actions);
    host.append(row);
  }
}

/**
 * Take a waiting call.
 *
 * The claim goes first and costs nothing, so the other tabs grey out on their next poll
 * rather than on the far side of a microphone prompt. **It is not what makes this happen
 * once** — the conditional UPDATE behind the `dial` frame is, and it stays the authority;
 * losing the claim here only saves the losing tab the walk.
 */
async function pickUp(call) {
  showError('pending-error', null);
  try {
    await api(`/api/calls/${call.sid}/claim`, { method: 'POST', body: { holder } });
  } catch (error) {
    // Its own line, next to the button that caused it: `#dial-error` belongs to the
    // keypad, which is now a column away from this strip.
    showError('pending-error', error);
    await loadIncoming();
    return;
  }
  // Our number is the one the call is *on*: `From` for a call the application placed,
  // `To` for somebody ringing in.
  await setSim(call.direction === 'outbound-api' ? call.from : call.to);
  try {
    // The sid decides the whole call: both numbers, the direction and the answer URL
    // come off the row, and it is adopted rather than re-minted.
    await handset.dial({
      type: 'dial',
      from: call.from,
      to: call.to,
      call_sid: call.sid,
      holder,
    });
  } catch (error) {
    // Nothing was taken, so hand the claim straight back rather than making the next tab
    // wait out its TTL.
    await api(`/api/calls/${call.sid}/claim?holder=${encodeURIComponent(holder)}`, {
      method: 'DELETE',
    }).catch(() => {});
    showError('pending-error', error);
  }
  await loadIncoming();
}

/* ----------------------------------------------------------- call history */

/**
 * One player for the whole page.
 *
 * Recordings are long enough that two playing at once is never what was meant, and a
 * single element makes "start this one" and "stop that one" the same action instead of a
 * set of players to keep in step.
 */
const player = new Audio();
let playingSid = null;

for (const event of ['ended', 'pause', 'play']) {
  player.addEventListener(event, () => {
    if (event === 'ended') playingSid = null;
    renderPlayButtons();
  });
}

function toggleRecording(recording) {
  if (playingSid === recording.sid && !player.paused) {
    player.pause();
    renderPlayButtons();
    return;
  }
  if (playingSid !== recording.sid) {
    playingSid = recording.sid;
    // The same URL the application under test was handed, so what plays here and what its
    // `action` callback pointed at cannot be two different files.
    player.src = recording.url;
  }
  void player.play().catch(() => {
    playingSid = null;
    renderPlayButtons();
  });
}

function renderPlayButtons() {
  for (const button of document.querySelectorAll('button.play')) {
    const on = button.dataset.sid === playingSid && !player.paused;
    button.textContent = on ? '⏸' : '▶';
    button.classList.toggle('on', on);
  }
}

async function loadHistory() {
  const [{ calls }, { recordings }] = await Promise.all([
    api(`/api/calls?limit=40${numberQuery()}`),
    // One request for the whole page rather than a detail fetch per row: the history is
    // redrawn every two seconds and forty of those would be forty round trips a tick.
    api('/api/recordings?limit=100'),
  ]);
  const byCall = new Map();
  for (const recording of recordings) {
    if (!byCall.has(recording.call_sid)) byCall.set(recording.call_sid, []);
    byCall.get(recording.call_sid).push(recording);
  }

  const host = document.getElementById('call-history');
  host.textContent = '';
  if (calls.length === 0) {
    host.append(el('p', 'empty', state.sim ? 'No calls on this number yet.' : 'No calls yet.'));
    return;
  }
  for (const call of calls) {
    host.append(callCard(call, byCall.get(call.sid) ?? []));
  }
  renderPlayButtons();
}

function callCard(call, recordings) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  // Which way round it went, from this handset's point of view.
  const inbound = call.to === state.sim;
  const title = el('span', 'card-title');
  title.append(el('span', 'arrow', inbound ? '↙' : '↗'), document.createTextNode(` ${inbound ? call.from : call.to}`));
  head.append(title);
  head.append(el('span', 'card-meta', when(call.created_at)));
  card.append(head);

  const line = el('div', 'call-line');
  line.append(el('span', `pill ${pillFor(call)}`, call.live ? 'live' : call.status));
  line.append(el('span', 'card-meta', call.duration_sec === null ? '—' : `${call.duration_sec}s`));

  for (const recording of recordings) {
    const play = el('button', 'play', '▶');
    play.dataset.sid = recording.sid;
    play.title = `${recording.sid} · ${recording.duration_sec}s`;
    play.addEventListener('click', () => toggleRecording(recording));
    line.append(play);
  }

  const events = el('button', 'link', 'events');
  events.classList.toggle('on', state.openEvents.has(call.sid));
  events.addEventListener('click', () => {
    if (state.openEvents.has(call.sid)) state.openEvents.delete(call.sid);
    else state.openEvents.add(call.sid);
    events.classList.toggle('on', state.openEvents.has(call.sid));
    void renderEvents(card, call.sid);
  });
  line.append(events);
  card.append(line);
  // The card is rebuilt by every poll, so the log has to be put back here rather than only
  // by the click — `state.openEvents` is what says whether it was open.
  void renderEvents(card, call.sid);
  return card;
}

/**
 * The event log under a call card, drawn from `state.openEvents`.
 *
 * Re-fetched rather than kept, which costs one request per *open* card per tick — usually
 * none — and is what keeps an open log following a live call instead of freezing at the
 * moment it was opened.
 */
async function renderEvents(card, sid) {
  card.querySelector('.log')?.remove();
  if (!state.openEvents.has(sid)) return;
  // A poll that failed is not worth losing the card over; the next tick tries again.
  const detail = await api(`/api/calls/${sid}`).catch(() => null);
  if (!detail || !state.openEvents.has(sid)) return;
  const log = el('div', 'log');
  for (const event of detail.events) {
    const row = el('div', `log-line ${event.kind === 'error' ? 'error' : ''}`);
    row.append(el('span', 'log-when', when(event.at)));
    row.append(el('span', 'log-kind', event.kind));
    row.append(el('span', 'log-text', JSON.stringify(event.detail, null, 1)));
    log.append(row);
  }
  if (detail.events.length === 0) log.append(el('p', 'empty', 'nothing logged'));
  card.append(log);
}

function pillFor(call) {
  if (call.live) return 'live';
  if (call.status === 'completed') return 'good';
  if (['failed', 'busy', 'no-answer', 'canceled'].includes(call.status)) return 'bad';
  return '';
}

/* ---------------------------------------------------------------- messages */

/** The other end of a conversation: the side of the pair that is not this handset. */
function peerOf(thread) {
  return thread.a === state.sim ? thread.b : thread.a;
}

async function loadMessages() {
  document.getElementById('sms-list').hidden = state.smsPeer !== null;
  document.getElementById('sms-detail').hidden = state.smsPeer === null;
  if (state.smsPeer === null) await loadThreadList();
  else await loadThread();
}

async function loadThreadList() {
  const { threads } = await api(`/api/threads${numberQuery('?')}`);
  const host = document.getElementById('sms-list');
  host.textContent = '';
  if (threads.length === 0) {
    host.append(el('p', 'empty', 'No messages yet.'));
    return;
  }
  for (const thread of threads) {
    const row = el('button', 'sms-row');
    row.type = 'button';
    const head = el('div', 'card-head');
    head.append(el('span', 'card-title', peerOf(thread)));
    head.append(el('span', 'card-meta', when(thread.last_at)));
    row.append(head);
    // One line of the newest message, whichever way it went. `textContent`, like every
    // other body on this page.
    const preview = el('div', 'sms-preview');
    preview.append(el('span', 'sms-dir', thread.last_from === state.sim ? 'you:' : ''));
    preview.append(document.createTextNode(` ${thread.last_body}`));
    row.append(preview);
    row.addEventListener('click', () => {
      state.smsPeer = peerOf(thread);
      void loadMessages();
    });
    host.append(row);
  }
}

document.getElementById('sms-back').addEventListener('click', () => {
  state.smsPeer = null;
  showError('sms-error', null);
  void loadMessages();
});

async function loadThread() {
  document.getElementById('sms-peer').textContent = state.smsPeer;
  const ours = new Set(state.numbers.map((number) => number.phone_number));
  const { messages } = await api(
    `/api/messages?a=${encodeURIComponent(state.sim)}&b=${encodeURIComponent(state.smsPeer)}`,
  );
  const host = document.getElementById('thread');
  // Redrawn on every poll; only jump to the end when we were already there, or reading
  // back through a long thread would be yanked to the bottom every two seconds.
  const pinned = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  host.textContent = '';
  if (messages.length === 0) host.append(el('p', 'empty', 'Nothing said yet.'));
  for (const message of messages) {
    const bubble = el('div', `bubble ${ours.has(message.from) ? 'out' : ''}`);
    bubble.append(el('span', 'who', `${message.status} · ${when(message.created_at)}`));
    // `textContent`: a message body is what somebody was actually told, arriving through
    // another process. This page does not parse it.
    bubble.append(el('div', 'body', message.body));
    host.append(bubble);
  }
  if (pinned) host.scrollTop = host.scrollHeight;
}

document.getElementById('sms-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const bodyInput = document.getElementById('s-body');
  try {
    showError('sms-error', null);
    // Still the inbound half: this page is the person outside texting one of your numbers.
    const result = await api('/api/messages', {
      method: 'POST',
      body: { from: state.smsPeer, to: state.sim, body: bodyInput.value },
    });
    bodyInput.value = '';
    if (result.note) showError('sms-error', new Error(result.note));
    await loadThread();
  } catch (error) {
    showError('sms-error', error);
  }
});

/* ------------------------------------------------------------------ boot */

/** `''` means no number is picked; asking the server for it would match nothing. */
function numberQuery(lead = '&') {
  return state.sim ? `${lead}number=${encodeURIComponent(state.sim)}` : '';
}

async function refresh() {
  try {
    if (state.panel === 'admin') {
      await loadAccounts();
      await loadKeys();
      await loadNumbers();
    } else {
      await Promise.all([loadHistory(), loadIncoming(), loadMessages()]);
    }
  } catch (error) {
    // A poll that failed is not worth a dialog. The panel keeps what it had and the
    // next tick tries again; a server that is genuinely gone shows as stale data, which
    // is the honest state.
    console.warn('refresh failed', error);
  }
}

/**
 * The push half of the strip.
 *
 * `GET /api/calls/stream` sends a `snapshot` on connect and then one frame per change, so
 * a call your application just placed, and a call another tab is mid-pickup on, both land
 * now rather than up to two seconds later. That second one is the point: the claim exists
 * to tell the losing tab *before* it spends a microphone prompt, and a poll gave most of
 * that window back.
 *
 * **Advisory, and never the only path.** `loadIncoming()` stays in the two-second refresh
 * and stays authoritative — a frame missed, a stream that never connected, a browser with
 * no `EventSource` at all, and the strip is still correct within a tick. `EventSource`
 * reconnects on its own and every attempt re-sends the snapshot, so there is no retry
 * logic here to get wrong.
 */
function subscribeIncoming() {
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource('/api/calls/stream');

  const on = (name, apply) =>
    source.addEventListener(name, (message) => {
      let payload;
      try {
        payload = JSON.parse(message.data);
      } catch {
        // A frame we cannot read is not worth the strip: the poll will put it right.
        return;
      }
      apply(payload);
      renderIncoming();
    });

  on('snapshot', ({ calls }) => {
    state.pending = new Map(calls.map((call) => [call.sid, call]));
  });
  // A new call waiting, and a claim taken or handed back. The frame carries the whole
  // `/api/calls` view, so `claimed_by` is already on it and nothing has to be fetched.
  for (const kind of ['ringing', 'claimed', 'released']) {
    on(kind, ({ call }) => state.pending.set(call.sid, call));
  }
  // Taken or declined: either way it is no longer waiting for anybody.
  for (const kind of ['taken', 'declined']) {
    on(kind, ({ call }) => state.pending.delete(call.sid));
  }

  // Nothing to do — the browser is already reconnecting, and the poll is covering the gap.
  source.addEventListener('error', () => {});
}

handset = createHandset({
  onLive: () => {
    document.getElementById('call-button').disabled = true;
    document.getElementById('hangup-button').disabled = false;
  },
  onIdle: () => {
    document.getElementById('hangup-button').disabled = true;
    renderSim();
    void loadIncoming();
  },
});

void (async () => {
  const settings = await api('/api/settings').catch(() => null);
  if (settings) document.getElementById('base-url').textContent = settings.public_url;
  await loadAccounts();
  await loadKeys();
  await loadNumbers();
  await refresh();
  // Coarse and only for the panel on screen. See the header. It stays even with the stream
  // open: it is what heals a strip the stream got wrong, and the only thing the other
  // panels have.
  setInterval(() => void refresh(), 2000);
  subscribeIncoming();
})();
