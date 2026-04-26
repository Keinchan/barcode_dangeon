// localStorage ベースの簡易セーブシステム（ユーザー名のみログイン）

const KEY_USERS   = 'save:_users';
const KEY_CURRENT = 'save:_current';
const KEY_PREFIX  = 'save:user:';

export function listUsers() {
  try {
    const raw = localStorage.getItem(KEY_USERS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function _writeUsersList(users) {
  localStorage.setItem(KEY_USERS, JSON.stringify(users));
}

export function getCurrentUser() {
  return localStorage.getItem(KEY_CURRENT) || null;
}

export function setCurrentUser(name) {
  if (name) localStorage.setItem(KEY_CURRENT, name);
  else      localStorage.removeItem(KEY_CURRENT);
}

export function loadSave(username) {
  if (!username) return null;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + username);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveData(username, data) {
  if (!username) return;
  try {
    localStorage.setItem(KEY_PREFIX + username, JSON.stringify(data));
  } catch (e) {
    console.warn('save failed:', e);
    return;
  }
  const users = listUsers();
  if (!users.includes(username)) {
    users.push(username);
    _writeUsersList(users);
  }
}

export function deleteSave(username) {
  if (!username) return;
  localStorage.removeItem(KEY_PREFIX + username);
  _writeUsersList(listUsers().filter(u => u !== username));
  if (getCurrentUser() === username) setCurrentUser(null);
}

export function clearAllSaves() {
  for (const user of listUsers()) {
    localStorage.removeItem(KEY_PREFIX + user);
  }
  localStorage.removeItem(KEY_USERS);
  localStorage.removeItem(KEY_CURRENT);
}
