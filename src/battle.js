import { applyItem, elementMatchup, matchupLabel } from './items.js';
import { SKILL_MP_COST } from './generator.js';
import { applyStatus, STATUS_DEFS } from './status.js';
import { rollInflictOnHit } from './monster-jobs.js';
import {
  showFloatingDamage, showEnemyDamage,
  sparkSpray, explosion, shockwave, magicCircle,
  playerVfxAnchor, enemyVfxAnchor,
  hitFlash, screenShake, deathBurst,
  attackTrail,
} from './ui.js';

// 戦闘パネル上の「自分」アンカーを取り出す（player → enemy のトレイル始点用）
function _battlePlayerAnchor() {
  const el = document.querySelector('.combat-player');
  return el ? el.getBoundingClientRect() : null;
}
import { playSfx } from './audio.js';

// 属性 → 16進カラー（VFX 色の統一に使用）。ui.js の magicCircle と同色テーブル
function _elementHexColor(element) {
  switch (element) {
    case '火': return '#ff6b3d';
    case '水': return '#4dc4ff';
    case '草': return '#66bb6a';
    case '雷': return '#ffd54f';
    case '光': return '#fff176';
    case '闇': return '#b070dd';
    default: return null;
  }
}
// 16進 → rgba(...) で alpha 指定（簡易）
function _alphaize(hex, a = 0.6) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0,2), 16);
  const g = parseInt(m[1].slice(2,4), 16);
  const b = parseInt(m[1].slice(4,6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export class Battle {
  constructor(player, monster, onEnd, opts = {}) {
    this.player       = { ...player };
    this.monster      = { ...monster };
    this.onEnd        = onEnd;
    this._log         = [];
    this._busy        = false;
    // 壁越し戦闘フラグ: true なら通常こうげき不可、敵も魔法のみ
    this.wallPiercing = !!opts.wallPiercing;
    // 戦闘中も周囲の他敵がティックして動く / 攻撃する
    this.dungeon      = opts.dungeon ?? null;
    this.mobRef       = opts.mobRef  ?? null;     // tick 対象から除外する戦闘中 mob
    this.onTick       = opts.onTick  ?? null;     // tick 後の追加描画コールバック
  }

  log(msg) {
    this._log.push(msg);
    const el = document.getElementById('battle-log');
    if (!el) return;
    el.innerHTML = this._log.slice(-5).map(l => `<p>${l}</p>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  updateUI() {
    const lvLabel = this.monster.level ? `Lv${this.monster.level} ` : '';
    document.getElementById('enemy-name').textContent    = `${lvLabel}${this.monster.name}`;
    document.getElementById('enemy-sprite').textContent  = this.monster.emoji;
    document.getElementById('enemy-element').textContent = `${this.monster.element}属性`;
    document.getElementById('enemy-element').style.color = '#fff';

    const pct = Math.max(0, this.monster.hp / this.monster.maxHp) * 100;
    const bar = document.getElementById('enemy-hp-bar');
    bar.style.width      = pct + '%';
    bar.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ffc107' : '#f44336';

    document.getElementById('enemy-stat-text').textContent =
      `HP ${this.monster.hp}/${this.monster.maxHp}  ATK ${this.monster.atk}  DEF ${this.monster.def}`;
    document.getElementById('enemy-rarity').textContent  = `[${this.monster.rarity}]`;
    document.getElementById('enemy-rarity').style.color  = this.monster.rarityColor;

    // ダンジョンヘッダーのプレイヤーHP / MP（常時表示）
    const dungeonHp = document.getElementById('player-hp');
    if (dungeonHp) dungeonHp.textContent = `HP: ${this.player.hp}/${this.player.maxHp}`;
    const dungeonMp = document.getElementById('player-mp');
    if (dungeonMp) dungeonMp.textContent = `MP: ${this.player.mp ?? 0}/${this.player.maxMp ?? 0}`;

    // 戦闘パネルのプレイヤーHP表示
    const bpHp = document.getElementById('battle-player-hp');
    if (bpHp) bpHp.textContent = `HP ${this.player.hp}/${this.player.maxHp}`;

    const bpBar = document.getElementById('battle-player-hp-bar');
    if (bpBar) {
      const ppct = Math.max(0, this.player.hp / this.player.maxHp) * 100;
      bpBar.style.width      = ppct + '%';
      bpBar.style.background = ppct > 50 ? '#4caf50' : ppct > 25 ? '#ffc107' : '#f44336';
    }

    // 戦闘パネルの MP 表示
    const bpMp = document.getElementById('battle-player-mp');
    if (bpMp) bpMp.textContent = `MP ${this.player.mp ?? 0}/${this.player.maxMp ?? 0}`;
    const bpMpBar = document.getElementById('battle-player-mp-bar');
    if (bpMpBar) {
      const max = this.player.maxMp ?? 1;
      const mppct = Math.max(0, (this.player.mp ?? 0) / max) * 100;
      bpMpBar.style.width      = mppct + '%';
      bpMpBar.style.background = '#4dc4ff';
    }

    // 行動ボタンに対敵での期待ダメージなどの内容を表示
    const baseDmg  = Math.max(1, this.player.atk - this.monster.def);
    const skillDmg = Math.floor(baseDmg * 2);

    // 通常攻撃: 壁越し戦闘では使用不可、通常戦闘では使用可
    const atkBtn = document.getElementById('btn-attack');
    if (atkBtn) {
      if (this.wallPiercing) {
        atkBtn.innerHTML = `⚔️ こうげき<span class="btn-battle-sub">使用不可（壁越しは魔法のみ）</span>`;
        atkBtn.disabled = true;
      } else {
        atkBtn.innerHTML = `⚔️ こうげき<span class="btn-battle-sub">約${baseDmg}ダメージ（ATK ${this.player.atk}）</span>`;
        atkBtn.disabled = false;
      }
    }

    const skillBtn = document.getElementById('btn-skill');
    const wSkill = this.player.weapon?.skill;
    if (skillBtn) {
      const skillName = (wSkill && wSkill.kind !== 'none') ? wSkill.name : (this.wallPiercing ? '魔法攻撃' : 'スキル');
      const lowMp = (this.player.mp ?? 0) < SKILL_MP_COST;
      skillBtn.innerHTML =
        `✨ ${skillName}<span class="btn-battle-sub">約${skillDmg}ダメージ（MP -${SKILL_MP_COST}）${lowMp ? '⚠️MP不足' : ''}</span>`;
      skillBtn.disabled = lowMp;
    }

    const itemBtn = document.getElementById('btn-item');
    if (itemBtn) {
      const usable = this.player.inventory?.filter(it => it.type === 'potion' || it.type === 'scroll').length ?? 0;
      itemBtn.innerHTML =
        `🎒 アイテム<span class="btn-battle-sub">使用可 ${usable}個</span>`;
    }

    const runBtn = document.getElementById('btn-run');
    if (runBtn) {
      runBtn.innerHTML = this.monster.isBoss
        ? `🏃 にげる<span class="btn-battle-sub">ボスからは逃げられない</span>`
        : `🏃 にげる<span class="btn-battle-sub">成功率55%</span>`;
    }
  }

  // ── プレイヤーアクション ──

  attack() {
    if (this._busy) return;
    if (this.wallPiercing) return;  // 壁越し戦闘では通常攻撃不可
    const matchup = elementMatchup(this.player.weapon?.element, this.monster.element);
    const dmg = this._calcDmg(this.player.atk, this.monster.def, matchup);
    const isCrit = dmg >= Math.max(2, Math.floor((this.player.atk - this.monster.def) * 1.4 * matchup));
    const isEffective = matchup >= 1.5;
    const isWeak      = matchup <= 0.7;
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    const matchLbl = matchupLabel(matchup);
    this.log(`⚔️ こうげき！ ${dmg} ダメージ！${matchLbl ? '　' + matchLbl : ''}`);
    const dmgKind = isCrit ? 'crit' : isEffective ? 'effective' : isWeak ? 'weak' : 'normal';
    showEnemyDamage(dmg, { kind: dmgKind });
    playSfx(isCrit ? 'crit' : 'hit');
    // VFX: クリティカルは爆発+全画面フラッシュ+シェイク、通常は火花。属性色を反映
    const enemyAt = enemyVfxAnchor();
    const elColor = _elementHexColor(this.player.weapon?.element);
    // 自分 → 敵 への攻撃方向ストリーク（誰が誰を狙ったか）
    const fromPlayer = _battlePlayerAnchor();
    if (fromPlayer && enemyAt) attackTrail(fromPlayer, enemyAt, { color: elColor ?? '#ffd54f' });
    if (isCrit) {
      hitFlash({ color: 'rgba(255,213,79,0.55)' });
      screenShake(10, 320);
      explosion(enemyAt, { color: elColor ?? '#ff7043' });
      sparkSpray(enemyAt, { count: 18, color: '#fff' });
    } else if (isEffective) {
      screenShake(5, 200);
      sparkSpray(enemyAt, { color: elColor ?? '#ffd54f', count: 14 });
      sparkSpray(enemyAt, { color: '#fff', count: 6 });
    } else {
      sparkSpray(enemyAt, { color: elColor ?? '#ffd54f', count: 10 });
    }
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  skill() {
    if (this._busy) return;
    if ((this.player.mp ?? 0) < SKILL_MP_COST) {
      this.log(`💧 MP が足りない（必要 ${SKILL_MP_COST}）`);
      return;
    }
    this.player.mp = Math.max(0, (this.player.mp ?? 0) - SKILL_MP_COST);
    const matchup = elementMatchup(this.player.weapon?.element, this.monster.element);
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 2.0 * matchup);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    const matchLbl = matchupLabel(matchup);
    const isEffective = matchup >= 1.5;
    this.log(`✨ スキル！ ${dmg} の大ダメージ！（MP -${SKILL_MP_COST}）${matchLbl ? '　' + matchLbl : ''}`);
    showEnemyDamage(dmg, { kind: isEffective ? 'crit' : 'effective' });
    playSfx('crit');
    // VFX: 武器属性の魔法陣 → 爆発（クリ相当）+ 全画面フラッシュ + シェイク
    const enemyAt = enemyVfxAnchor();
    const elem = this.player.weapon?.element ?? this.player.weapon?.skill?.element;
    const elColor = _elementHexColor(elem);
    hitFlash({ color: 'rgba(255,138,101,0.45)' });
    screenShake(8, 280);
    // 自分 → 敵 への大きめのストリーク（属性色）
    const fromPlayer = _battlePlayerAnchor();
    if (fromPlayer && enemyAt) attackTrail(fromPlayer, enemyAt, { color: elColor ?? '#ff8a65' });
    magicCircle(enemyAt, elem);
    setTimeout(() => explosion(enemyAt, { color: elColor ?? '#ff8a65' }), 320);
    setTimeout(() => sparkSpray(enemyAt, { color: '#fff', count: 14 }), 380);
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  useItem(item) {
    if (this._busy) return;
    const { msg, consumed, dmgAmt } = applyItem(item, this.player, this.monster);
    this.log(msg);
    if (dmgAmt > 0) showEnemyDamage(dmgAmt);
    this.updateUI();
    if (!consumed) return;

    if (this._checkEnemyDead()) return;
    this._enemyTurn();
  }

  run() {
    if (this._busy) return;
    if (this.monster.isBoss) {
      this.log('💢 ボスからは逃げられない！');
      this._enemyTurn();
      return;
    }
    if (Math.random() > 0.45) {
      this.log('💨 逃げ切った！');
      setTimeout(() => this.onEnd('run'), 400);
    } else {
      this.log('💨 逃げられなかった！');
      this._enemyTurn();
    }
  }

  // ── 内部 ──

  _calcDmg(atk, def, mult = 1) {
    const base = Math.max(1, atk - def);
    const roll = 1 + Math.floor(Math.random() * Math.ceil(base * 0.4));
    return Math.floor((base + roll) * mult);
  }

  _checkEnemyDead() {
    if (this.monster.hp > 0) return false;
    this.log(`✨ ${this.monster.name} を倒した！`);
    this._busy = true;
    // 撃破演出: 全画面フラッシュ + シェイク + 拡大リング + 大量火花
    const enemyAt = enemyVfxAnchor();
    hitFlash({ color: 'rgba(255,213,79,0.45)' });
    screenShake(this.monster.isBoss ? 14 : 8, this.monster.isBoss ? 480 : 320);
    deathBurst(enemyAt, { color: this.monster.rarityColor ?? '#ff7043' });
    // 1撃キル時も周囲の他敵に最後の1ティック（移動・魔法）を与えてから勝利演出。
    // initialDelay: プレイヤーの致命アタック VFX（火花・爆発）と他敵の魔法演出が
    // 同フレームで重なるのを避けるため、最初の魔法 1 件目までに 500ms 待機。
    this._tickOtherEnemies(() => {
      setTimeout(() => this.onEnd('win', this.monster), 600);
    }, { initialDelay: 500 });
    return true;
  }

  _enemyTurn() {
    this._busy = true;
    setTimeout(() => {
      // スキルチャージ蓄積。3ターンで属性スキル、それ以外は基本攻撃
      this.monster.skillCharge = (this.monster.skillCharge ?? 0) + 1;
      if (this.monster.skillCharge >= 3) {
        this.monster.skillCharge = 0;
        this._useEnemySkill();
      } else {
        this._enemyBasicAttack();
      }
      // 戦闘中 mob のターン後、周囲の他敵もティックして攻撃／接近する。
      // _checkPlayerDead が onEnd('lose') 済みなら hp <= 0 なのでスキップ。
      if (this.player.hp > 0) {
        setTimeout(() => this._tickOtherEnemies(), 380);
      }
    }, 550);
  }

  // onComplete: 省略すると通常の敵ターン終了として _busy=false に戻す。
  // 指定すると tick 完了後にそれを呼び出し、_busy は呼び出し側の責務にする
  // （勝利確定後の演出など、戦闘を閉じる前に1ティック挟みたい時に利用）
  // opts.initialDelay: 1 件目の魔法発動までに待つ ms（致命アタック VFX と被る
  // のを避けるため）。デフォルト 0
  _tickOtherEnemies(onComplete, opts = {}) {
    const finish = onComplete ?? (() => { this._busy = false; });
    const initialDelay = opts.initialDelay ?? 0;
    if (!this.dungeon) { finish(); return; }
    const r = this.dungeon.tickEnemies(this.player, { excludeMob: this.mobRef });
    if (this.onTick) { try { this.onTick(r); } catch {} }

    const magics = r.events.filter(e => e.type === 'magic');
    if (magics.length === 0) {
      finish();
      return;
    }

    // 各敵の魔法攻撃を順次（時間差で）処理し、1 件ずつフロート＋SFX＋ログを発火
    let i = 0;
    const STEP_MS = 320;
    const step = () => {
      if (this.player.hp <= 0) return;   // すでに死亡判定済み
      const ev = magics[i++];
      if (!ev) {
        this.updateUI();
        finish();
        return;
      }
      // 外し: ダメージ無し + ログだけ
      if (ev.hit === false) {
        this.log(`💨 ${ev.mob.name} の魔法攻撃が外れた！`);
        if (i < magics.length) setTimeout(step, STEP_MS);
        else { this.updateUI(); finish(); }
        return;
      }
      this.player.hp = Math.max(0, this.player.hp - ev.dmg);
      this.log(`✨ ${ev.mob.name} の魔法攻撃！ ${ev.dmg} ダメージ`);
      showFloatingDamage(ev.dmg);
      playSfx('damage');
      this.updateUI();
      if (this.player.hp <= 0) {
        this.log('💀 周囲の敵に倒された...');
        setTimeout(() => this.onEnd('lose'), 900);
        return;
      }
      if (i < magics.length) setTimeout(step, STEP_MS);
      else { this.updateUI(); finish(); }
    };
    if (initialDelay > 0) setTimeout(step, initialDelay);
    else step();
  }

  // 戦闘パネル中の状態異常付与: applyStatus + 専用ログ + 真のプレイヤーオブジェクトにも反映。
  // this.player は Battle がコンストラクタで shallow-copy しているため、外側の真の player に
  // 状態異常を載せるには onEnd 後に rollback が起きる前のタイミングで反映が必要。
  // ここでは this.player の statuses を更新し、onEnd で main.js が参照するようにする。
  _inflictOnPlayer(inflict) {
    if (!inflict || this.player.hp <= 0) return;
    const ok = applyStatus(this.player, inflict.kind, {
      turns:  inflict.turns,
      stacks: inflict.stacks,
    });
    if (!ok) return;
    const def = STATUS_DEFS[inflict.kind];
    if (def) this.log(`${def.emoji} ${def.label} 状態になった！`);
  }

  // 壁越し戦闘では魔法ナラティブ、通常戦闘は物理ナラティブ。ダメージ計算は同一
  _enemyBasicAttack() {
    const matchup = elementMatchup(this.monster.element, this.player.armor?.element);
    const dmg = this._calcDmg(this.monster.atk, this.player.def, matchup);
    const isEffective = matchup >= 1.5;
    const isWeak      = matchup <= 0.7;
    this.player.hp = Math.max(0, this.player.hp - dmg);
    const label = this.wallPiercing ? '✨ 魔法攻撃' : '💥 攻撃';
    const matchLbl = matchupLabel(matchup);
    this.log(`${label} ${this.monster.name} の一撃！ ${dmg} ダメージ！${matchLbl ? '　' + matchLbl : ''}`);
    // ジョブ / 属性ベースの状態異常付与（命中時のみ）
    this._inflictOnPlayer(rollInflictOnHit(this.monster, { ranged: this.wallPiercing }));
    const dmgKind = isEffective ? 'crit' : isWeak ? 'weak' : 'normal';
    showFloatingDamage(dmg, { kind: dmgKind });
    playSfx('damage');
    // VFX: 被ダメ衝撃波（属性色）+ 効果絶大ならフラッシュ + 軽いシェイク
    const playerAt = playerVfxAnchor();
    const elColor  = _elementHexColor(this.monster.element);
    // 敵 → 自分 への攻撃方向ストリーク
    const enemyAtkAt = enemyVfxAnchor();
    if (enemyAtkAt && playerAt) attackTrail(enemyAtkAt, playerAt, { color: elColor ?? '#ff5252' });
    shockwave(playerAt, { color: elColor ? _alphaize(elColor, 0.65) : 'rgba(255,82,82,0.65)' });
    if (this.wallPiercing) magicCircle(playerAt, this.monster.element);
    if (isEffective) {
      hitFlash({ color: 'rgba(255,82,82,0.4)' });
      screenShake(7, 240);
      sparkSpray(playerAt, { color: elColor ?? '#ff5252', count: 14 });
    } else {
      screenShake(3, 140);
      sparkSpray(playerAt, { color: elColor ?? '#ff5252', count: 8 });
    }
    this.updateUI();
    this._checkPlayerDead();
  }

  _useEnemySkill() {
    const sk = this.monster.skill;
    if (!sk) { this._enemyBasicAttack(); return; }

    if (sk.healSelf > 0) {
      // 自己回復スキル（光属性）
      const heal = Math.floor(this.monster.maxHp * sk.healSelf);
      this.monster.hp = Math.min(this.monster.maxHp, this.monster.hp + heal);
      this.log(`🌟 ${this.monster.name} が「${sk.name}」を使った！ HPが${heal}回復！`);
      magicCircle(enemyVfxAnchor(), '光');
      this.updateUI();
      // _busy=false は後段の _tickOtherEnemies に委譲（その間に操作させない）
    } else if (sk.poison) {
      // 毒スキル（闇属性）: ダメージ + 確実に毒状態を付与（5 ターン）
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`☠️ ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ＋毒！`);
      showFloatingDamage(dmg);
      playSfx('damage');
      magicCircle(enemyVfxAnchor(), '闇');
      shockwave(playerVfxAnchor(), { color: 'rgba(176,112,221,0.6)' });
      this._inflictOnPlayer({ kind: 'poison', turns: 5, stacks: 1 });
      this.updateUI();
      this._checkPlayerDead();
    } else {
      // 攻撃スキル
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`🔥 ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ！`);
      // スキル攻撃命中時もジョブ / 属性ベースで付与（チャンスは ranged 扱いで増幅）
      this._inflictOnPlayer(rollInflictOnHit(this.monster, { ranged: true }));
      showFloatingDamage(dmg);
      playSfx('damage');
      // 敵スキル: 敵側に魔法陣 → 攻撃方向ストリーク → プレイヤー側に爆発
      const skElColor = _elementHexColor(this.monster.element);
      magicCircle(enemyVfxAnchor(), this.monster.element);
      setTimeout(() => {
        const enAt = enemyVfxAnchor();
        const plAt = playerVfxAnchor();
        if (enAt && plAt) attackTrail(enAt, plAt, { color: skElColor ?? '#ff7043' });
      }, 180);
      setTimeout(() => explosion(playerVfxAnchor(), { color: skElColor ?? '#ff7043' }), 280);
      this.updateUI();
      this._checkPlayerDead();
    }
  }

  _checkPlayerDead() {
    if (this.player.hp > 0) return;   // _busy=false は _tickOtherEnemies に委譲
    this.log('💀 倒れてしまった...');
    setTimeout(() => this.onEnd('lose'), 900);
  }
}
