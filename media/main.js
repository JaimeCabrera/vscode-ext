(function () {
  const vscode = acquireVsCodeApi();

  // State that survives webview reloads (the webview is destroyed/recreated by VS Code).
  const saved = vscode.getState() || {};
  const st = {
    // We track UNCHECKED paths so new files default to checked (PyCharm behavior).
    unchecked: new Set(saved.unchecked || []),
    collapsed: new Set(saved.collapsed || []),
    message: saved.message || '',
    amend: !!saved.amend,
  };

  let changes = [];
  let hasRepo = true;
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const tree = $('tree');
  const msg = $('msg');
  const amend = $('amend');
  const btnCommit = $('commit');
  const btnPush = $('commitPush');
  const summary = $('summary');

  function save() {
    vscode.setState({
      unchecked: [...st.unchecked],
      collapsed: [...st.collapsed],
      message: st.message,
      amend: st.amend,
    });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- tree model ----------------------------------------------------------

  function buildTree() {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const c of changes) {
      const parts = c.path.split('/');
      const file = parts.pop();
      let node = root;
      for (const part of parts) {
        let next = node.dirs.get(part);
        if (!next) {
          next = { name: part, path: node.path ? node.path + '/' + part : part, dirs: new Map(), files: [] };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.push({ name: file, change: c });
    }
    return root;
  }

  function collect(node, out = []) {
    for (const f of node.files) out.push(f.change.path);
    for (const d of node.dirs.values()) collect(d, out);
    return out;
  }

  function collectDirs(node, out = []) {
    for (const d of node.dirs.values()) {
      out.push(d.path);
      collectDirs(d, out);
    }
    return out;
  }

  const isChecked = (p) => !st.unchecked.has(p);
  const selected = () => changes.filter((c) => isChecked(c.path));

  function setChecked(paths, checked) {
    for (const p of paths) {
      if (checked) st.unchecked.delete(p);
      else st.unchecked.add(p);
    }
    save();
    render();
  }

  // ---- rendering -----------------------------------------------------------

  function checkbox(state, onChange) {
    const i = el('input');
    i.type = 'checkbox';
    i.checked = state === 'all';
    i.indeterminate = state === 'some';
    i.addEventListener('click', (e) => e.stopPropagation());
    i.addEventListener('change', () => onChange(i.checked));
    return i;
  }

  function renderDir(node, depth, parent) {
    const paths = collect(node);
    const n = paths.filter(isChecked).length;
    const state = n === 0 ? 'none' : n === paths.length ? 'all' : 'some';
    const collapsed = st.collapsed.has(node.path);

    const row = el('div', 'row dir');
    row.style.paddingLeft = depth * 14 + 4 + 'px';
    row.append(
      el('span', 'chev', collapsed ? '▸' : '▾'),
      checkbox(state, (v) => setChecked(paths, v)),
      el('span', 'name', node.name),
      el('span', 'count', String(paths.length)),
    );
    row.addEventListener('click', () => {
      if (collapsed) st.collapsed.delete(node.path);
      else st.collapsed.add(node.path);
      save();
      render();
    });
    parent.append(row);
    if (!collapsed) renderChildren(node, depth + 1, parent);
  }

  function renderFile(file, depth, parent) {
    const c = file.change;
    const cls = c.status === '!' ? 'conflict' : c.status;
    const row = el('div', 'row file s-' + cls);
    row.style.paddingLeft = depth * 14 + 4 + 16 + 'px';
    row.title = c.path;
    row.append(
      checkbox(isChecked(c.path) ? 'all' : 'none', (v) => setChecked([c.path], v)),
      el('span', 'name', file.name),
      el('span', 'badge', c.status === '!' ? 'C!' : c.status),
    );
    row.addEventListener('click', () => vscode.postMessage({ type: 'open', path: c.path }));
    parent.append(row);
  }

  function renderChildren(node, depth, parent) {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) renderDir(d, depth, parent);
    for (const f of files) renderFile(f, depth, parent);
  }

  function render() {
    const top = tree.scrollTop;
    tree.textContent = '';
    if (!hasRepo) {
      tree.append(el('div', 'empty', 'No git repository found in the workspace.'));
    } else if (changes.length === 0) {
      tree.append(el('div', 'empty', 'No changes.'));
    } else {
      renderChildren(buildTree(), 0, tree);
    }
    tree.scrollTop = top;
    updateFooter();
  }

  function updateFooter() {
    const sel = selected().length;
    summary.textContent = changes.length ? sel + ' of ' + changes.length + ' files' : '';
    const ok = !busy && msg.value.trim().length > 0 && (sel > 0 || amend.checked);
    btnCommit.disabled = !ok;
    btnPush.disabled = !ok;
  }

  // ---- actions -------------------------------------------------------------

  function commit(push) {
    if (btnCommit.disabled) return;
    busy = true;
    updateFooter();
    vscode.postMessage({
      type: 'commit',
      message: msg.value,
      amend: amend.checked,
      push,
      paths: selected().map((c) => c.path),
    });
  }

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('selectAll').addEventListener('click', () => setChecked(changes.map((c) => c.path), true));
  $('selectNone').addEventListener('click', () => setChecked(changes.map((c) => c.path), false));
  $('expandAll').addEventListener('click', () => {
    st.collapsed.clear();
    save();
    render();
  });
  $('collapseAll').addEventListener('click', () => {
    for (const d of collectDirs(buildTree())) st.collapsed.add(d);
    save();
    render();
  });

  btnCommit.addEventListener('click', () => commit(false));
  btnPush.addEventListener('click', () => commit(true));

  msg.addEventListener('input', () => {
    st.message = msg.value;
    save();
    updateFooter();
  });
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit(false);
    }
  });

  amend.addEventListener('change', () => {
    st.amend = amend.checked;
    save();
    // Like PyCharm: amending prefills the previous message if the box is empty.
    if (amend.checked && !msg.value.trim()) vscode.postMessage({ type: 'lastMessage' });
    updateFooter();
  });

  // ---- messages from the extension host ------------------------------------

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'changes': {
        changes = m.changes;
        hasRepo = m.hasRepo;
        // Drop stale entries so the set doesn't grow forever.
        const current = new Set(changes.map((c) => c.path));
        for (const p of [...st.unchecked]) if (!current.has(p)) st.unchecked.delete(p);
        save();
        render();
        break;
      }
      case 'lastMessage':
        if (!msg.value.trim()) {
          msg.value = m.message;
          st.message = m.message;
          save();
          updateFooter();
        }
        break;
      case 'committed':
        busy = false;
        msg.value = '';
        amend.checked = false;
        st.message = '';
        st.amend = false;
        save();
        updateFooter();
        break;
      case 'failed':
        busy = false;
        updateFooter();
        break;
    }
  });

  msg.value = st.message;
  amend.checked = st.amend;
  render();
  vscode.postMessage({ type: 'ready' });
})();
