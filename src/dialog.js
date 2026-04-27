// ─────────────────────────────────────────────
// アプリ内モーダルダイアログ
//   - native window.confirm / window.alert の代替
//   - native ダイアログは iOS Safari の Web Audio を suspend させて BGM が止まる
//     ため、ゲーム内では一切使わない
//   - showAlert / showConfirm は Promise を返す
// ─────────────────────────────────────────────

let _resolve = null;
let _bound   = false;

function _bindOnce() {
  if (_bound) return;
  _bound = true;
  document.getElementById('dialog-ok').addEventListener('click', () => {
    _close();
    const r = _resolve; _resolve = null;
    if (r) r(true);
  });
  document.getElementById('dialog-cancel').addEventListener('click', () => {
    _close();
    const r = _resolve; _resolve = null;
    if (r) r(false);
  });
  document.getElementById('dialog-modal').addEventListener('click', (e) => {
    // 背景タップでキャンセル相当（confirm の時のみ）
    if (e.target.id !== 'dialog-modal') return;
    if (document.getElementById('dialog-cancel').classList.contains('hidden')) return;
    _close();
    const r = _resolve; _resolve = null;
    if (r) r(false);
  });
}

function _open(opts) {
  _bindOnce();
  const modal = document.getElementById('dialog-modal');
  if (!modal) return Promise.resolve(opts.confirm ? false : undefined);
  document.getElementById('dialog-title').textContent = opts.title ?? '';
  document.getElementById('dialog-body').textContent  = opts.body  ?? '';
  const cancel = document.getElementById('dialog-cancel');
  const ok     = document.getElementById('dialog-ok');
  if (opts.confirm) {
    cancel.classList.remove('hidden');
    cancel.textContent = opts.cancelLabel ?? 'キャンセル';
  } else {
    cancel.classList.add('hidden');
  }
  ok.textContent = opts.okLabel ?? 'OK';
  // 危険操作向けの強調色
  ok.classList.toggle('btn-danger', !!opts.danger);
  modal.classList.remove('hidden');
  return new Promise(res => { _resolve = res; });
}

function _close() {
  document.getElementById('dialog-modal')?.classList.add('hidden');
}

// 単純な通知。await すれば閉じるまで待てる
export function showAlert(message, opts = {}) {
  return _open({ ...opts, body: message, confirm: false });
}

// Yes/No 問い合わせ。Promise<boolean> を返す
export function showConfirm(message, opts = {}) {
  return _open({ ...opts, body: message, confirm: true });
}
