import { applyItem } from './items.js';
import { showFloatingDamage, showEnemyDamage } from './ui.js';
import { playSfx } from './audio.js';

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

    // ダンジョンヘッダーのプレイヤーHP（常時表示）
    const dungeonHp = document.getElementById('player-hp');
    if (dungeonHp) dungeonHp.textContent = `HP: ${this.player.hp}/${this.player.maxHp}`;

    // 戦闘パネルのプレイヤーHP表示
    const bpHp = document.getElementById('battle-player-hp');
    if (bpHp) bpHp.textContent = `HP ${this.player.hp}/${this.player.maxHp}`;

    const bpBar = document.getElementById('battle-player-hp-bar');
    if (bpBar) {
      const ppct = Math.max(0, this.player.hp / this.player.maxHp) * 100;
      bpBar.style.width      = ppct + '%';
      bpBar.style.background = ppct > 50 ? '#4caf50' : ppct > 25 ? '#ffc107' : '#f44336';
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
      skillBtn.innerHTML =
        `✨ ${skillName}<span class="btn-battle-sub">約${skillDmg}ダメージ（×2）</span>`;
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
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 1.0);
    const isCrit = dmg >= Math.max(2, Math.floor((this.player.atk - this.monster.def) * 1.4));
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`⚔️ こうげき！ ${dmg} ダメージ！`);
    showEnemyDamage(dmg);
    playSfx(isCrit ? 'crit' : 'hit');
    this.updateUI();
    this._checkEnemyDead() || this._enemyTurn();
  }

  skill() {
    if (this._busy) return;
    const dmg = this._calcDmg(this.player.atk, this.monster.def, 2.0);
    this.monster.hp = Math.max(0, this.monster.hp - dmg);
    this.log(`✨ スキル！ ${dmg} の大ダメージ！`);
    showEnemyDamage(dmg);
    playSfx('crit');
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
    setTimeout(() => this.onEnd('win', this.monster), 900);
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

  _tickOtherEnemies() {
    if (!this.dungeon) { this._busy = false; return; }
    const r = this.dungeon.tickEnemies(this.player, { excludeMob: this.mobRef });
    for (const ev of r.events) {
      if (ev.type === 'magic') {
        this.log(`✨ ${ev.mob.name} の魔法攻撃！ ${ev.dmg} ダメージ`);
      }
    }
    if (r.totalDmg > 0) {
      this.player.hp = Math.max(0, this.player.hp - r.totalDmg);
      showFloatingDamage(r.totalDmg);
      playSfx('damage');
    }
    if (this.onTick) { try { this.onTick(r); } catch {} }
    this.updateUI();
    if (this.player.hp <= 0) {
      this.log('💀 周囲の敵に倒された...');
      setTimeout(() => this.onEnd('lose'), 900);
      return;
    }
    this._busy = false;
  }

  // 壁越し戦闘では魔法ナラティブ、通常戦闘は物理ナラティブ。ダメージ計算は同一
  _enemyBasicAttack() {
    const dmg = this._calcDmg(this.monster.atk, this.player.def);
    this.player.hp = Math.max(0, this.player.hp - dmg);
    const label = this.wallPiercing ? '✨ 魔法攻撃' : '💥 攻撃';
    this.log(`${label} ${this.monster.name} の一撃！ ${dmg} ダメージ！`);
    showFloatingDamage(dmg);
    playSfx('damage');
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
      this.updateUI();
      // _busy=false は後段の _tickOtherEnemies に委譲（その間に操作させない）
    } else if (sk.poison) {
      // 毒スキル（闇属性）
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`☠️ ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ＋毒！`);
      showFloatingDamage(dmg);
      playSfx('damage');
      this.updateUI();
      this._checkPlayerDead();
    } else {
      // 攻撃スキル
      const dmg = this._calcDmg(this.monster.atk, this.player.def, sk.mult);
      this.player.hp = Math.max(0, this.player.hp - dmg);
      this.log(`🔥 ${this.monster.name} が「${sk.name}」を使った！ ${dmg} ダメージ！`);
      showFloatingDamage(dmg);
      playSfx('damage');
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
