import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

const run = promisify(execFile);

interface Change {
  path: string; // relative to repo root, always '/' separated by git
  origPath?: string; // set on renames/copies
  status: string; // M A D R C | U (untracked) | ! (conflict)
}

interface CommitRequest {
  message: string;
  amend: boolean;
  push: boolean;
  paths: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

function statusCode(x: string, y: string): string {
  if (x === '?' && y === '?') {
    return 'U';
  }
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return '!';
  }
  const code = y !== ' ' ? y : x;
  return 'MADRC'.includes(code) ? code : 'M';
}

/** Parses `git status --porcelain=v1 -z`. Renames carry an extra NUL-separated "from" path. */
function parseStatus(out: string): Change[] {
  const parts = out.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) {
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    let origPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origPath = parts[++i];
    }
    changes.push({ path: entry.slice(3), origPath, status: statusCode(x, y) });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

class CommitPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private root: string | undefined;
  private changes: Change[] = [];
  private busy = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh();
      }
    });
  }

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.root = undefined;
    this.changes = [];
    if (folder) {
      try {
        this.root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
        // --no-optional-locks: don't let `status` rewrite the index (would retrigger our own watcher).
        const out = await git(this.root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall']);
        this.changes = parseStatus(out);
      } catch {
        this.root = undefined;
      }
    }
    void this.view?.webview.postMessage({ type: 'changes', hasRepo: !!this.root, changes: this.changes });
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.refresh();
        break;
      case 'open':
        await this.open(String(m.path));
        break;
      case 'lastMessage':
        await this.sendLastMessage();
        break;
      case 'commit':
        await this.commit(m as unknown as CommitRequest & { type: string });
        break;
    }
  }

  private async open(rel: string): Promise<void> {
    const change = this.changes.find((c) => c.path === rel);
    if (!this.root || !change) {
      return;
    }
    const uri = vscode.Uri.file(path.join(this.root, rel));
    await vscode.commands.executeCommand(change.status === 'U' ? 'vscode.open' : 'git.openChange', uri);
  }

  private async sendLastMessage(): Promise<void> {
    if (!this.root) {
      return;
    }
    try {
      const message = (await git(this.root, ['log', '-1', '--pretty=%B'])).trim();
      void this.view?.webview.postMessage({ type: 'lastMessage', message });
    } catch {
      /* no commits yet: nothing to prefill */
    }
  }

  private async commit(req: CommitRequest): Promise<void> {
    const root = this.root;
    if (!root || this.busy) {
      return;
    }
    // Only accept paths git actually reported; expand renames to include their origin.
    const known = new Map(this.changes.map((c) => [c.path, c]));
    const paths = [
      ...new Set(
        req.paths
          .filter((p) => known.has(p))
          .flatMap((p) => {
            const o = known.get(p)!.origPath;
            return o ? [p, o] : [p];
          }),
      ),
    ];
    if (!req.message.trim() || (paths.length === 0 && !req.amend)) {
      void this.view?.webview.postMessage({ type: 'failed' });
      return;
    }

    this.busy = true;
    let ok = false;
    try {
      if (paths.length > 0) {
        // Stage so untracked/renamed/deleted files are known to git...
        await git(root, ['add', '-A', '--', ...paths]);
      }
      const args = ['commit', '-m', req.message];
      if (req.amend) {
        args.push('--amend');
      }
      // ...then commit ONLY these paths, ignoring anything else already staged.
      // `--amend --only` with no paths rewrites just the message.
      args.push('--only');
      if (paths.length > 0) {
        args.push('--', ...paths);
      }
      await git(root, args);
      ok = true;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      vscode.window.showErrorMessage(`Commit failed: ${(e.stderr || e.message).trim()}`);
    }

    if (ok && req.push) {
      await this.push(root, req.amend);
    }
    this.busy = false;
    void this.view?.webview.postMessage({ type: ok ? 'committed' : 'failed' });
    await this.refresh();
  }

  private async push(root: string, force: boolean): Promise<void> {
    const attempt = (args: string[]) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Pushing…' },
        () => git(root, args),
      );
    try {
      // After --amend a plain push is rejected if the commit was already published; we never force silently.
      await attempt(['push']);
      vscode.window.showInformationMessage('Committed and pushed.');
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const stderr = (e.stderr || e.message).trim();
      if (/no upstream branch/i.test(stderr)) {
        const pick = await vscode.window.showErrorMessage(
          'Committed, but the branch has no upstream.',
          'Push and set upstream',
        );
        if (pick) {
          try {
            await attempt(['push', '-u', 'origin', 'HEAD']);
            vscode.window.showInformationMessage('Committed and pushed.');
          } catch (err2) {
            const e2 = err2 as { stderr?: string; message: string };
            vscode.window.showErrorMessage(`Push failed: ${(e2.stderr || e2.message).trim()}`);
          }
        }
      } else {
        const hint = force ? ' (amended commits usually need a force push; do that manually)' : '';
        vscode.window.showErrorMessage(`Committed, but push failed${hint}: ${stderr}`);
      }
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <div class="toolbar">
    <button id="refresh" title="Refresh">↻</button>
    <button id="selectAll" title="Select all">☑</button>
    <button id="selectNone" title="Deselect all">☐</button>
    <button id="expandAll" title="Expand all">⊞</button>
    <button id="collapseAll" title="Collapse all">⊟</button>
    <span id="summary" class="summary"></span>
  </div>
  <div id="tree" class="tree"></div>
  <div class="footer">
    <label class="amend"><input type="checkbox" id="amend"> Amend previous commit</label>
    <textarea id="msg" rows="4" placeholder="Commit message (Ctrl/Cmd+Enter to commit)"></textarea>
    <div class="buttons">
      <button id="commit" class="primary">Commit</button>
      <button id="commitPush" class="secondary">Commit and Push</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const panel = new CommitPanel(context.extensionUri);

  // Debounced refresh so bursts of file events trigger a single `git status`.
  let timer: NodeJS.Timeout | undefined;
  const schedule = (uri?: vscode.Uri) => {
    // Ignore .git internals: our own git calls touch them and would loop.
    if (uri && /[\\/]\.git[\\/]/.test(uri.fsPath)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void panel.refresh(), 300);
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(schedule);
  watcher.onDidCreate(schedule);
  watcher.onDidDelete(schedule);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('selectiveCommit.panel', panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    watcher,
    { dispose: () => clearTimeout(timer) },
    vscode.window.onDidChangeWindowState((s) => s.focused && schedule()),
    vscode.commands.registerCommand('selectiveCommit.refresh', () => panel.refresh()),
  );
}

export function deactivate(): void {}
