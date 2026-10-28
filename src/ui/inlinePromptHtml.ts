// The page that is shown inside the editor (an "editor inset").
// It is plain HTML, CSS and JavaScript. It talks to the extension with postMessage.
//
// Messages from the page:   ready, submit {text, mode}, draft {text}, escape, stop, accept, reject
// Messages to the page:     state {...WidgetState}
//
// The script must not contain backtick characters, because it lives in a template string.

const STYLE = String.raw`
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  body {
    box-sizing: border-box;
    padding: 4px 8px;
    display: flex; flex-direction: column; gap: 3px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family);
    font-size: 12px;
    border-top: 1px solid var(--vscode-focusBorder);
    border-bottom: 1px solid var(--vscode-focusBorder);
  }
  .row { display: flex; align-items: center; gap: 6px; min-height: 22px; }
  #mode {
    padding: 1px 6px; border-radius: 3px; font-size: 11px; white-space: nowrap;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  #input {
    flex: 1; min-width: 0; box-sizing: border-box; height: 22px; padding: 0 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; outline: none;
  }
  #input:focus { border-color: var(--vscode-focusBorder); }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  #input[readonly] { opacity: 0.7; }
  #model { opacity: 0.7; font-size: 11px; white-space: nowrap; }
  #status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
  button {
    border: 1px solid transparent; border-radius: 3px; padding: 1px 8px; height: 20px; cursor: pointer;
    font-family: inherit; font-size: 11px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { filter: brightness(1.1); }
  .hidden { display: none !important; }
  #answer {
    flex: 1; min-height: 0; overflow: auto; padding: 4px 6px; border-radius: 3px; line-height: 1.45;
    background: var(--vscode-textBlockQuote-background, transparent);
    user-select: text;
  }
  #answer pre {
    margin: 4px 0; padding: 4px 6px; overflow: auto; border-radius: 3px;
    background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace);
  }
  #answer code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .spinner {
    display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px;
    border: 2px solid var(--vscode-focusBorder); border-right-color: transparent; border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

const BODY = String.raw`
  <div class="row">
    <span id="mode">Edit</span>
    <input id="input" type="text" spellcheck="false" autocomplete="off">
    <span id="model"></span>
  </div>
  <div id="answer" class="hidden"></div>
  <div class="row">
    <span id="status"></span>
    <button id="stop" class="hidden">Stop (Esc)</button>
    <button id="accept" class="primary hidden">Accept</button>
    <button id="reject" class="hidden">Reject</button>
  </div>
`;

const SCRIPT = String.raw`
  const api = acquireVsCodeApi();
  const input = document.getElementById('input');
  const modeEl = document.getElementById('mode');
  const modelEl = document.getElementById('model');
  const statusEl = document.getElementById('status');
  const answerEl = document.getElementById('answer');
  const stopBtn = document.getElementById('stop');
  const acceptBtn = document.getElementById('accept');
  const rejectBtn = document.getElementById('reject');
  let state = { phase: 'typing', canQuestion: true, isMac: true };

  const TICK = String.fromCharCode(96);
  const FENCE = TICK + TICK + TICK;
  const INLINE = new RegExp(TICK + '([^' + TICK + '\\n]+)' + TICK, 'g');

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // A very small Markdown: code blocks, inline code, bold and line breaks. Everything is escaped first.
  function renderMarkdown(text) {
    return text.split(FENCE).map(function (part, i) {
      if (i % 2 === 1) {
        return '<pre>' + escapeHtml(part.replace(/^[^\n]*\n/, '')) + '</pre>';
      }
      return escapeHtml(part)
        .replace(INLINE, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }).join('');
  }

  function hide(el, hidden) { el.classList.toggle('hidden', hidden); }

  function render() {
    const p = state.phase;
    const busy = p === 'generating' || p === 'answering';
    const mod = state.isMac ? 'Cmd' : 'Ctrl';
    modeEl.textContent = state.modeLabel || 'Edit';
    modelEl.textContent = state.model || '';
    input.placeholder = state.placeholder || '';
    input.readOnly = busy;

    hide(stopBtn, !busy);
    hide(acceptBtn, p !== 'review');
    hide(rejectBtn, p !== 'review');
    acceptBtn.textContent = 'Accept (' + mod + '+Enter)';
    rejectBtn.textContent = 'Reject (' + mod + '+Bksp)';

    const showAnswer = p === 'answering' || p === 'answered' || (p === 'error' && !!state.answer);
    hide(answerEl, !showAnswer);
    if (showAnswer) {
      const atBottom = answerEl.scrollHeight - answerEl.scrollTop - answerEl.clientHeight < 24;
      answerEl.innerHTML = renderMarkdown(state.answer || '');
      if (atBottom) { answerEl.scrollTop = answerEl.scrollHeight; }
    }

    statusEl.className = p === 'error' ? 'error' : '';
    statusEl.textContent = '';
    if (busy) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      statusEl.appendChild(spinner);
    }
    statusEl.appendChild(document.createTextNode(state.status || ''));
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || msg.type !== 'state') { return; }
    state = Object.assign({}, state, msg);
    if (typeof msg.inputValue === 'string') { input.value = msg.inputValue; }
    render();
    if (msg.focus) { input.focus(); input.select(); }
  });

  input.addEventListener('input', function () {
    api.postMessage({ type: 'draft', text: input.value });
  });

  input.addEventListener('keydown', function (e) {
    if (e.isComposing) { return; }
    const mod = e.metaKey || e.ctrlKey;
    const p = state.phase;
    if (e.key === 'Escape') {
      e.preventDefault();
      api.postMessage({ type: 'escape' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mod) {
        if (p === 'review') { api.postMessage({ type: 'accept' }); }
        return;
      }
      if (p === 'generating' || p === 'answering') { return; }
      const text = input.value.trim();
      if (!text) { return; }
      const question = e.altKey && state.canQuestion;
      api.postMessage({ type: 'submit', text: text, mode: question ? 'question' : 'edit' });
    } else if (e.key === 'Backspace' && mod && input.value === '' && p === 'review') {
      // With an empty input there is nothing to delete, so Cmd+Backspace means "reject".
      e.preventDefault();
      api.postMessage({ type: 'reject' });
    } else if (mod && !e.altKey && input.value === '' && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // An empty input has nothing to undo itself, so Undo and Redo go to the document.
      const redo = e.key === 'y' || e.shiftKey;
      e.preventDefault();
      api.postMessage({ type: redo ? 'redo' : 'undo' });
    }
  });

  stopBtn.addEventListener('click', function () { api.postMessage({ type: 'stop' }); });
  acceptBtn.addEventListener('click', function () { api.postMessage({ type: 'accept' }); });
  rejectBtn.addEventListener('click', function () { api.postMessage({ type: 'reject' }); });

  render();
  input.focus();
  api.postMessage({ type: 'ready' });
`;

export function inlinePromptHtml(nonce: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`,
    `<style>${STYLE}</style></head><body>`,
    BODY,
    `<script nonce="${nonce}">${SCRIPT}</script>`,
    "</body></html>",
  ].join("\n");
}
